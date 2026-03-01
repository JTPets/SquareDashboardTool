/**
 * Loyalty Order Processing Routes
 *
 * Order processing, backfill, catchup, and maintenance:
 * - POST /process-order/:orderId - Manually process a single order
 * - POST /backfill - Backfill loyalty from recent Square orders
 * - POST /catchup - Run reverse-lookup loyalty catchup
 * - POST /refresh-customers - Refresh customer details for rewards
 * - POST /manual-entry - Manual loyalty purchase entry
 * - POST /process-expired - Process expired window entries and rewards
 */

const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');

/**
 * POST /api/loyalty/process-order/:orderId
 * Manually fetch and process a specific Square order for loyalty
 * Useful for testing/debugging when webhooks aren't working
 */
router.post('/process-order/:orderId', requireAuth, requireMerchant, requireWriteAccess, validators.processOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const squareOrderId = req.params.orderId;

    const result = await loyaltyService.processOrderManually({ merchantId, squareOrderId });
    res.json(result);
}));

/**
 * POST /api/loyalty/backfill
 * Fetch recent orders from Square and process them for loyalty
 * Useful for catching up on orders that weren't processed via webhook
 */
router.post('/backfill', requireAuth, requireMerchant, requireWriteAccess, validators.backfill, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { days = 7 } = req.body;

    const result = await loyaltyService.runBackfill({ merchantId, days });
    res.json(result);
}));

/**
 * POST /api/loyalty/catchup
 * Run "reverse lookup" loyalty catchup for known customers
 */
router.post('/catchup', requireAuth, requireMerchant, requireWriteAccess, validators.catchup, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { days = 30, customerIds = null, maxCustomers = 100 } = req.body;

    logger.info('Starting loyalty catchup via API', { merchantId, days, maxCustomers });

    const result = await loyaltyService.runLoyaltyCatchup({
        merchantId,
        customerIds,
        periodDays: days,
        maxCustomers
    });

    res.json({
        success: true,
        ...result
    });
}));

/**
 * POST /api/loyalty/refresh-customers
 * Refresh customer details for rewards with missing phone numbers
 * Fetches customer data from Square and updates the cache
 */
router.post('/refresh-customers', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const result = await loyaltyService.refreshCustomersWithMissingData(merchantId);
    res.json(result);
}));

/**
 * POST /api/loyalty/manual-entry
 * Manually record a loyalty purchase for orders where customer wasn't attached
 */
router.post('/manual-entry', requireAuth, requireMerchant, requireWriteAccess, validators.manualEntry, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { squareOrderId, squareCustomerId, variationId, quantity, purchasedAt } = req.body;

    const qty = parseInt(quantity) || 1;

    logger.info('Manual loyalty entry', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty
    });

    // Process the purchase using the loyalty service
    const result = await loyaltyService.processQualifyingPurchase({
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
        return res.status(400).json({
            success: false,
            reason: result.reason,
            message: result.reason === 'variation_not_qualifying'
                ? 'This variation is not configured as a qualifying item for any loyalty offer'
                : result.reason === 'already_processed'
                ? 'This purchase has already been recorded'
                : 'Could not process this purchase'
        });
    }

    res.json({
        success: true,
        purchaseEvent: result.purchaseEvent,
        reward: result.reward,
        message: `Recorded ${qty} purchase(s). Progress: ${result.reward.currentQuantity}/${result.reward.requiredQuantity}`
    });
}));

/**
 * POST /api/loyalty/process-expired
 * Process expired window entries (run periodically or on-demand)
 */
router.post('/process-expired', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Process expired window entries (purchases that aged out)
    const windowResult = await loyaltyService.processExpiredWindowEntries(merchantId);

    // Also process expired earned rewards
    const earnedResult = await loyaltyService.processExpiredEarnedRewards(merchantId);

    logger.info('Processed expired loyalty entries', {
        merchantId,
        windowEntriesProcessed: windowResult.processedCount,
        earnedRewardsRevoked: earnedResult.processedCount
    });

    res.json({
        windowEntries: windowResult,
        expiredEarnedRewards: earnedResult
    });
}));

module.exports = router;
