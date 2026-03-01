/**
 * Order Processing Service
 *
 * Fetches a single order from Square and processes it for loyalty.
 * Used for manual processing/debugging when webhooks aren't working.
 *
 * Extracted from routes/loyalty/processing.js POST /process-order (A-13)
 * — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - Uses raw fetch() instead of squareClient SDK (pre-dates SDK standardization)
 * - Original had duplicate `const merchantId` declaration (line 76 shadowed line 48) — fixed in extraction
 * - Hardcoded Square-Version header ('2024-01-18') instead of config/constants
 */

const logger = require('../../utils/logger');
const { getSquareAccessToken } = require('./shared-utils');
const { getCustomerDetails } = require('./customer-admin-service');
const { processOrderForLoyalty } = require('./webhook-processing-service');

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

    // Get access token
    const accessToken = await getSquareAccessToken(merchantId);
    if (!accessToken) {
        const error = new Error('No Square access token configured for this merchant');
        error.statusCode = 400;
        throw error;
    }

    // Fetch the order from Square using raw API
    const orderResponse = await fetch(`https://connect.squareup.com/v2/orders/${squareOrderId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-18'
        }
    });

    if (!orderResponse.ok) {
        const errText = await orderResponse.text();
        logger.error('Square API error in loyalty order lookup', {
            status: orderResponse.status,
            error: errText,
            merchantId,
            squareOrderId
        });
        const error = new Error('Unable to retrieve order details. Please try again.');
        error.statusCode = 502;
        error.code = 'EXTERNAL_API_ERROR';
        throw error;
    }

    const orderData = await orderResponse.json();
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

    // Process the order for loyalty
    const loyaltyResult = await processOrderForLoyalty(order, merchantId);

    return {
        processed: loyaltyResult.processed,
        result: loyaltyResult,
        diagnostics
    };
}

module.exports = {
    processOrderManually
};
