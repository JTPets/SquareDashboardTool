/**
 * Delivery Stats Service
 *
 * Handles delivery-related customer info, stats, and dashboard analytics.
 * Extracted from routes/delivery.js (Package 8, A-2) so routes are thin controllers.
 *
 * Functions:
 * - getCustomerInfo: Fetch customer details from Square for a delivery order
 * - updateCustomerNote: Sync customer note to Square and local cache
 * - getCustomerStats: Order count, loyalty status, payment status for a customer
 * - getDashboardStats: Aggregate delivery stats for dashboard display
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const deliveryApi = require('./delivery-service');
const { getSquareClientForMerchant } = require('../../middleware/merchant');

/**
 * Get active Square location IDs for a merchant
 * @param {number} merchantId
 * @returns {Promise<string[]>} Array of Square location IDs
 */
async function getLocationIds(merchantId) {
    const result = await db.query(
        'SELECT square_location_id FROM locations WHERE merchant_id = $1 AND active = TRUE AND square_location_id IS NOT NULL',
        [merchantId]
    );
    if (result.rows.length === 0) {
        logger.warn('No active locations found for merchant', { merchantId });
    }
    return result.rows.map(r => r.square_location_id);
}

/**
 * Get customer info from Square for a delivery order
 * Merges Square customer data with local order data and syncs cached note
 *
 * @param {number} merchantId
 * @param {string} orderId - Delivery order ID
 * @returns {Promise<{order: object|null, customerData: object|null}>}
 */
async function getCustomerInfo(merchantId, orderId) {
    const order = await deliveryApi.getOrderById(merchantId, orderId);

    if (!order) {
        return { order: null, customerData: null };
    }

    let customerData = {
        order_notes: order.notes,
        customer_note: order.customer_note,
        square_customer_id: order.square_customer_id
    };

    if (order.square_customer_id) {
        try {
            const squareClient = await getSquareClientForMerchant(merchantId);
            const customerResponse = await squareClient.customers.get({
                customerId: order.square_customer_id
            });

            if (customerResponse.customer) {
                const customer = customerResponse.customer;
                customerData = {
                    ...customerData,
                    customer_note: customer.note || null,
                    customer_email: customer.emailAddress || customer.email_address,
                    customer_phone: customer.phoneNumber || customer.phone_number,
                    customer_name: [customer.givenName || customer.given_name, customer.familyName || customer.family_name].filter(Boolean).join(' '),
                    customer_company: customer.companyName || customer.company_name
                };

                // Update cached customer note if different
                if (customer.note !== order.customer_note) {
                    await deliveryApi.updateOrder(merchantId, order.id, {
                        customerNote: customer.note || null
                    });
                }
            }
        } catch (squareError) {
            logger.warn('Failed to fetch customer from Square', {
                error: squareError.message,
                customerId: order.square_customer_id
            });
            // Return cached data if Square fetch fails
        }
    }

    return { order, customerData };
}

/**
 * Update customer note in Square and local cache
 *
 * @param {number} merchantId
 * @param {string} orderId - Delivery order ID
 * @param {string|null} note - New customer note
 * @returns {Promise<{order: object|null, squareSynced: boolean, error: string|null}>}
 */
async function updateCustomerNote(merchantId, orderId, note) {
    const order = await deliveryApi.getOrderById(merchantId, orderId);

    if (!order) {
        return { order: null, squareSynced: false, error: 'Order not found' };
    }

    if (!order.square_customer_id) {
        return { order, squareSynced: false, error: 'No Square customer linked to this order' };
    }

    let squareSynced = false;

    try {
        const squareClient = await getSquareClientForMerchant(merchantId);

        const customerResponse = await squareClient.customers.get({
            customerId: order.square_customer_id
        });

        if (customerResponse.customer) {
            await squareClient.customers.update({
                customerId: order.square_customer_id,
                note: note || null,
                version: customerResponse.customer.version
            });
            squareSynced = true;
        }
    } catch (squareError) {
        logger.error('Failed to update customer note in Square', {
            error: squareError.message,
            customerId: order.square_customer_id
        });
    }

    // Update cached note locally
    await deliveryApi.updateOrder(merchantId, order.id, {
        customerNote: note || null
    });

    return { order, squareSynced, error: null };
}

/**
 * Resolve a Square customer ID from an order (direct or phone lookup)
 *
 * @param {object} squareClient - Square API client
 * @param {object} order - Delivery order
 * @param {number} merchantId - For logging
 * @returns {Promise<string|null>} Square customer ID or null
 */
async function resolveCustomerId(squareClient, order, merchantId) {
    if (order.square_customer_id) {
        return order.square_customer_id;
    }

    if (!order.phone) {
        return null;
    }

    try {
        logger.debug('Customer stats: No customer ID, searching by phone', {
            merchantId,
            orderId: order.id,
            phone: order.phone
        });
        const searchResult = await squareClient.customers.search({
            query: {
                filter: {
                    phoneNumber: {
                        exact: order.phone
                    }
                }
            },
            limit: BigInt(1)
        });
        if (searchResult.customers && searchResult.customers.length > 0) {
            logger.debug('Customer stats: Found customer by phone', {
                merchantId,
                orderId: order.id,
                customerId: searchResult.customers[0].id,
                customerName: searchResult.customers[0].givenName
            });
            return searchResult.customers[0].id;
        }
    } catch (searchErr) {
        logger.warn('Customer stats: Failed to search customer by phone', {
            merchantId,
            orderId: order.id,
            error: searchErr.message
        });
    }

    return null;
}

/**
 * Get customer stats for a delivery order: order count, loyalty, payment status
 *
 * @param {number} merchantId
 * @param {string} orderId - Delivery order ID
 * @returns {Promise<{order: object|null, stats: object}>}
 */
async function getCustomerStats(merchantId, orderId) {
    logger.debug('Fetching customer stats', { merchantId, orderId });

    const order = await deliveryApi.getOrderById(merchantId, orderId);

    if (!order) {
        logger.warn('Customer stats: Order not found', { merchantId, orderId });
        return { order: null, stats: null };
    }

    const stats = {
        order_count: 0,
        is_repeat_customer: false,
        is_loyalty_member: false,
        loyalty_balance: null,
        payment_status: 'unknown',
        total_amount: null,
        amount_paid: null
    };

    const squareClient = await getSquareClientForMerchant(merchantId);
    const customerId = await resolveCustomerId(squareClient, order, merchantId);

    if (!customerId) {
        logger.debug('Customer stats: No customer found, returning basic stats', {
            merchantId,
            orderId,
            customerName: order.customer_name
        });
        return { order, stats };
    }

    const locationIds = await getLocationIds(merchantId);

    if (locationIds.length === 0) {
        return { order, stats };
    }

    // Fetch order count, loyalty status, and payment info in parallel
    const [orderCountResult, loyaltyResult, squareOrderResult] = await Promise.allSettled([
        squareClient.orders.search({
            locationIds: locationIds,
            query: {
                filter: {
                    customerFilter: {
                        customerIds: [customerId]
                    },
                    stateFilter: {
                        states: ['COMPLETED']
                    }
                }
            }
        }),

        (async () => {
            try {
                const programResponse = await squareClient.loyalty.programs.get({
                    programId: 'main'
                });

                if (programResponse.program) {
                    const accountsResponse = await squareClient.loyalty.accounts.search({
                        query: {
                            customerIds: [customerId]
                        }
                    });

                    if (accountsResponse.loyaltyAccounts && accountsResponse.loyaltyAccounts.length > 0) {
                        const account = accountsResponse.loyaltyAccounts[0];
                        return {
                            isMember: true,
                            balance: Number(account.balance || 0)
                        };
                    }
                }
            } catch (loyaltyError) {
                if (!loyaltyError.message?.includes('NOT_FOUND')) {
                    logger.warn('Error checking loyalty status', { error: loyaltyError.message });
                }
            }
            return { isMember: false, balance: null };
        })(),

        order.square_order_id ? squareClient.orders.get({
            orderId: order.square_order_id
        }) : Promise.resolve(null)
    ]);

    logger.debug('Customer stats: Square API results', {
        orderId,
        orderCountStatus: orderCountResult.status,
        orderCountError: orderCountResult.status === 'rejected' ? orderCountResult.reason?.message : undefined,
        loyaltyStatus: loyaltyResult.status,
        loyaltyError: loyaltyResult.status === 'rejected' ? loyaltyResult.reason?.message : undefined,
        squareOrderStatus: squareOrderResult.status,
        squareOrderError: squareOrderResult.status === 'rejected' ? squareOrderResult.reason?.message : undefined
    });

    // Process order count
    if (orderCountResult.status === 'fulfilled' && orderCountResult.value.orders) {
        stats.order_count = orderCountResult.value.orders.length;
        stats.is_repeat_customer = stats.order_count > 1;
    }

    // Process loyalty status
    if (loyaltyResult.status === 'fulfilled') {
        stats.is_loyalty_member = loyaltyResult.value.isMember;
        stats.loyalty_balance = loyaltyResult.value.balance;
    }

    // Process payment status (BigInt conversion for Square SDK v43+)
    if (squareOrderResult.status === 'fulfilled' && squareOrderResult.value?.order) {
        const squareOrder = squareOrderResult.value.order;
        const totalMoney = Number(squareOrder.totalMoney?.amount || squareOrder.total_money?.amount || 0);
        const tenders = squareOrder.tenders || [];

        let amountPaid = 0;
        for (const tender of tenders) {
            amountPaid += Number(tender.amountMoney?.amount || tender.amount_money?.amount || 0);
        }

        stats.total_amount = totalMoney;
        stats.amount_paid = amountPaid;

        if (amountPaid >= totalMoney && totalMoney > 0) {
            stats.payment_status = 'paid';
        } else if (amountPaid > 0) {
            stats.payment_status = 'partial';
        } else {
            stats.payment_status = 'unpaid';
        }
    }

    logger.debug('Customer stats: Returning stats', { orderId, stats });
    return { order, stats };
}

/**
 * Get delivery dashboard stats: orders by status, active route info, today's completions
 *
 * @param {number} merchantId
 * @returns {Promise<object>} Dashboard stats object
 */
async function getDashboardStats(merchantId) {
    const today = new Date().toISOString().split('T')[0];

    const [statusCounts, activeRoute, todayCompletions] = await Promise.all([
        db.query(`
            SELECT status, COUNT(*) as count
            FROM delivery_orders
            WHERE merchant_id = $1
            GROUP BY status
        `, [merchantId]),

        deliveryApi.getActiveRoute(merchantId, today),

        db.query(`
            SELECT COUNT(*) as count
            FROM delivery_orders
            WHERE merchant_id = $1
              AND status = 'completed'
              AND updated_at::date = CURRENT_DATE
        `, [merchantId])
    ]);

    return {
        byStatus: statusCounts.rows.reduce((acc, row) => {
            acc[row.status] = parseInt(row.count);
            return acc;
        }, {}),
        activeRoute: activeRoute ? {
            id: activeRoute.id,
            totalStops: activeRoute.order_count,
            completedStops: activeRoute.completed_count,
            skippedStops: activeRoute.skipped_count
        } : null,
        completedToday: parseInt(todayCompletions.rows[0]?.count || 0)
    };
}

module.exports = {
    getLocationIds,
    getCustomerInfo,
    updateCustomerNote,
    resolveCustomerId,
    getCustomerStats,
    getDashboardStats
};
