#!/usr/bin/env node

/**
 * Loyalty Square Orphan Audit — detects Square customer groups and pricing
 * rules with no matching loyalty_rewards DB record (orphans from failed cleanup).
 *
 * Usage:
 *   node tools/loyalty-square-orphan-audit.js                  # Dry-run all
 *   node tools/loyalty-square-orphan-audit.js --merchant-id=3  # Single merchant
 *   node tools/loyalty-square-orphan-audit.js --execute        # Cleanup orphans
 */

try { require('dotenv').config(); } catch { /* dotenv not available in test */ }

const db = require('../utils/database');
const logger = require('../utils/logger');
const { getMerchantToken, makeSquareRequest } = require('../services/square/api');
const { cleanupSquareCustomerGroupDiscount } = require('../services/loyalty-admin/square-discount-service');

const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../config/constants');

// CLI argument parsing
const args = process.argv.slice(2);
const EXECUTE_MODE = args.includes('--execute');
const MERCHANT_ID_ARG = args.find(a => a.startsWith('--merchant-id='));
const MERCHANT_ID_FILTER = MERCHANT_ID_ARG ? parseInt(MERCHANT_ID_ARG.split('=')[1], 10) : null;

/** Get merchants to audit — all active with loyalty, or single filtered. */
async function getMerchantsToAudit() {
    if (MERCHANT_ID_FILTER) {
        const result = await db.query(
            'SELECT id FROM merchants WHERE id = $1 AND is_active = TRUE',
            [MERCHANT_ID_FILTER]
        );
        return result.rows;
    }

    const result = await db.query(`
        SELECT DISTINCT m.id
        FROM merchants m
        INNER JOIN loyalty_offers lo ON lo.merchant_id = m.id
        WHERE m.is_active = TRUE
          AND lo.is_active = TRUE
        ORDER BY m.id
    `);
    return result.rows;
}

/** Fetch all customer groups from Square (paginated). */
async function fetchSquareCustomerGroups(merchantId) {
    const accessToken = await getMerchantToken(merchantId);
    const groups = [];
    let cursor = null;
    let iterations = 0;

    do {
        iterations++;
        if (iterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('[orphan-audit] Pagination limit for customer groups', { merchantId });
            break;
        }

        const endpoint = `/v2/customers/groups${cursor ? `?cursor=${cursor}` : ''}`;
        const data = await makeSquareRequest(endpoint, { accessToken });

        if (data.groups) {
            groups.push(...data.groups);
        }
        cursor = data.cursor || null;
    } while (cursor);

    return groups;
}

/** Fetch all pricing rules from Square catalog (paginated). */
async function fetchSquarePricingRules(merchantId) {
    const accessToken = await getMerchantToken(merchantId);
    const rules = [];
    let cursor = null;
    let iterations = 0;

    do {
        iterations++;
        if (iterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('[orphan-audit] Pagination limit for pricing rules', { merchantId });
            break;
        }

        const endpoint = `/v2/catalog/list?types=PRICING_RULE${cursor ? `&cursor=${cursor}` : ''}`;
        const data = await makeSquareRequest(endpoint, { accessToken });

        if (data.objects) {
            rules.push(...data.objects);
        }
        cursor = data.cursor || null;
    } while (cursor);

    return rules;
}

/** Get known Square group/pricing rule IDs from loyalty_rewards table. */
async function getKnownSquareIds(merchantId) {
    const result = await db.query(`
        SELECT square_group_id, square_pricing_rule_id
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND (square_group_id IS NOT NULL OR square_pricing_rule_id IS NOT NULL)
    `, [merchantId]);

    const groupIds = new Set();
    const pricingRuleIds = new Set();

    for (const row of result.rows) {
        if (row.square_group_id) groupIds.add(row.square_group_id);
        if (row.square_pricing_rule_id) pricingRuleIds.add(row.square_pricing_rule_id);
    }

    return { groupIds, pricingRuleIds };
}

/** Find reward record by its Square group ID (for execute-mode cleanup). */
async function findRewardByGroupId(merchantId, squareGroupId) {
    const result = await db.query(`
        SELECT r.id, r.square_customer_id, r.status, o.offer_name
        FROM loyalty_rewards r
        LEFT JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1 AND r.square_group_id = $2
    `, [merchantId, squareGroupId]);
    return result.rows[0] || null;
}

/** Audit a single merchant for orphaned Square objects. */
async function auditMerchant(merchantId) {
    const orphanedGroups = [];
    const orphanedRules = [];
    let cleanedUp = 0;
    const errors = [];

    try {
        // Fetch Square objects and known DB references in parallel
        const [squareGroups, squarePricingRules, knownIds] = await Promise.all([
            fetchSquareCustomerGroups(merchantId),
            fetchSquarePricingRules(merchantId),
            getKnownSquareIds(merchantId)
        ]);

        // Filter to loyalty-related groups only (our naming convention)
        const loyaltyGroups = squareGroups.filter(
            g => g.name && g.name.startsWith('Loyalty Reward ')
        );

        // Find orphaned groups — loyalty groups in Square with no DB match
        for (const group of loyaltyGroups) {
            if (!knownIds.groupIds.has(group.id)) {
                orphanedGroups.push({
                    merchant_id: merchantId,
                    square_group_id: group.id,
                    group_name: group.name,
                    reason: 'No matching loyalty_rewards record'
                });
            }
        }

        // Find orphaned pricing rules — rules in Square with no DB match
        // Only flag rules that look like they belong to our loyalty system
        for (const rule of squarePricingRules) {
            const ruleName = rule.pricingRuleData?.name || rule.id;
            const isLoyaltyRule = ruleName.includes('loyalty') || ruleName.includes('Loyalty');

            if (isLoyaltyRule && !knownIds.pricingRuleIds.has(rule.id)) {
                orphanedRules.push({
                    merchant_id: merchantId,
                    square_pricing_rule_id: rule.id,
                    rule_name: ruleName,
                    reason: 'No matching loyalty_rewards record'
                });
            }
        }

        // Execute mode: clean up orphaned groups that have a reward record
        // with matching Square IDs we can use for cleanup
        if (EXECUTE_MODE) {
            for (const orphan of orphanedGroups) {
                try {
                    // Try to find a reward record that references this group
                    const reward = await findRewardByGroupId(merchantId, orphan.square_group_id);
                    if (reward) {
                        const result = await cleanupSquareCustomerGroupDiscount({
                            merchantId,
                            squareCustomerId: reward.square_customer_id,
                            internalRewardId: reward.id
                        });
                        if (result.success) {
                            cleanedUp++;
                            console.log(`  [CLEANED] Group ${orphan.square_group_id} (${orphan.group_name})`);
                        } else {
                            errors.push({ id: orphan.square_group_id, error: result.error });
                        }
                    } else {
                        // No reward record found — group is truly orphaned with no DB reference
                        // cleanupSquareCustomerGroupDiscount requires a reward ID, so skip
                        console.log(`  [SKIP] Group ${orphan.square_group_id} — no reward record to reference for cleanup`);
                    }
                } catch (err) {
                    errors.push({ id: orphan.square_group_id, error: err.message });
                }
            }
        }
    } catch (err) {
        errors.push({ error: err.message });
        logger.error('[orphan-audit] Merchant audit failed', { merchantId, error: err.message });
    }

    return { merchantId, orphanedGroups, orphanedRules, cleanedUp, errors };
}

/** Main audit runner. */
async function runAudit() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Loyalty Square Orphan Audit`);
    console.log(`  Mode: ${EXECUTE_MODE ? 'EXECUTE (will clean up)' : 'DRY-RUN (report only)'}`);
    if (MERCHANT_ID_FILTER) console.log(`  Merchant filter: ${MERCHANT_ID_FILTER}`);
    console.log(`${'='.repeat(60)}\n`);

    const merchants = await getMerchantsToAudit();

    if (merchants.length === 0) {
        console.log('No merchants found to audit.');
        await db.pool.end();
        return;
    }

    console.log(`Auditing ${merchants.length} merchant(s)...\n`);

    let totalOrphanedGroups = 0;
    let totalOrphanedRules = 0;
    let totalCleanedUp = 0;

    for (const merchant of merchants) {
        const result = await auditMerchant(merchant.id);

        totalOrphanedGroups += result.orphanedGroups.length;
        totalOrphanedRules += result.orphanedRules.length;
        totalCleanedUp += result.cleanedUp;

        if (result.orphanedGroups.length > 0 || result.orphanedRules.length > 0) {
            console.log(`--- Merchant ${result.merchantId} ---`);
            for (const g of result.orphanedGroups) {
                console.log(`  [ORPHAN GROUP]  ${g.square_group_id}  ${g.group_name}`);
            }
            for (const r of result.orphanedRules) {
                console.log(`  [ORPHAN RULE]   ${r.square_pricing_rule_id}  ${r.rule_name}`);
            }
            for (const e of result.errors) {
                console.log(`  [ERROR] ${e.id || 'general'}: ${e.error}`);
            }
            console.log('');
        }
    }

    // Summary
    console.log(`${'='.repeat(60)}`);
    console.log(`  Summary`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Merchants audited:       ${merchants.length}`);
    console.log(`  Orphaned groups found:   ${totalOrphanedGroups}`);
    console.log(`  Orphaned rules found:    ${totalOrphanedRules}`);
    if (EXECUTE_MODE) {
        console.log(`  Cleaned up:              ${totalCleanedUp}`);
    }
    console.log('');

    if (!EXECUTE_MODE && (totalOrphanedGroups > 0 || totalOrphanedRules > 0)) {
        console.log('  Run with --execute to clean up orphaned objects.');
    }

    await db.pool.end();
}

// Entry point — skip auto-run when loaded by tests
if (require.main === module) {
    runAudit().catch(err => {
        console.error('[orphan-audit] Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = {
    fetchSquareCustomerGroups,
    fetchSquarePricingRules,
    getKnownSquareIds,
    auditMerchant
};
