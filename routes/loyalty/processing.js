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
const db = require('../../utils/database');
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

    // Find all unique customer IDs with rewards but no phone in cache
    const missingResult = await db.query(`
        SELECT DISTINCT r.square_customer_id
        FROM loyalty_rewards r
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
          AND (lc.phone_number IS NULL OR lc.square_customer_id IS NULL)
    `, [merchantId]);

    const customerIds = missingResult.rows.map(r => r.square_customer_id);

    if (customerIds.length === 0) {
        return res.json({ success: true, message: 'No customers with missing phone data', refreshed: 0 });
    }

    logger.info('Refreshing customer data for rewards', { merchantId, count: customerIds.length });

    let refreshed = 0;
    let failed = 0;
    const errors = [];

    // Concurrent customer fetch with semaphore (D-3: replaces N+1 sequential loop)
    const CONCURRENCY = 5;
    let active = 0;
    const queue = [];

    function runWithLimit(fn) {
        return new Promise((resolve, reject) => {
            const execute = async () => {
                active++;
                try {
                    resolve(await fn());
                } catch (err) {
                    reject(err);
                } finally {
                    active--;
                    if (queue.length > 0) {
                        queue.shift()();
                    }
                }
            };
            if (active < CONCURRENCY) {
                execute();
            } else {
                queue.push(execute);
            }
        });
    }

    const results = await Promise.allSettled(
        customerIds.map(customerId =>
            runWithLimit(async () => {
                const customer = await loyaltyService.getCustomerDetails(customerId, merchantId);
                return { customerId, customer };
            })
        )
    );

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.customer) {
            refreshed++;
            logger.debug('Refreshed customer', {
                customerId: result.value.customerId,
                phone: result.value.customer.phone ? 'yes' : 'no'
            });
        } else {
            failed++;
            const customerId = result.status === 'fulfilled'
                ? result.value.customerId : 'unknown';
            const error = result.status === 'rejected'
                ? result.reason.message : 'Customer not found in Square';
            errors.push({ customerId, error });
        }
    }

    logger.info('Customer refresh complete', { merchantId, refreshed, failed });

    res.json({
        success: true,
        total: customerIds.length,
        refreshed,
        failed,
        errors: errors.length > 0 ? errors : undefined
    });
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
