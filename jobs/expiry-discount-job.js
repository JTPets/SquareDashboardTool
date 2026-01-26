/**
 * Expiry Discount Job
 *
 * Handles automated expiry discount processing for all merchants.
 * Evaluates items approaching expiration and applies appropriate discount tiers.
 * Sends email notifications for tier changes and items needing attention.
 *
 * @module jobs/expiry-discount-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');
const expiryDiscount = require('../utils/expiry-discount');

/**
 * Run expiry discount automation for a single merchant
 *
 * @param {number} merchantId - Merchant ID
 * @param {string} businessName - Merchant business name
 * @returns {Promise<Object>} Result of automation run
 */
async function runExpiryDiscountForMerchant(merchantId, businessName) {
    // Check if automation is enabled for this merchant
    const autoApplyEnabled = await expiryDiscount.getSetting('auto_apply_enabled', merchantId);
    if (autoApplyEnabled !== 'true') {
        logger.info('Expiry discount automation is disabled for merchant, skipping', {
            merchantId,
            businessName
        });
        return { skipped: true, reason: 'automation_disabled' };
    }

    const result = await expiryDiscount.runExpiryDiscountAutomation({
        merchantId,
        dryRun: false
    });

    logger.info('Scheduled expiry discount automation completed for merchant', {
        merchantId,
        businessName,
        success: result.success,
        tierChanges: result.evaluation?.tierChanges?.length || 0,
        newAssignments: result.evaluation?.newAssignments?.length || 0,
        discountsApplied: result.discountApplication?.applied?.length || 0,
        duration: result.duration
    });

    // Send email notification for tier changes
    const tierChanges = result.evaluation?.tierChanges?.length || 0;
    const newAssignments = result.evaluation?.newAssignments?.length || 0;
    const needsPull = result.evaluation?.byTier?.EXPIRED || 0;

    if (tierChanges > 0 || newAssignments > 0 || needsPull > 0) {
        const emailEnabled = await expiryDiscount.getSetting('email_notifications', merchantId);
        if (emailEnabled === 'true') {
            try {
                let emailBody = `Expiry Discount Automation Report\n\n`;
                emailBody += `Merchant: ${businessName}\n`;
                emailBody += `Run Time: ${new Date().toISOString()}\n\n`;
                emailBody += `Summary:\n`;
                emailBody += `- Total items evaluated: ${result.evaluation?.totalEvaluated || 0}\n`;
                emailBody += `- Tier changes: ${tierChanges}\n`;
                emailBody += `- New tier assignments: ${newAssignments}\n`;
                emailBody += `- Discounts applied: ${result.discountApplication?.applied?.length || 0}\n`;
                emailBody += `- Discounts removed: ${result.discountApplication?.removed?.length || 0}\n`;
                emailBody += `- Items needing pull (EXPIRED): ${needsPull}\n`;
                emailBody += `- Errors: ${result.errors?.length || 0}\n\n`;

                // Add tier breakdown
                emailBody += `Items by Tier:\n`;
                for (const [tierCode, count] of Object.entries(result.evaluation?.byTier || {})) {
                    emailBody += `  ${tierCode}: ${count}\n`;
                }

                emailBody += `\nDuration: ${result.duration}ms`;

                // Include urgent items if any
                if (needsPull > 0) {
                    emailBody += `\n\n Warning: ${needsPull} item(s) are EXPIRED and need to be pulled from shelves!`;
                }

                await emailNotifier.sendAlert(
                    `Expiry Discount Report - ${businessName} - ${tierChanges + newAssignments} Changes`,
                    emailBody
                );
            } catch (emailError) {
                logger.error('Failed to send expiry discount automation email', {
                    merchantId,
                    error: emailError.message
                });
            }
        }
    }

    return result;
}

/**
 * Run expiry discount automation for all active merchants
 *
 * @returns {Promise<Object>} Results for each merchant
 */
async function runExpiryDiscountForAllMerchants() {
    logger.info('Running scheduled expiry discount automation');

    // Get all active merchants for multi-tenant automation
    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No active merchants for expiry discount automation');
        return { merchantCount: 0, results: [] };
    }

    const results = [];
    for (const merchant of merchants) {
        try {
            const result = await runExpiryDiscountForMerchant(merchant.id, merchant.business_name);
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
        } catch (merchantError) {
            logger.error('Scheduled expiry discount automation failed for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: merchantError.message
            });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: merchantError.message
            });
        }
    }

    return { merchantCount: merchants.length, results };
}

/**
 * Cron job handler for scheduled expiry discount automation
 * Wraps runExpiryDiscountForAllMerchants with error handling and email alerts
 *
 * @returns {Promise<void>}
 */
async function runScheduledExpiryDiscount() {
    try {
        await runExpiryDiscountForAllMerchants();
    } catch (error) {
        logger.error('Scheduled expiry discount automation failed', { error: error.message, stack: error.stack });
        await emailNotifier.sendAlert(
            'Expiry Discount Automation Failed',
            `Failed to run scheduled expiry discount automation:\n\n${error.message}\n\nStack: ${error.stack}`
        );
    }
}

module.exports = {
    runExpiryDiscountForMerchant,
    runExpiryDiscountForAllMerchants,
    runScheduledExpiryDiscount
};
