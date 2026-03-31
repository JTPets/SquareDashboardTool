/**
 * Auto Min/Max Stock Adjustment Job (BACKLOG-106 v2)
 *
 * Weekly cron job that automatically adjusts min stock levels for all active merchants.
 * Applies OVERSTOCKED and SOLDOUT_FAST_MOVER rules directly — no approval step.
 * Merchants can pin individual variations to prevent auto-adjustment.
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

/**
 * Run auto min/max adjustments for a single merchant.
 * If the service aborts due to a guardrail (stale data, circuit breaker),
 * logs the reason. The service already sends the guardrail alert email.
 *
 * @param {number} merchantId
 * @param {string} businessName
 * @returns {Promise<{reduced, increased, skipped, pinned, tooNew}|{aborted: true, reason: string}>}
 */
async function runAutoMinMaxForMerchant(merchantId, businessName) {
    const result = await autoMinMax.applyWeeklyAdjustments(merchantId);
    if (result.aborted) {
        logger.warn('Auto min/max aborted for merchant', {
            merchantId,
            businessName,
            reason: result.reason
        });
    } else {
        logger.info('Auto min/max adjustments complete for merchant', {
            merchantId,
            businessName,
            ...result
        });
    }
    return result;
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
 */
async function runScheduledAutoMinMax() {
    try {
        const { results } = await runAutoMinMaxForAllMerchants();

        for (const r of results) {
            if (r.error) continue;
            if (r.aborted) continue; // guardrail alert already sent by service
            if (r.reduced === 0 && r.increased === 0) continue;

            const subject = `Min Stock Auto-Adjustment: ${r.reduced} reduced, ${r.increased} increased — ${r.businessName}`;
            const body = [
                `Weekly min stock auto-adjustment complete.\n`,
                `Merchant: ${r.businessName}`,
                `Mins reduced:  ${r.reduced}`,
                `Mins increased: ${r.increased}`,
                `Pinned (skipped): ${r.pinned || 0}`,
                `Too new (skipped): ${r.tooNew || 0}`,
                `Other skipped: ${r.skipped || 0}`,
                `\nReview changes at: /min-max-history.html`
            ].join('\n');

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
