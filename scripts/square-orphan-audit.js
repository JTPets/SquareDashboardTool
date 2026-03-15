#!/usr/bin/env node

/**
 * Square Orphan Audit Tool (BACKLOG-67)
 *
 * Scans all Square customer groups matching the loyalty naming pattern,
 * cross-references against loyalty_rewards in DB, and flags orphaned
 * Square objects (groups, pricing rules, discounts) that have no matching
 * active reward.
 *
 * Usage:
 *   node scripts/square-orphan-audit.js [--dry-run|--execute] [--merchant-id=3]
 *
 * Default: --dry-run --merchant-id=3
 */

require('dotenv').config();

const db = require('../utils/database');
const logger = require('../utils/logger');
const { deleteCatalogObjects, deleteCustomerGroupWithMembers } = require('../utils/square-catalog-cleanup');

// Lazy-load to avoid circular dependency
let squareApi = null;
function getSquareApi() {
    if (!squareApi) {
        squareApi = require('../services/square/api');
    }
    return squareApi;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');

function getArgValue(prefix) {
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

const MERCHANT_ID = parseInt(getArgValue('--merchant-id=')) || 3;
const API_DELAY_MS = 200;

// Group naming pattern from square-customer-group-service.js:
// "Loyalty Reward {rewardId} - {offerName} - {customerName}"
const LOYALTY_GROUP_PATTERN = /^Loyalty Reward (\d+) - /;

function log(msg, data = {}) {
    const extra = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    console.log(`[orphan-audit] ${msg}${extra}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Square API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all customer groups from Square, paginating through results.
 */
async function fetchAllCustomerGroups(accessToken) {
    const api = getSquareApi();
    const groups = [];
    let cursor = null;

    do {
        const endpoint = cursor
            ? `/v2/customers/groups?cursor=${encodeURIComponent(cursor)}`
            : '/v2/customers/groups';

        const result = await api.makeSquareRequest(endpoint, {
            method: 'GET',
            accessToken
        });

        if (result.groups) {
            groups.push(...result.groups);
        }
        cursor = result.cursor || null;
        if (cursor) await sleep(API_DELAY_MS);
    } while (cursor);

    return groups;
}

/**
 * Fetch catalog objects (discounts, pricing rules) by searching for loyalty-related objects.
 * Uses the search endpoint to find PRICING_RULE objects that reference a customer group.
 */
async function fetchCatalogObjectById(accessToken, objectId) {
    if (!objectId) return null;
    const api = getSquareApi();
    try {
        const result = await api.makeSquareRequest(`/v2/catalog/object/${objectId}`, {
            method: 'GET',
            accessToken
        });
        return result.object || null;
    } catch (err) {
        if (err.message && err.message.includes('404')) return null;
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runAudit() {
    log(`Starting Square orphan audit`, { merchantId: MERCHANT_ID, mode: DRY_RUN ? 'DRY-RUN' : 'EXECUTE' });

    const api = getSquareApi();
    const accessToken = await api.getMerchantToken(MERCHANT_ID);

    // Step 1: Fetch all customer groups from Square
    log('Fetching all customer groups from Square...');
    const allGroups = await fetchAllCustomerGroups(accessToken);
    log(`Found ${allGroups.length} total customer groups`);

    // Step 2: Filter to loyalty reward groups
    const loyaltyGroups = allGroups.filter(g => LOYALTY_GROUP_PATTERN.test(g.name));
    log(`Found ${loyaltyGroups.length} loyalty reward groups`);

    if (loyaltyGroups.length === 0) {
        log('No loyalty groups found — nothing to audit');
        await db.pool.end();
        return;
    }

    // Step 3: For each loyalty group, extract reward ID and cross-reference DB
    const orphans = [];
    let scanned = 0;

    for (const group of loyaltyGroups) {
        scanned++;
        const match = LOYALTY_GROUP_PATTERN.exec(group.name);
        const rewardIdFromName = match ? parseInt(match[1]) : null;

        await sleep(API_DELAY_MS);

        // Look up reward in DB by square_group_id
        const rewardByGroup = await db.query(`
            SELECT r.id, r.status, r.square_customer_id, r.square_discount_id,
                   r.square_pricing_rule_id, r.square_product_set_id,
                   o.offer_name
            FROM loyalty_rewards r
            LEFT JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.square_group_id = $1 AND r.merchant_id = $2
        `, [group.id, MERCHANT_ID]);

        // Also check by reward ID from name
        let rewardById = { rows: [] };
        if (rewardIdFromName) {
            rewardById = await db.query(`
                SELECT r.id, r.status, r.square_customer_id, r.square_discount_id,
                       r.square_pricing_rule_id, r.square_product_set_id,
                       o.offer_name
                FROM loyalty_rewards r
                LEFT JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.id = $1 AND r.merchant_id = $2
            `, [rewardIdFromName, MERCHANT_ID]);
        }

        const reward = rewardByGroup.rows[0] || rewardById.rows[0] || null;
        let reason = null;

        if (!reward) {
            reason = 'no DB match';
        } else if (reward.status === 'redeemed') {
            reason = 'redeemed reward (should have been cleaned up)';
        } else if (reward.status === 'revoked' || reward.status === 'expired') {
            reason = `${reward.status} reward`;
        } else if (reward.status === 'earned' || reward.status === 'in_progress') {
            // Active reward — not orphaned
            continue;
        } else {
            reason = `unexpected status: ${reward.status}`;
        }

        // This group is orphaned — gather associated Square objects
        const orphan = {
            groupId: group.id,
            groupName: group.name,
            rewardIdFromName,
            reason,
            squareCustomerId: reward?.square_customer_id || null,
            discountId: reward?.square_discount_id || null,
            pricingRuleId: reward?.square_pricing_rule_id || null,
            productSetId: reward?.square_product_set_id || null,
            dbRewardId: reward?.id || null,
            offerName: reward?.offer_name || null
        };

        orphans.push(orphan);

        log(`ORPHAN: ${group.name}`, {
            groupId: group.id,
            reason,
            rewardId: orphan.dbRewardId,
            discountId: orphan.discountId,
            pricingRuleId: orphan.pricingRuleId
        });
    }

    // Step 4: Report
    log('--- AUDIT SUMMARY ---');
    log(`Total groups scanned: ${scanned}`);
    log(`Total orphaned: ${orphans.length}`);

    if (orphans.length === 0) {
        log('No orphans found — all clean!');
        await db.pool.end();
        return;
    }

    // Step 5: Execute cleanup if not dry-run
    let cleaned = 0;
    if (!DRY_RUN) {
        log('Executing cleanup...');

        for (const orphan of orphans) {
            try {
                // Delete catalog objects (discount, product set, pricing rule)
                const objectsToDelete = [
                    orphan.pricingRuleId,
                    orphan.productSetId,
                    orphan.discountId
                ].filter(Boolean);

                if (objectsToDelete.length > 0) {
                    const catalogResult = await deleteCatalogObjects(MERCHANT_ID, objectsToDelete, {
                        auditContext: 'orphan-audit-cleanup'
                    });
                    log(`Deleted catalog objects`, {
                        groupId: orphan.groupId,
                        deleted: catalogResult.deleted,
                        failed: catalogResult.failed
                    });
                    await sleep(API_DELAY_MS);
                }

                // Remove customer from group and delete group
                const customerIds = orphan.squareCustomerId ? [orphan.squareCustomerId] : [];
                const groupResult = await deleteCustomerGroupWithMembers(
                    MERCHANT_ID,
                    orphan.groupId,
                    customerIds
                );
                log(`Deleted customer group`, {
                    groupId: orphan.groupId,
                    customerRemoved: groupResult.customersRemoved,
                    groupDeleted: groupResult.groupDeleted
                });
                await sleep(API_DELAY_MS);

                // Clear Square IDs from DB reward record if it exists
                if (orphan.dbRewardId) {
                    await db.query(`
                        UPDATE loyalty_rewards SET
                            square_group_id = NULL,
                            square_discount_id = NULL,
                            square_product_set_id = NULL,
                            square_pricing_rule_id = NULL,
                            updated_at = NOW()
                        WHERE id = $1 AND merchant_id = $2
                    `, [orphan.dbRewardId, MERCHANT_ID]);
                    log(`Cleared Square IDs from reward`, { rewardId: orphan.dbRewardId });
                }

                cleaned++;
            } catch (err) {
                // Skip failures, log and continue
                log(`ERROR cleaning orphan — skipping`, {
                    groupId: orphan.groupId,
                    error: err.message
                });
            }
        }
    }

    log('--- FINAL REPORT ---');
    log(`Total scanned: ${scanned}`);
    log(`Total orphaned: ${orphans.length}`);
    log(`Total cleaned: ${DRY_RUN ? '0 (dry-run)' : cleaned}`);

    if (DRY_RUN && orphans.length > 0) {
        log('Run with --execute to remove orphaned objects');
    }

    await db.pool.end();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
runAudit().catch(err => {
    console.error('[orphan-audit] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
