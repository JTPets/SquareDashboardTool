/**
 * Manual Entry Service
 *
 * Handles manual loyalty purchase entry for orders where customer
 * wasn't attached at time of sale.
 *
 * Extracted from routes/loyalty/processing.js (O-8)
 * — moved as-is, no refactoring.
 */

const logger = require('../../utils/logger');
const { processQualifyingPurchase } = require('./purchase-service');

/**
 * Process a manual loyalty purchase entry.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {string} params.squareOrderId - Square order ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {string} params.variationId - Catalog variation ID
 * @param {number} params.quantity - Quantity purchased (default 1)
 * @param {string|Date} [params.purchasedAt] - Purchase timestamp
 * @returns {Promise<Object>} { success, purchaseEvent, reward, message } or { success: false, reason, message }
 */
async function processManualEntry({ merchantId, squareOrderId, squareCustomerId, variationId, quantity, purchasedAt }) {
    if (!merchantId) {
        throw new Error('merchantId is required for processManualEntry - tenant isolation required');
    }

    const qty = parseInt(quantity) || 1;

    logger.info('Manual loyalty entry', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty
    });

    const result = await processQualifyingPurchase({
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty,
        unitPriceCents: 0,  // Unknown for manual entry
        purchasedAt: purchasedAt || new Date(),
        squareLocationId: null,
        customerSource: 'manual'
    });

    if (!result.processed) {
        return {
            success: false,
            reason: result.reason,
            message: result.reason === 'variation_not_qualifying'
                ? 'This variation is not configured as a qualifying item for any loyalty offer'
                : result.reason === 'already_processed'
                ? 'This purchase has already been recorded'
                : 'Could not process this purchase'
        };
    }

    return {
        success: true,
        purchaseEvent: result.purchaseEvent,
        reward: result.reward,
        message: `Recorded ${qty} purchase(s). Progress: ${result.reward.currentQuantity}/${result.reward.requiredQuantity}`
    };
}

module.exports = {
    processManualEntry
};
