/**
 * Loyalty Audit Job
 *
 * Scheduled job that detects orphaned rewards - rewards redeemed in Square
 * but missing from our local database.
 *
 * Runs daily at 2 AM by default, checking the last 48 hours of Square
 * loyalty events for discrepancies.
 *
 * Detection only - no auto-repair. Findings are logged to loyalty_audit_log
 * table for manual review and resolution.
 *
 * Issue types detected:
 * - MISSING_REDEMPTION: Redeemed in Square, no local loyalty_rewards record
 * - PHANTOM_REWARD: Local reward with no corresponding purchase events
 * - DOUBLE_REDEMPTION: Same reward appears redeemed multiple times
 *
 * @module jobs/loyalty-audit-job
 */

const db = require('../utils/database');
const { getSquareClientForMerchant } = require('../middleware/merchant');
const { loyaltyLogger } = require('../services/loyalty/loyalty-logger');

/**
 * Get all merchants with active loyalty offers
 *
 * @returns {Promise<Array>} Array of merchant objects with id and square_merchant_id
 */
async function getMerchantsWithLoyalty() {
    const result = await db.query(`
        SELECT DISTINCT m.id, m.square_merchant_id
        FROM merchants m
        INNER JOIN loyalty_offers lo ON lo.merchant_id = m.id
        WHERE m.is_active = TRUE
          AND lo.is_active = TRUE
    `);
    return result.rows;
}

/**
 * Fetch loyalty events from Square for the given time range
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {number} hoursBack - How many hours back to search
 * @returns {Promise<Array>} Array of REDEEM_REWARD loyalty events
 */
async function fetchSquareRedemptionEvents(merchantId, hoursBack = 48) {
    const squareClient = await getSquareClientForMerchant(merchantId);

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - (hoursBack * 60 * 60 * 1000));

    const events = [];
    let cursor = null;

    loyaltyLogger.squareApi({
        action: 'SEARCH_LOYALTY_EVENTS_START',
        merchantId,
        hoursBack,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString()
    });

    do {
        const response = await squareClient.loyalty.events.search({
            query: {
                filter: {
                    typeFilter: {
                        types: ['REDEEM_REWARD']
                    },
                    dateTimeFilter: {
                        createdAt: {
                            startAt: startTime.toISOString(),
                            endAt: endTime.toISOString()
                        }
                    }
                }
            },
            limit: 100,
            cursor
        });

        if (response.events) {
            events.push(...response.events);
        }

        cursor = response.cursor;
    } while (cursor && events.length < 1000); // Cap at 1000 events

    loyaltyLogger.squareApi({
        action: 'SEARCH_LOYALTY_EVENTS_COMPLETE',
        merchantId,
        eventsFound: events.length
    });

    return events;
}

/**
 * Get local redemption records for the given order IDs
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {Array<string>} orderIds - Order IDs to check
 * @returns {Promise<Map>} Map of order_id -> reward record
 */
async function getLocalRedemptions(merchantId, orderIds) {
    if (orderIds.length === 0) return new Map();

    const result = await db.query(`
        SELECT id, square_customer_id, redemption_order_id, status, redeemed_at
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND redemption_order_id = ANY($2)
          AND status = 'redeemed'
    `, [merchantId, orderIds]);

    const map = new Map();
    for (const row of result.rows) {
        map.set(row.redemption_order_id, row);
    }
    return map;
}

/**
 * Check if purchase events exist for a reward
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {string} rewardId - Reward UUID to check
 * @returns {Promise<boolean>} True if purchase events exist
 */
async function hasPurchaseEvents(merchantId, rewardId) {
    const result = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND reward_id = $2
    `, [merchantId, rewardId]);

    return parseInt(result.rows[0].count) > 0;
}

/**
 * Log an orphan finding to the audit log
 *
 * @param {Object} finding - The audit finding
 * @returns {Promise<void>}
 */
async function logAuditFinding(finding) {
    await db.query(`
        INSERT INTO loyalty_audit_log (
            merchant_id, square_customer_id, order_id, reward_id,
            issue_type, details
        ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
        finding.merchantId,
        finding.squareCustomerId || null,
        finding.orderId || null,
        finding.rewardId || null,
        finding.issueType,
        JSON.stringify(finding.details || {})
    ]);

    // FUTURE: auto-repair logic would go here
    // For MISSING_REDEMPTION: could create a reward record retroactively
    // For PHANTOM_REWARD: could mark reward as needs_review
    // For DOUBLE_REDEMPTION: could flag for manual investigation
}

/**
 * Audit a single merchant for orphaned rewards
 *
 * @param {Object} merchant - Merchant object with id and square_merchant_id
 * @param {number} hoursBack - How many hours back to search
 * @returns {Promise<Object>} Audit results
 */
async function auditMerchant(merchant, hoursBack) {
    const merchantId = merchant.id;
    const results = {
        merchantId,
        eventsChecked: 0,
        orphansFound: 0,
        missingRedemptions: 0,
        phantomRewards: 0,
        doubleRedemptions: 0,
        errors: []
    };

    try {
        // Fetch Square redemption events
        const events = await fetchSquareRedemptionEvents(merchantId, hoursBack);
        results.eventsChecked = events.length;

        if (events.length === 0) {
            return results;
        }

        // Extract order IDs from events
        const orderIds = events
            .map(e => e.redeemReward?.orderId)
            .filter(Boolean);

        // Get local redemption records
        const localRedemptions = await getLocalRedemptions(merchantId, orderIds);

        // Track seen order IDs for double redemption detection
        const seenOrderIds = new Map();

        for (const event of events) {
            const orderId = event.redeemReward?.orderId;
            const customerId = event.loyaltyAccountId;
            const squareRewardId = event.redeemReward?.rewardId;

            if (!orderId) continue;

            // Check for double redemptions
            if (seenOrderIds.has(orderId)) {
                results.doubleRedemptions++;
                results.orphansFound++;
                await logAuditFinding({
                    merchantId,
                    squareCustomerId: customerId,
                    orderId,
                    rewardId: squareRewardId,
                    issueType: 'DOUBLE_REDEMPTION',
                    details: {
                        firstEvent: seenOrderIds.get(orderId),
                        duplicateEvent: {
                            eventId: event.id,
                            createdAt: event.createdAt
                        }
                    }
                });
                // FUTURE: auto-repair - flag for manual review, possibly void duplicate
                continue;
            }

            seenOrderIds.set(orderId, {
                eventId: event.id,
                createdAt: event.createdAt
            });

            // Check for missing local redemption record
            const localRecord = localRedemptions.get(orderId);
            if (!localRecord) {
                results.missingRedemptions++;
                results.orphansFound++;
                await logAuditFinding({
                    merchantId,
                    squareCustomerId: customerId,
                    orderId,
                    rewardId: squareRewardId,
                    issueType: 'MISSING_REDEMPTION',
                    details: {
                        squareEventId: event.id,
                        squareCreatedAt: event.createdAt,
                        rewardTierId: event.redeemReward?.rewardTierId
                    }
                });
                // FUTURE: auto-repair - create reward record retroactively
                continue;
            }

            // Check for phantom rewards (no purchase events backing it)
            const hasPurchases = await hasPurchaseEvents(merchantId, localRecord.id);
            if (!hasPurchases) {
                results.phantomRewards++;
                results.orphansFound++;
                await logAuditFinding({
                    merchantId,
                    squareCustomerId: customerId,
                    orderId,
                    rewardId: localRecord.id,
                    issueType: 'PHANTOM_REWARD',
                    details: {
                        localRewardId: localRecord.id,
                        redeemedAt: localRecord.redeemed_at,
                        noPurchaseEventsFound: true
                    }
                });
                // FUTURE: auto-repair - backfill purchase events or flag for review
            }
        }

    } catch (error) {
        loyaltyLogger.error({
            action: 'AUDIT_MERCHANT_FAILED',
            merchantId,
            error: error.message,
            stack: error.stack
        });
        results.errors.push({ error: error.message });
    }

    return results;
}

/**
 * Run the loyalty audit job for all merchants
 *
 * @param {Object} [options] - Job options
 * @param {number} [options.hoursBack=48] - How many hours back to search
 * @returns {Promise<Object>} Aggregated audit results
 */
async function runLoyaltyAudit(options = {}) {
    const { hoursBack = 48 } = options;

    const startTime = Date.now();
    const aggregateResults = {
        merchantsAudited: 0,
        totalEventsChecked: 0,
        totalOrphansFound: 0,
        totalMissingRedemptions: 0,
        totalPhantomRewards: 0,
        totalDoubleRedemptions: 0,
        merchantErrors: []
    };

    try {
        const merchants = await getMerchantsWithLoyalty();

        if (merchants.length === 0) {
            loyaltyLogger.audit({
                action: 'LOYALTY_AUDIT_SKIPPED',
                reason: 'No merchants with active loyalty offers'
            });
            return aggregateResults;
        }

        loyaltyLogger.audit({
            action: 'LOYALTY_AUDIT_START',
            merchantCount: merchants.length,
            hoursBack
        });

        for (const merchant of merchants) {
            const results = await auditMerchant(merchant, hoursBack);

            aggregateResults.merchantsAudited++;
            aggregateResults.totalEventsChecked += results.eventsChecked;
            aggregateResults.totalOrphansFound += results.orphansFound;
            aggregateResults.totalMissingRedemptions += results.missingRedemptions;
            aggregateResults.totalPhantomRewards += results.phantomRewards;
            aggregateResults.totalDoubleRedemptions += results.doubleRedemptions;

            if (results.errors.length > 0) {
                aggregateResults.merchantErrors.push({
                    merchantId: merchant.id,
                    errors: results.errors
                });
            }

            // Log per-merchant if issues found
            if (results.orphansFound > 0) {
                loyaltyLogger.audit({
                    action: 'MERCHANT_AUDIT_ISSUES',
                    merchantId: merchant.id,
                    orphansFound: results.orphansFound,
                    missingRedemptions: results.missingRedemptions,
                    phantomRewards: results.phantomRewards,
                    doubleRedemptions: results.doubleRedemptions
                });
            }
        }

        const duration = Date.now() - startTime;

        // Log summary at appropriate level
        if (aggregateResults.totalOrphansFound > 0) {
            loyaltyLogger.error({
                action: 'LOYALTY_AUDIT_COMPLETE_WITH_ISSUES',
                ...aggregateResults,
                durationMs: duration
            });
        } else {
            loyaltyLogger.audit({
                action: 'LOYALTY_AUDIT_COMPLETE_CLEAN',
                ...aggregateResults,
                durationMs: duration
            });
        }

        loyaltyLogger.perf({
            operation: 'LOYALTY_AUDIT_JOB',
            durationMs: duration,
            merchantsAudited: aggregateResults.merchantsAudited,
            eventsChecked: aggregateResults.totalEventsChecked
        });

    } catch (error) {
        loyaltyLogger.error({
            action: 'LOYALTY_AUDIT_JOB_FAILED',
            error: error.message,
            stack: error.stack
        });
        throw error;
    }

    return aggregateResults;
}

/**
 * Cron job handler for scheduled loyalty audit
 * Wraps runLoyaltyAudit with error handling
 *
 * @returns {Promise<void>}
 */
async function runScheduledLoyaltyAudit() {
    try {
        await runLoyaltyAudit({ hoursBack: 48 });
    } catch (error) {
        loyaltyLogger.error({
            action: 'SCHEDULED_LOYALTY_AUDIT_ERROR',
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = {
    runLoyaltyAudit,
    runScheduledLoyaltyAudit,
    auditMerchant,
    getMerchantsWithLoyalty
};
