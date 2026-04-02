/**
 * Vendor Match Backfill Job — BACKLOG-114
 *
 * Weekly cron: scan all matched vendor catalog items across all merchants,
 * generating pending cross-vendor UPC match suggestions for any gaps.
 * Never auto-approves — all results are PENDING for merchant review.
 */

const logger = require('../utils/logger');
const { runBackfillScanAllMerchants } = require('../services/vendor/match-suggestions-service');

/**
 * Run the vendor match backfill scan for all active merchants.
 * Called by cron scheduler.
 */
async function runScheduledVendorMatchBackfill() {
    logger.info('Vendor match backfill job: starting');

    try {
        const result = await runBackfillScanAllMerchants();

        const totalSuggestions = result.results.reduce((sum, r) => sum + (r.suggestionsCreated || 0), 0);
        const totalScanned = result.results.reduce((sum, r) => sum + (r.scanned || 0), 0);

        logger.info('Vendor match backfill job: complete', {
            merchantCount: result.merchantCount,
            totalScanned,
            totalSuggestions,
            errors: result.errors.length
        });

        if (result.errors.length > 0) {
            logger.warn('Vendor match backfill job: some merchants had errors', {
                errors: result.errors
            });
        }
    } catch (error) {
        logger.error('Vendor match backfill job: fatal error', {
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = { runScheduledVendorMatchBackfill };
