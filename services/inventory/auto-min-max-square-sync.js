/**
 * Auto Min/Max Square Sync
 *
 * Pushes adjusted min-stock thresholds to Square catalog after a successful
 * weekly applyWeeklyAdjustments() run. Kept separate because
 * auto-min-max-service.js exceeds the 300-line file limit.
 *
 * Local DB remains source of truth. Square sync is best-effort:
 * partial failures are logged but do not abort or roll back local changes.
 *
 * @module services/inventory/auto-min-max-square-sync
 */

const logger = require('../../utils/logger');
const { pushMinStockThresholdsToSquare } = require('../square/square-inventory');

/**
 * Push adjusted min-stock thresholds from a weekly adjustment run to Square.
 *
 * Uses pushMinStockThresholdsToSquare which:
 *   1. Batch-retrieves current catalog objects (100 at a time)
 *   2. Updates inventory_alert_threshold via location_overrides
 *   3. Batch-upserts the modified objects (100 at a time)
 *
 * On partial failure: logs errors, continues with remaining batches.
 * On total failure: logs warning, returns failed count equal to input length.
 *
 * @param {number} merchantId
 * @param {Array<{variationId: string, locationId: string, newMin: number, previousMin: number}>} adjustments
 * @returns {Promise<{synced: number, failed: number, errors: string[]}>}
 */
async function syncMinsToSquare(merchantId, adjustments) {
    if (!merchantId) throw new Error('merchantId is required');
    if (!adjustments || adjustments.length === 0) {
        return { synced: 0, failed: 0, errors: [] };
    }

    const changes = adjustments.map(a => ({
        variationId: a.variationId,
        locationId: a.locationId,
        newMin: a.newMin
    }));

    const errors = [];
    let synced = 0;
    let failed = 0;

    try {
        // pushMinStockThresholdsToSquare handles internal batching in groups of 100
        // and partial-failure recovery — it never throws unless token fetch fails
        const result = await pushMinStockThresholdsToSquare(merchantId, changes);
        synced = result.pushed;
        failed = result.failed;
        if (result.failed > 0) {
            errors.push(`${result.failed} variation(s) failed to sync to Square`);
        }
    } catch (err) {
        // Token fetch failure or unexpected error — nothing was synced
        failed = changes.length;
        errors.push(err.message);
        logger.warn('syncMinsToSquare: push failed entirely', {
            merchantId,
            count: changes.length,
            error: err.message
        });
    }

    logger.info('syncMinsToSquare complete', { merchantId, synced, failed });
    return { synced, failed, errors };
}

module.exports = { syncMinsToSquare };
