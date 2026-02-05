/**
 * Loyalty Customer Admin Service
 *
 * Handles customer lookup, status queries, and history retrieval.
 * Includes multiple fallback methods to identify customers from orders.
 *
 * Customer identification priority:
 * 1. Direct order.customer_id
 * 2. Tender customer_id
 * 3. Square Loyalty API lookup
 * 4. Order rewards lookup
 * 5. Fulfillment recipient (phone/email)
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../loyalty/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken } = require('./shared-utils');
const { cacheCustomerDetails, getCachedCustomer } = require('./customer-cache-service');

/**
 * Get customer details, using cache first then Square API
 * @param {string} customerId - Square customer ID
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Customer details or null
 */
async function getCustomerDetails(customerId, merchantId) {
    if (!customerId || !merchantId) {
        return null;
    }

    try {
        // First, check local cache
        const cachedCustomer = await getCachedCustomer(customerId, merchantId);
        if (cachedCustomer) {
            logger.debug('Using cached customer details', { customerId });
            return cachedCustomer;
        }

        // Not in cache, fetch from Square API
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return null;
        }

        const customerStartTime = Date.now();
        const response = await fetchWithTimeout(`https://connect.squareup.com/v2/customers/${customerId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            }
        }, 10000);
        const customerDuration = Date.now() - customerStartTime;

        loyaltyLogger.squareApi({
            endpoint: `/customers/${customerId}`,
            method: 'GET',
            status: response.status,
            duration: customerDuration,
            success: response.ok,
            merchantId,
        });

        if (!response.ok) {
            logger.debug('Failed to fetch customer details', { customerId, status: response.status });
            return null;
        }

        const data = await response.json();
        const customer = data.customer;

        if (!customer) {
            return null;
        }

        const customerDetails = {
            id: customer.id,
            givenName: customer.given_name || null,
            familyName: customer.family_name || null,
            displayName: [customer.given_name, customer.family_name].filter(Boolean).join(' ') || customer.company_name || null,
            email: customer.email_address || null,
            phone: customer.phone_number || null,
            companyName: customer.company_name || null,
            createdAt: customer.created_at,
            updatedAt: customer.updated_at
        };

        // Cache for future lookups
        await cacheCustomerDetails(customerDetails, merchantId);

        return customerDetails;

    } catch (error) {
        logger.error('Error fetching customer details', { error: error.message, customerId });
        return null;
    }
}

/**
 * Look up customer from Square Loyalty API by order ID
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<string|null>} customer_id if found, null otherwise
 */
async function lookupCustomerFromLoyalty(orderId, merchantId) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return null;
        }

        // Search for loyalty events by order_id
        const eventsStartTime = Date.now();
        const eventsResponse = await fetchWithTimeout('https://connect.squareup.com/v2/loyalty/events/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify({
                query: {
                    filter: {
                        order_filter: {
                            order_id: orderId
                        }
                    }
                },
                limit: 10
            })
        }, 10000);
        const eventsDuration = Date.now() - eventsStartTime;

        loyaltyLogger.squareApi({
            endpoint: '/loyalty/events/search',
            method: 'POST',
            status: eventsResponse.status,
            duration: eventsDuration,
            success: eventsResponse.ok,
            merchantId,
            context: 'lookupCustomerFromLoyalty',
        });

        let loyaltyAccountId = null;

        if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json();
            const events = eventsData.events || [];

            if (events.length > 0) {
                loyaltyAccountId = events[0].loyalty_account_id;
                logger.debug('Found loyalty event by order_id', { orderId, loyaltyAccountId });
            }
        }

        if (!loyaltyAccountId) {
            logger.debug('No loyalty events found for order', { orderId });
            return null;
        }

        // Fetch the loyalty account to get the customer_id
        const acctStartTime = Date.now();
        const accountResponse = await fetchWithTimeout(`https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            }
        }, 10000);
        const acctDuration = Date.now() - acctStartTime;

        loyaltyLogger.squareApi({
            endpoint: `/loyalty/accounts/${loyaltyAccountId}`,
            method: 'GET',
            status: accountResponse.status,
            duration: acctDuration,
            success: accountResponse.ok,
            merchantId,
            context: 'lookupCustomerFromLoyalty',
        });

        if (!accountResponse.ok) {
            logger.debug('Failed to fetch loyalty account', { loyaltyAccountId });
            return null;
        }

        const accountData = await accountResponse.json();
        const customerId = accountData.loyalty_account?.customer_id;

        if (customerId) {
            logger.info('Found customer via loyalty lookup', {
                orderId,
                loyaltyAccountId,
                customerId
            });
        }

        return customerId || null;

    } catch (error) {
        logger.error('Error in loyalty customer lookup', {
            error: error.message,
            orderId,
            merchantId
        });
        return null;
    }
}

/**
 * Look up customer by phone/email from fulfillment recipient
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<string|null>} customer_id if found, null otherwise
 */
async function lookupCustomerFromFulfillmentRecipient(order, merchantId) {
    try {
        const fulfillments = order.fulfillments || [];
        if (fulfillments.length === 0) {
            return null;
        }

        let phoneNumber = null;
        let emailAddress = null;

        for (const fulfillment of fulfillments) {
            // Check delivery details
            const deliveryDetails = fulfillment.delivery_details || fulfillment.deliveryDetails;
            if (deliveryDetails?.recipient) {
                phoneNumber = phoneNumber || deliveryDetails.recipient.phone_number || deliveryDetails.recipient.phoneNumber;
                emailAddress = emailAddress || deliveryDetails.recipient.email_address || deliveryDetails.recipient.emailAddress;
            }

            // Check shipment details
            const shipmentDetails = fulfillment.shipment_details || fulfillment.shipmentDetails;
            if (shipmentDetails?.recipient) {
                phoneNumber = phoneNumber || shipmentDetails.recipient.phone_number || shipmentDetails.recipient.phoneNumber;
                emailAddress = emailAddress || shipmentDetails.recipient.email_address || shipmentDetails.recipient.emailAddress;
            }

            // Check pickup details
            const pickupDetails = fulfillment.pickup_details || fulfillment.pickupDetails;
            if (pickupDetails?.recipient) {
                phoneNumber = phoneNumber || pickupDetails.recipient.phone_number || pickupDetails.recipient.phoneNumber;
                emailAddress = emailAddress || pickupDetails.recipient.email_address || pickupDetails.recipient.emailAddress;
            }
        }

        if (!phoneNumber && !emailAddress) {
            return null;
        }

        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return null;
        }

        // Search by phone number first (more reliable)
        if (phoneNumber) {
            const normalizedPhone = phoneNumber.replace(/[^\d+]/g, '');
            const searchResponse = await fetchWithTimeout('https://connect.squareup.com/v2/customers/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                },
                body: JSON.stringify({
                    query: {
                        filter: {
                            phone_number: {
                                exact: normalizedPhone
                            }
                        }
                    },
                    limit: 1
                })
            }, 10000);

            if (searchResponse.ok) {
                const searchData = await searchResponse.json();
                const customers = searchData.customers || [];
                if (customers.length > 0) {
                    return customers[0].id;
                }
            }
        }

        // Fallback: Search by email
        if (emailAddress) {
            const searchResponse = await fetchWithTimeout('https://connect.squareup.com/v2/customers/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                },
                body: JSON.stringify({
                    query: {
                        filter: {
                            email_address: {
                                exact: emailAddress.toLowerCase()
                            }
                        }
                    },
                    limit: 1
                })
            }, 10000);

            if (searchResponse.ok) {
                const searchData = await searchResponse.json();
                const customers = searchData.customers || [];
                if (customers.length > 0) {
                    return customers[0].id;
                }
            }
        }

        return null;
    } catch (error) {
        logger.error('Error looking up customer from fulfillment', {
            error: error.message,
            orderId: order.id,
            merchantId
        });
        return null;
    }
}

/**
 * Look up customer from order rewards (Square Loyalty redemptions)
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<string|null>} customer_id if found, null otherwise
 */
async function lookupCustomerFromOrderRewards(order, merchantId) {
    try {
        const rewards = order.rewards || [];
        if (rewards.length === 0) {
            return null;
        }

        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return null;
        }

        // Search for loyalty events linked to this order
        const eventsResponse = await fetchWithTimeout('https://connect.squareup.com/v2/loyalty/events/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify({
                query: {
                    filter: {
                        order_filter: {
                            order_id: order.id
                        }
                    }
                },
                limit: 10
            })
        }, 10000);

        if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json();
            const events = eventsData.events || [];

            for (const event of events) {
                if (event.loyalty_account_id) {
                    const accountResponse = await fetchWithTimeout(
                        `https://connect.squareup.com/v2/loyalty/accounts/${event.loyalty_account_id}`,
                        {
                            method: 'GET',
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/json',
                                'Square-Version': '2025-01-16'
                            }
                        },
                        10000
                    );

                    if (accountResponse.ok) {
                        const accountData = await accountResponse.json();
                        const customerId = accountData.loyalty_account?.customer_id;
                        if (customerId) {
                            return customerId;
                        }
                    }
                }
            }
        }

        return null;
    } catch (error) {
        logger.error('Error looking up customer from order rewards', {
            error: error.message,
            orderId: order.id,
            merchantId
        });
        return null;
    }
}

/**
 * Get loyalty status for a customer across all offers
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Customer loyalty status across all offers
 */
async function getCustomerLoyaltyStatus(squareCustomerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const result = await db.query(`
        SELECT
            o.id as offer_id,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.required_quantity,
            o.window_months,
            COALESCE(cs.current_quantity, 0) as current_quantity,
            cs.window_start_date,
            cs.window_end_date,
            cs.has_earned_reward,
            cs.earned_reward_id,
            cs.total_lifetime_purchases,
            cs.total_rewards_earned,
            cs.total_rewards_redeemed,
            cs.last_purchase_at
        FROM loyalty_offers o
        LEFT JOIN loyalty_customer_summary cs
            ON o.id = cs.offer_id
            AND cs.square_customer_id = $2
            AND cs.merchant_id = $1
        WHERE o.merchant_id = $1 AND o.is_active = TRUE
        ORDER BY o.brand_name, o.size_group
    `, [merchantId, squareCustomerId]);

    return {
        squareCustomerId,
        offers: result.rows
    };
}

/**
 * Get full loyalty history for a customer
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=50] - Maximum records per type
 * @param {number} [options.offerId] - Filter by specific offer
 * @returns {Promise<Object>} Customer history with purchases, rewards, redemptions
 */
async function getCustomerLoyaltyHistory(squareCustomerId, merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { limit = 50, offerId = null } = options;

    // Get purchase events
    let purchaseQuery = `
        SELECT pe.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_purchase_events pe
        JOIN loyalty_offers o ON pe.offer_id = o.id
        WHERE pe.merchant_id = $1 AND pe.square_customer_id = $2
    `;
    const purchaseParams = [merchantId, squareCustomerId];

    if (offerId) {
        purchaseQuery += ` AND pe.offer_id = $${purchaseParams.length + 1}`;
        purchaseParams.push(offerId);
    }

    purchaseQuery += ` ORDER BY pe.purchased_at DESC LIMIT $${purchaseParams.length + 1}`;
    purchaseParams.push(limit);

    // Get rewards
    let rewardQuery = `
        SELECT r.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1 AND r.square_customer_id = $2
    `;
    const rewardParams = [merchantId, squareCustomerId];

    if (offerId) {
        rewardQuery += ` AND r.offer_id = $${rewardParams.length + 1}`;
        rewardParams.push(offerId);
    }

    rewardQuery += ` ORDER BY r.created_at DESC`;

    // Get redemptions
    let redemptionQuery = `
        SELECT
            r.id,
            r.merchant_id,
            r.offer_id,
            r.square_customer_id,
            r.redeemed_at,
            r.redemption_order_id as square_order_id,
            o.offer_name,
            o.brand_name,
            o.size_group,
            pe_info.item_name as redeemed_item_name,
            pe_info.variation_name as redeemed_variation_name,
            pe_info.avg_price as redeemed_value_cents
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        LEFT JOIN LATERAL (
            SELECT
                lqv.item_name,
                lqv.variation_name,
                AVG(pe.unit_price_cents) FILTER (WHERE pe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events pe
            LEFT JOIN loyalty_qualifying_variations lqv
                ON pe.variation_id = lqv.variation_id AND pe.offer_id = lqv.offer_id
            WHERE pe.reward_id = r.id
            GROUP BY lqv.item_name, lqv.variation_name
            LIMIT 1
        ) pe_info ON true
        WHERE r.merchant_id = $1
          AND r.square_customer_id = $2
          AND r.status = 'redeemed'
    `;
    const redemptionParams = [merchantId, squareCustomerId];

    if (offerId) {
        redemptionQuery += ` AND r.offer_id = $${redemptionParams.length + 1}`;
        redemptionParams.push(offerId);
    }

    redemptionQuery += ` ORDER BY r.redeemed_at DESC`;

    const [purchases, rewards, redemptions] = await Promise.all([
        db.query(purchaseQuery, purchaseParams),
        db.query(rewardQuery, rewardParams),
        db.query(redemptionQuery, redemptionParams)
    ]);

    return {
        squareCustomerId,
        purchases: purchases.rows,
        rewards: rewards.rows,
        redemptions: redemptions.rows
    };
}

/**
 * Get customer's earned (available) rewards
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Array>} Array of earned rewards
 */
async function getCustomerEarnedRewards(squareCustomerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const result = await db.query(`
        SELECT r.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1
          AND r.square_customer_id = $2
          AND r.status = 'earned'
        ORDER BY r.earned_at DESC
    `, [merchantId, squareCustomerId]);

    return result.rows;
}

module.exports = {
    getCustomerDetails,
    lookupCustomerFromLoyalty,
    lookupCustomerFromFulfillmentRecipient,
    lookupCustomerFromOrderRewards,
    getCustomerLoyaltyStatus,
    getCustomerLoyaltyHistory,
    getCustomerEarnedRewards
};
