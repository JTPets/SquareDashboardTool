/**
 * Auto Min/Max Stock Adjustment Job (BACKLOG-106 v2)
 *
 * Weekly cron job that automatically adjusts min stock levels for all active merchants.
 * Applies OVERSTOCKED and SOLDOUT_FAST_MOVER rules directly — no approval step.
 * Merchants can pin individual variations to prevent auto-adjustment.
 *
 * After a clean local commit, pushes updated min thresholds to Square catalog.
 * Square sync failures are caught and emailed — they never crash the job.
 *
 * Schedule: Sunday 6 AM ET (before Monday ordering)
 * Email: summary per merchant when any adjustments are made
 *
 * @module jobs/auto-min-max-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');
const autoMinMax = require('../services/inventory/auto-min-max-service');
const { syncMinsToSquare } = require('../services/inventory/auto-min-max-square-sync');

/**
 * Run auto min/max adjustments for a single merchant.
 * If the service aborts due to a guardrail (stale data, circuit breaker),
 * logs the reason. The service already sends the guardrail alert email.
 *
 * On success, syncs adjusted mins to Square. Sync errors are caught,
 * logged, and emailed — they do not affect the local audit log.
 *
 * @param {number} merchantId
 * @param {string} businessName
 * @returns {Promise<object>} result with counts, adjustments, and syncResult
 */
async function runAutoMinMaxForMerchant(merchantId, businessName) {
    const result = await autoMinMax.applyWeeklyAdjustments(merchantId);
    if (result.aborted) {
        logger.warn('Auto min/max aborted for merchant', {
            merchantId,
            businessName,
            reason: result.reason
        });
        return result;
    }

    logger.info('Auto min/max adjustments complete for merchant', {
        merchantId,
        businessName,
        reduced: result.reduced,
        increased: result.increased,
        skipped: result.skipped,
        pinned: result.pinned,
        tooNew: result.tooNew
    });

    // Sync mins to Square — only after clean local commit
    let syncResult = { synced: 0, failed: 0, errors: [] };
    if (result.adjustments && result.adjustments.length > 0) {
        try {
            syncResult = await syncMinsToSquare(merchantId, result.adjustments);
            logger.info('Square min sync complete for merchant', { merchantId, ...syncResult });
        } catch (err) {
            logger.error('Square min sync failed for merchant', {
                merchantId,
                businessName,
                error: err.message
            });
            await emailNotifier.sendAlert(
                `Auto Min/Max Square Sync Failed — ${businessName}`,
                `Failed to sync min thresholds to Square.\n\nMerchant: ${businessName} (ID: ${merchantId})\nError: ${err.message}`
            );
        }
    }

    return { ...result, syncResult };
}

/**
 * Run auto min/max adjustments for all active merchants.
 *
 * @returns {Promise<{merchantCount: number, results: Array}>}
 */
async function runAutoMinMaxForAllMerchants() {
    logger.info('Running weekly auto min/max stock adjustments');

    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No active merchants for auto min/max adjustments');
        return { merchantCount: 0, results: [] };
    }

    const results = [];
    for (const merchant of merchants) {
        try {
            const result = await runAutoMinMaxForMerchant(merchant.id, merchant.business_name);
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
        } catch (err) {
            logger.error('Auto min/max failed for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: err.message
            });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: err.message
            });
        }
    }

    return { merchantCount: merchants.length, results };
}

/**
 * Cron handler for scheduled weekly auto min/max adjustment.
 * Sends a per-merchant summary email when adjustments are made.
 * Includes Square sync result in the email body.
 */
async function runScheduledAutoMinMax() {
    try {
        const { results } = await runAutoMinMaxForAllMerchants();

        for (const r of results) {
            if (r.error) continue;
            if (r.aborted) continue; // guardrail alert already sent by service
            const conflicts = Array.isArray(r.conflicts) ? r.conflicts : [];
            if (r.reduced === 0 && r.increased === 0 && conflicts.length === 0) continue;

            const sync = r.syncResult || { synced: 0, failed: 0, repairedParents: 0 };
            const subject = `Min Stock Auto-Adjustment: ${r.reduced} reduced, ${r.increased} increased — ${r.businessName}`;
            const bodyLines = [
                `Weekly min stock auto-adjustment complete.\n`,
                `Merchant: ${r.businessName}`,
                `Mins reduced:  ${r.reduced}`,
                `Mins increased: ${r.increased}`,
                `Pinned (skipped): ${r.pinned || 0}`,
                `Too new (skipped): ${r.tooNew || 0}`,
                `Other skipped: ${r.skipped || 0}`,
                `Synced to Square: ${sync.synced} (${sync.failed} failed)`,
            ];
            if (sync.repairedParents > 0) {
                bodyLines.push(`Repaired ${sync.repairedParents} parent item location mismatch(es) before sync`);
            }
            if (conflicts.length > 0) {
                bodyLines.push('');
                bodyLines.push(`${conflicts.length} items skipped — min would meet or exceed max (review required):`);
                for (const c of conflicts) {
                    const name = c.itemName || c.variationName || c.sku || c.variationId;
                    const detail = c.conflictDetail
                        ? ` (recommended min ${c.conflictDetail.new_min} ≥ current max ${c.conflictDetail.current_max})`
                        : '';
                    bodyLines.push(`  - ${name}${detail}`);
                }
            }
            bodyLines.push(`\nReview changes at: /min-max-history.html`);
            const body = bodyLines.join('\n');

            try {
                await emailNotifier.sendAlert(subject, body);
            } catch (emailErr) {
                logger.error('Failed to send auto min/max summary email', {
                    merchantId: r.merchantId,
                    error: emailErr.message
                });
            }
        }
    } catch (error) {
        logger.error('Scheduled auto min/max job failed', {
            error: error.message,
            stack: error.stack
        });
        await emailNotifier.sendAlert(
            'Auto Min/Max Job Failed',
            `Failed to run weekly auto min/max stock adjustments:\n\n${error.message}\n\nStack: ${error.stack}`
        );
    }
}

module.exports = {
    runAutoMinMaxForMerchant,
    runAutoMinMaxForAllMerchants,
    runScheduledAutoMinMax
};
