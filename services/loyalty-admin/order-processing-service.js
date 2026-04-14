/**
 * Order Processing Service
 *
 * Fetches a single order from Square and processes it for loyalty.
 * Used for manual processing/debugging when webhooks aren't working.
 *
 * Extracted from routes/loyalty/processing.js POST /process-order (A-13)
 *
 * Task 16: Migrated onto services/square/square-client.js. Preserves the
 * original 10_000 ms per-request timeout and the 400/502/404 error shapes
 * that callers and tests depend on.
 */

const logger = require('../../utils/logger');
const { makeSquareRequest, getMerchantToken, SquareApiError } = require('../square/square-client');
const { getCustomerDetails } = require('./customer-admin-service');
const { processLoyaltyOrder } = require('./order-intake');

/**
 * Fetch a single order from Square and process it for loyalty.
 * Returns diagnostics about the order and loyalty processing result.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {string} params.squareOrderId - Square order ID
 * @returns {Promise<Object>} Processing result with diagnostics
 */
async function processOrderManually({ merchantId, squareOrderId }) {
    if (!merchantId) {
        throw new Error('merchantId is required for processOrderManually - tenant isolation required');
    }

    logger.info('Manually processing order for loyalty', { squareOrderId, merchantId });

    // Get access token.
    // NOTE: getMerchantToken throws on missing/inactive merchants (whereas the
    // legacy getSquareAccessToken returned null). Preserve the original 400
    // "No Square access token configured" response shape so callers and tests
    // don't have to care about the throw-vs-null distinction.
    let accessToken;
    try {
        accessToken = await getMerchantToken(merchantId);
    } catch (tokenErr) {
        const error = new Error('No Square access token configured for this merchant');
        error.statusCode = 400;
        throw error;
    }

    // Fetch the order from Square. Preserve the 10_000 ms per-call timeout.
    let orderData;
    try {
        orderData = await makeSquareRequest(`/v2/orders/${squareOrderId}`, {
            accessToken,
            method: 'GET',
            timeout: 10000
        });
    } catch (err) {
        if (err instanceof SquareApiError) {
            logger.error('Square API error in loyalty order lookup', {
                status: err.status,
                error: err.details,
                merchantId,
                squareOrderId
            });
            const error = new Error('Unable to retrieve order details. Please try again.');
            error.statusCode = 502;
            error.code = 'EXTERNAL_API_ERROR';
            throw error;
        }
        throw err;
    }

    const order = orderData.order;

    if (!order) {
        const error = new Error('Order not found in Square');
        error.statusCode = 404;
        throw error;
    }

    // Fetch customer details if customer_id exists
    let customerDetails = null;
    if (order.customer_id) {
        customerDetails = await getCustomerDetails(order.customer_id, merchantId);
    }

    // Return diagnostic info about the order
    const diagnostics = {
        orderId: order.id,
        customerId: order.customer_id || null,
        hasCustomer: !!order.customer_id,
        customerDetails,
        state: order.state,
        createdAt: order.created_at,
        lineItems: (order.line_items || []).map(li => ({
            name: li.name,
            quantity: li.quantity,
            catalogObjectId: li.catalog_object_id,
            variationName: li.variation_name
        }))
    };

    if (!order.customer_id) {
        return {
            processed: false,
            reason: 'Order has no customer ID attached',
            diagnostics,
            tip: 'The sale must have a customer attached in Square POS before payment'
        };
    }

    // Process the order for loyalty via consolidated intake
    const loyaltyResult = await processLoyaltyOrder({
        order,
        merchantId,
        squareCustomerId: order.customer_id,
        source: 'manual',
        customerSource: 'order'
    });

    return {
        processed: !loyaltyResult.alreadyProcessed && loyaltyResult.purchaseEvents.length > 0,
        result: loyaltyResult,
        diagnostics
    };
}

module.exports = {
    processOrderManually
};
