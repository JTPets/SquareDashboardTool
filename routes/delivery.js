/**
 * Delivery Routes
 *
 * Handles delivery order management including:
 * - Order listing, creation, and updates
 * - Proof of delivery (POD) photo uploads
 * - Route optimization and management
 * - Customer info and stats from Square
 * - Delivery settings configuration
 * - Order sync from Square
 *
 * SECURITY CONSIDERATIONS:
 * - All endpoints require authentication
 * - All endpoints require merchant context (multi-tenant isolation)
 * - Rate limiting applied to write operations
 * - Strict rate limiting on geocoding and route generation
 * - File upload validation for POD photos
 *
 * Endpoints:
 * - GET    /api/delivery/orders                    - List delivery orders
 * - POST   /api/delivery/orders                    - Create manual order
 * - GET    /api/delivery/orders/:id                - Get single order
 * - PATCH  /api/delivery/orders/:id                - Update order
 * - DELETE /api/delivery/orders/:id                - Delete manual order
 * - POST   /api/delivery/orders/:id/skip           - Mark order as skipped
 * - POST   /api/delivery/orders/:id/complete       - Mark order as completed
 * - GET    /api/delivery/orders/:id/customer       - Get customer info
 * - PATCH  /api/delivery/orders/:id/customer-note  - Update customer note
 * - PATCH  /api/delivery/orders/:id/notes          - Update order notes
 * - GET    /api/delivery/orders/:id/customer-stats - Get customer stats
 * - POST   /api/delivery/orders/:id/pod            - Upload POD photo
 * - GET    /api/delivery/pod/:id                   - Serve POD photo
 * - POST   /api/delivery/route/generate            - Generate optimized route
 * - GET    /api/delivery/route/active              - Get active route
 * - GET    /api/delivery/route/:id                 - Get specific route
 * - POST   /api/delivery/route/finish              - Finish active route
 * - POST   /api/delivery/geocode                   - Geocode pending orders
 * - GET    /api/delivery/settings                  - Get delivery settings
 * - PUT    /api/delivery/settings                  - Update delivery settings
 * - GET    /api/delivery/audit                     - Get audit log
 * - GET    /api/delivery/stats                     - Get delivery statistics
 * - POST   /api/delivery/sync                      - Sync orders from Square
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../utils/database');
const logger = require('../utils/logger');
const deliveryApi = require('../utils/delivery-api');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant, getSquareClientForMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const { configureDeliveryRateLimit, configureDeliveryStrictRateLimit } = require('../middleware/security');
const { validateUploadedImage } = require('../utils/file-validation');
const validators = require('../middleware/validators/delivery');

// Rate limiters
const deliveryRateLimit = configureDeliveryRateLimit();
const deliveryStrictRateLimit = configureDeliveryStrictRateLimit();

// Configure multer for POD photo uploads
const podUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max
    },
    fileFilter: (req, file, cb) => {
        // Only accept images
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

/**
 * Helper to get Square location IDs for a merchant
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
 * GET /api/delivery/orders
 * List delivery orders with optional filtering
 */
router.get('/orders', requireAuth, requireMerchant, validators.listOrders, asyncHandler(async (req, res) => {
    const { status, routeDate, routeId, dateFrom, dateTo, includeCompleted, limit, offset } = req.query;
    const merchantId = req.merchantContext.id;

    const orders = await deliveryApi.getOrders(merchantId, {
        status: status ? status.split(',') : null,
        routeDate,
        routeId,
        dateFrom,
        dateTo,
        includeCompleted: includeCompleted === 'true',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });

    res.json({ orders });
}));

/**
 * POST /api/delivery/orders
 * Create a manual delivery order
 */
router.post('/orders', deliveryRateLimit, requireAuth, requireMerchant, validators.createOrder, asyncHandler(async (req, res) => {
    const { customerName, address, phone, notes } = req.body;
    const merchantId = req.merchantContext.id;

    if (!customerName || !address) {
        return res.status(400).json({ error: 'Customer name and address are required' });
    }

    const order = await deliveryApi.createOrder(merchantId, {
        customerName,
        address,
        phone,
        notes
    });

    // Attempt geocoding
    const settings = await deliveryApi.getSettings(merchantId);
    const coords = await deliveryApi.geocodeAddress(address, settings?.openrouteservice_api_key);

    if (coords) {
        await deliveryApi.updateOrder(merchantId, order.id, {
            addressLat: coords.lat,
            addressLng: coords.lng,
            geocodedAt: new Date()
        });
        order.address_lat = coords.lat;
        order.address_lng = coords.lng;
        order.geocoded_at = new Date();
    }

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_created', order.id, null, {
        manual: true,
        customerName
    });

    res.status(201).json({ order });
}));

/**
 * GET /api/delivery/orders/:id
 * Get a single delivery order
 */
router.get('/orders/:id', requireAuth, requireMerchant, validators.getOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order });
}));

/**
 * PATCH /api/delivery/orders/:id
 * Update a delivery order (notes, status)
 */
router.patch('/orders/:id', requireAuth, requireMerchant, validators.updateOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const updates = {};

    // Only allow updating certain fields
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.phone !== undefined) updates.phone = req.body.phone;
    if (req.body.customerName !== undefined) updates.customerName = req.body.customerName;
    if (req.body.address !== undefined) updates.address = req.body.address;

    const order = await deliveryApi.updateOrder(merchantId, req.params.id, updates);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    // Re-geocode if address changed
    if (req.body.address) {
        const settings = await deliveryApi.getSettings(merchantId);
        const coords = await deliveryApi.geocodeAddress(req.body.address, settings?.openrouteservice_api_key);

        if (coords) {
            await deliveryApi.updateOrder(merchantId, order.id, {
                addressLat: coords.lat,
                addressLng: coords.lng,
                geocodedAt: new Date()
            });
        }
    }

    res.json({ order });
}));

/**
 * DELETE /api/delivery/orders/:id
 * Delete a manual delivery order (only allowed for manual orders not on route)
 */
router.delete('/orders/:id', requireAuth, requireMerchant, validators.deleteOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const deleted = await deliveryApi.deleteOrder(merchantId, req.params.id);

    if (!deleted) {
        return res.status(400).json({
            error: 'Cannot delete this order. Only manual orders not yet delivered can be deleted.'
        });
    }

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_deleted', req.params.id);

    res.json({ success: true });
}));

/**
 * POST /api/delivery/orders/:id/skip
 * Mark an order as skipped (driver couldn't deliver)
 */
router.post('/orders/:id/skip', requireAuth, requireMerchant, validators.skipOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.skipOrder(merchantId, req.params.id, req.session.user.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order });
}));

/**
 * POST /api/delivery/orders/:id/complete
 * Mark an order as completed and sync to Square
 */
router.post('/orders/:id/complete', requireAuth, requireMerchant, validators.completeOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    let squareSynced = false;
    let squareSyncError = null;

    // If Square order, sync fulfillment completion to Square
    if (order.square_order_id) {
        try {
                const squareClient = await getSquareClientForMerchant(merchantId);

                // First, get the current order to find fulfillment UID and version
                let squareOrder = await squareClient.orders.get({
                    orderId: order.square_order_id
                });

                if (squareOrder.order && squareOrder.order.fulfillments) {
                    // Find ALL delivery/shipment/pickup fulfillments (not just the first one)
                    // Orders may have multiple fulfillments that all need to be completed
                    const deliveryFulfillments = squareOrder.order.fulfillments.filter(f =>
                        f.type === 'DELIVERY' || f.type === 'SHIPMENT' || f.type === 'PICKUP'
                    );

                    // Fall back to all fulfillments if no delivery-specific ones found
                    const fulfillmentsToComplete = deliveryFulfillments.length > 0
                        ? deliveryFulfillments
                        : squareOrder.order.fulfillments;

                    if (fulfillmentsToComplete.length > 0) {
                        logger.info('Found fulfillments to complete', {
                            orderId: order.id,
                            squareOrderId: order.square_order_id,
                            fulfillmentCount: fulfillmentsToComplete.length,
                            fulfillments: fulfillmentsToComplete.map(f => ({ uid: f.uid, type: f.type, state: f.state }))
                        });

                        // Define the state transition order
                        // Square requires stepping through states: PROPOSED → RESERVED → PREPARED → COMPLETED
                        const stateOrder = ['PROPOSED', 'RESERVED', 'PREPARED', 'COMPLETED'];
                        const completedAt = new Date().toISOString();
                        let allFulfillmentsCompleted = true;

                        // Process each fulfillment
                        for (const initialFulfillment of fulfillmentsToComplete) {
                            let fulfillment = initialFulfillment;
                            const currentStateIndex = stateOrder.indexOf(fulfillment.state);

                            if (fulfillment.state === 'COMPLETED') {
                                logger.info('Fulfillment already completed', {
                                    orderId: order.id,
                                    fulfillmentUid: fulfillment.uid
                                });
                                continue; // Already completed
                            } else if (currentStateIndex >= 0) {
                                // Need to transition through each state to reach COMPLETED
                                for (let i = currentStateIndex + 1; i < stateOrder.length; i++) {
                                    const nextState = stateOrder[i];

                                    // Re-fetch to get current version (required for optimistic concurrency)
                                    squareOrder = await squareClient.orders.get({
                                        orderId: order.square_order_id
                                    });

                                    // Re-find fulfillment (version may have changed)
                                    fulfillment = squareOrder.order.fulfillments.find(f => f.uid === initialFulfillment.uid);

                                    if (!fulfillment) {
                                        throw new Error(`Fulfillment ${initialFulfillment.uid} not found after re-fetch`);
                                    }

                                    logger.info('Transitioning fulfillment state', {
                                        orderId: order.id,
                                        fulfillmentUid: fulfillment.uid,
                                        from: fulfillment.state,
                                        to: nextState
                                    });

                                    // Build the fulfillment update object
                                    const fulfillmentUpdate = {
                                        uid: fulfillment.uid,
                                        state: nextState
                                    };

                                    // Add deliveredAt timestamp when transitioning to COMPLETED
                                    // This is important for proper order archival in Square Dashboard
                                    if (nextState === 'COMPLETED') {
                                        if (fulfillment.type === 'DELIVERY') {
                                            fulfillmentUpdate.deliveryDetails = {
                                                ...fulfillment.deliveryDetails,
                                                deliveredAt: completedAt
                                            };
                                        } else if (fulfillment.type === 'SHIPMENT') {
                                            fulfillmentUpdate.shipmentDetails = {
                                                ...fulfillment.shipmentDetails,
                                                shippedAt: completedAt
                                            };
                                        } else if (fulfillment.type === 'PICKUP') {
                                            fulfillmentUpdate.pickupDetails = {
                                                ...fulfillment.pickupDetails,
                                                pickedUpAt: completedAt
                                            };
                                        }
                                    }

                                    await squareClient.orders.update({
                                        orderId: order.square_order_id,
                                        order: {
                                            locationId: squareOrder.order.locationId,
                                            version: squareOrder.order.version,
                                            fulfillments: [fulfillmentUpdate]
                                        },
                                        idempotencyKey: `complete-${order.id}-${fulfillment.uid}-${nextState}-${Date.now()}`
                                    });
                                }

                                logger.info('Fulfillment completed', {
                                    orderId: order.id,
                                    fulfillmentUid: initialFulfillment.uid,
                                    fulfillmentType: initialFulfillment.type
                                });
                            } else {
                                // Unknown state (CANCELED, FAILED, etc.)
                                logger.warn('Fulfillment in unexpected state, skipping', {
                                    orderId: order.id,
                                    fulfillmentUid: fulfillment.uid,
                                    state: fulfillment.state
                                });
                                allFulfillmentsCompleted = false;
                            }
                        }

                        // After completing all fulfillments, update the order state to COMPLETED
                        // This is critical - without this, the order may disappear from Square Dashboard
                        // because fulfillment.state=COMPLETED but order.state remains OPEN
                        if (allFulfillmentsCompleted) {
                            // Re-fetch to get the latest version after fulfillment updates
                            squareOrder = await squareClient.orders.get({
                                orderId: order.square_order_id
                            });

                            // Only update order state if it's not already COMPLETED
                            if (squareOrder.order.state !== 'COMPLETED') {
                                logger.info('Updating order state to COMPLETED', {
                                    orderId: order.id,
                                    squareOrderId: order.square_order_id,
                                    currentState: squareOrder.order.state
                                });

                                await squareClient.orders.update({
                                    orderId: order.square_order_id,
                                    order: {
                                        locationId: squareOrder.order.locationId,
                                        version: squareOrder.order.version,
                                        state: 'COMPLETED'
                                    },
                                    idempotencyKey: `complete-order-${order.id}-${Date.now()}`
                                });

                                logger.info('Order state updated to COMPLETED', {
                                    orderId: order.id,
                                    squareOrderId: order.square_order_id
                                });
                            }
                        }

                        squareSynced = true;
                        logger.info('Synced delivery completion to Square', {
                            merchantId,
                            orderId: order.id,
                            squareOrderId: order.square_order_id,
                            fulfillmentsCompleted: fulfillmentsToComplete.length,
                            orderStateUpdated: allFulfillmentsCompleted
                        });
                    }
                } else {
                    logger.warn('Square order has no fulfillments', {
                        orderId: order.id,
                        squareOrderId: order.square_order_id
                    });
                }
            } catch (squareError) {
                squareSyncError = squareError.message;
                logger.error('Failed to sync completion to Square', {
                    error: squareError.message,
                    orderId: order.id,
                    squareOrderId: order.square_order_id
                });
                // Continue anyway - mark as complete locally
            }
        }

        const completedOrder = await deliveryApi.completeOrder(merchantId, req.params.id, req.session.user.id);

        res.json({
        order: completedOrder,
        square_synced: squareSynced,
        square_sync_error: squareSyncError
    });
}));

/**
 * GET /api/delivery/orders/:id/customer
 * Get customer info and notes from Square
 */
router.get('/orders/:id/customer', requireAuth, requireMerchant, validators.getOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    let customerData = {
        order_notes: order.notes,        // Order-specific notes from Square
        customer_note: order.customer_note,  // Cached customer note
        square_customer_id: order.square_customer_id
    };

    // If we have a Square customer ID, fetch fresh data from Square
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

    res.json(customerData);
}));

/**
 * PATCH /api/delivery/orders/:id/customer-note
 * Update customer note (syncs to Square)
 */
router.patch('/orders/:id/customer-note', deliveryRateLimit, requireAuth, requireMerchant, validators.updateCustomerNote, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { note } = req.body;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.square_customer_id) {
        return res.status(400).json({ error: 'No Square customer linked to this order' });
    }

    let squareSynced = false;

    // Update customer note in Square
    try {
            const squareClient = await getSquareClientForMerchant(merchantId);

            // First get current customer to get version
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

    res.json({
        success: true,
        square_synced: squareSynced,
        customer_note: note
    });
}));

/**
 * PATCH /api/delivery/orders/:id/notes
 * Update order notes (local only - order-specific instructions)
 */
router.patch('/orders/:id/notes', deliveryRateLimit, requireAuth, requireMerchant, validators.updateOrderNotes, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { notes } = req.body;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    await deliveryApi.updateOrder(merchantId, order.id, {
        notes: notes || null
    });

    res.json({
        success: true,
        notes: notes
    });
}));

/**
 * GET /api/delivery/orders/:id/customer-stats
 * Get customer stats: order count, loyalty status, payment status
 */
router.get('/orders/:id/customer-stats', requireAuth, requireMerchant, validators.getOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const orderId = req.params.id;

        logger.debug('Fetching customer stats', { merchantId, orderId });

        const order = await deliveryApi.getOrderById(merchantId, orderId);

        if (!order) {
            logger.warn('Customer stats: Order not found', { merchantId, orderId });
            return res.status(404).json({ error: 'Order not found' });
        }

        const stats = {
            order_count: 0,
            is_repeat_customer: false,
            is_loyalty_member: false,
            loyalty_balance: null,
            payment_status: 'unknown', // 'paid', 'unpaid', 'partial'
            total_amount: null,
            amount_paid: null
        };

        const squareClient = await getSquareClientForMerchant(merchantId);

        // If no Square customer ID, try to look up by phone number
        let customerId = order.square_customer_id;
        if (!customerId && order.phone) {
            try {
                logger.debug('Customer stats: No customer ID, searching by phone', {
                    merchantId,
                    orderId,
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
                    customerId = searchResult.customers[0].id;
                    logger.debug('Customer stats: Found customer by phone', {
                        merchantId,
                        orderId,
                        customerId,
                        customerName: searchResult.customers[0].givenName
                    });
                }
            } catch (searchErr) {
                logger.warn('Customer stats: Failed to search customer by phone', {
                    merchantId,
                    orderId,
                    error: searchErr.message
                });
            }
        }

        // If still no customer ID, return basic stats
        if (!customerId) {
            logger.debug('Customer stats: No customer found, returning basic stats', {
                merchantId,
                orderId,
                customerName: order.customer_name
            });
            return res.json(stats);
        }

        // Get active location IDs for this merchant
        const locationIds = await getLocationIds(merchantId);

        if (locationIds.length === 0) {
            logger.warn('No active locations found for merchant', { merchantId });
            return res.json(stats);
        }

        // Fetch order count, loyalty status, and payment info in parallel
        const [orderCountResult, loyaltyResult, squareOrderResult] = await Promise.allSettled([
            // Count previous orders by this customer
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

            // Check loyalty status
            (async () => {
                try {
                    // Use 'main' keyword to retrieve the seller's loyalty program
                    // Square SDK v43+ uses .get() not .retrieve()
                    const programResponse = await squareClient.loyalty.programs.get({
                        programId: 'main'
                    });

                    if (programResponse.program) {
                        // Search for loyalty account by customer ID
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
                    // 404 means seller doesn't have a loyalty program - that's fine
                    if (!loyaltyError.message?.includes('NOT_FOUND')) {
                        logger.warn('Error checking loyalty status', { error: loyaltyError.message });
                    }
                }
                return { isMember: false, balance: null };
            })(),

            // Get Square order for payment status
            order.square_order_id ? squareClient.orders.get({
                orderId: order.square_order_id
            }) : Promise.resolve(null)
        ]);

        // Log results of parallel fetches
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

        // Process payment status
        // Note: Square SDK v43+ returns BigInt for money amounts, must convert to Number
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
    res.json(stats);
}));

/**
 * POST /api/delivery/orders/:id/pod
 * Upload proof of delivery photo
 */
router.post('/orders/:id/pod', deliveryRateLimit, requireAuth, requireMerchant, podUpload.single('photo'), validateUploadedImage('photo'), validators.uploadPod, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    if (!req.file) {
        return res.status(400).json({ error: 'No photo uploaded' });
    }

    const pod = await deliveryApi.savePodPhoto(merchantId, req.params.id, req.file.buffer, {
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
        longitude: req.body.longitude ? parseFloat(req.body.longitude) : null
    });

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'pod_uploaded', req.params.id, null, {
        podId: pod.id,
        hasGps: !!(req.body.latitude && req.body.longitude)
    });

    res.status(201).json({ pod });
}));

/**
 * GET /api/delivery/pod/:id
 * Serve a POD photo (authenticated)
 */
router.get('/pod/:id', requireAuth, requireMerchant, validators.getPod, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const pod = await deliveryApi.getPodPhoto(merchantId, req.params.id);

    if (!pod) {
        return res.status(404).json({ error: 'POD not found' });
    }

    // Serve the file
    const fsSync = require('fs');
    if (!fsSync.existsSync(pod.full_path)) {
        return res.status(404).json({ error: 'POD file not found' });
    }

    res.setHeader('Content-Type', pod.mime_type || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${pod.original_filename || 'pod.jpg'}"`);
    res.sendFile(pod.full_path);
}));

/**
 * POST /api/delivery/route/generate
 * Generate an optimized route for pending orders
 */
router.post('/route/generate', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.generateRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { routeDate, orderIds, force } = req.body;

    const route = await deliveryApi.generateRoute(merchantId, req.session.user.id, {
        routeDate,
        orderIds,
        force
    });

    res.status(201).json({ route });
}));

/**
 * GET /api/delivery/route/active
 * Get today's active route with orders
 */
router.get('/route/active', requireAuth, requireMerchant, validators.getActiveRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { routeDate } = req.query;

    logger.debug('Fetching active delivery route', { merchantId, routeDate });

    const route = await deliveryApi.getActiveRoute(merchantId, routeDate);

    if (!route) {
        return res.json({ route: null, orders: [] });
    }

    // Use getRouteWithOrders to get orders with GTIN enrichment
    const routeWithOrders = await deliveryApi.getRouteWithOrders(merchantId, route.id);
    const orders = routeWithOrders?.orders || [];

    logger.debug('Active route fetched', {
        merchantId,
        routeId: route.id,
        orderCount: orders.length,
        ordersWithItems: orders.filter(o => o.square_order_data?.lineItems?.length > 0).length
    });

    res.json({ route, orders });
}));

/**
 * GET /api/delivery/route/:id
 * Get a specific route with orders
 */
router.get('/route/:id', requireAuth, requireMerchant, validators.getRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const routeId = req.params.id;

    logger.debug('Fetching delivery route', { merchantId, routeId });

    const route = await deliveryApi.getRouteWithOrders(merchantId, routeId);

    if (!route) {
        logger.warn('Route not found', { merchantId, routeId });
        return res.status(404).json({ error: 'Route not found' });
    }

    logger.debug('Route fetched successfully', {
        merchantId,
        routeId,
        orderCount: route.orders?.length || 0
    });

    res.json({ route });
}));

/**
 * POST /api/delivery/route/finish
 * Finish the active route and roll skipped orders back to pending
 */
router.post('/route/finish', requireAuth, requireMerchant, validators.finishRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { routeId } = req.body;

    let targetRouteId = routeId;
    if (!targetRouteId) {
        // Get active route for today
        const activeRoute = await deliveryApi.getActiveRoute(merchantId);
        if (!activeRoute) {
            return res.status(400).json({ error: 'No active route found' });
        }
        targetRouteId = activeRoute.id;
    }

    const result = await deliveryApi.finishRoute(merchantId, targetRouteId, req.session.user.id);

    res.json({ result });
}));

/**
 * POST /api/delivery/geocode
 * Geocode pending orders that don't have coordinates
 */
router.post('/geocode', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.geocode, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { limit } = req.body;

    const result = await deliveryApi.geocodePendingOrders(merchantId, limit || 10);

    res.json({ result });
}));

/**
 * GET /api/delivery/settings
 * Get delivery settings for the merchant
 */
router.get('/settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    let settings = await deliveryApi.getSettings(merchantId);

    // Return defaults if no settings exist
    if (!settings) {
        settings = {
            merchant_id: merchantId,
            start_address: null,
            end_address: null,
            same_day_cutoff: '17:00',
            pod_retention_days: 180,
            auto_ingest_ready_orders: true
        };
    }

    res.json({ settings });
}));

/**
 * PUT /api/delivery/settings
 * Update delivery settings for the merchant
 */
router.put('/settings', requireAuth, requireMerchant, validators.updateSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const {
        startAddress,
        endAddress,
        sameDayCutoff,
        podRetentionDays,
        autoIngestReadyOrders,
        openrouteserviceApiKey
    } = req.body;

    // Geocode start and end addresses if provided
    let startLat = null, startLng = null, endLat = null, endLng = null;

    if (startAddress) {
        const currentSettings = await deliveryApi.getSettings(merchantId);
        const coords = await deliveryApi.geocodeAddress(startAddress, currentSettings?.openrouteservice_api_key || openrouteserviceApiKey);
        if (coords) {
            startLat = coords.lat;
            startLng = coords.lng;
        }
    }

    if (endAddress) {
        const currentSettings = await deliveryApi.getSettings(merchantId);
        const coords = await deliveryApi.geocodeAddress(endAddress, currentSettings?.openrouteservice_api_key || openrouteserviceApiKey);
        if (coords) {
            endLat = coords.lat;
            endLng = coords.lng;
        }
    }

    const settings = await deliveryApi.updateSettings(merchantId, {
        startAddress,
        startAddressLat: startLat,
        startAddressLng: startLng,
        endAddress,
        endAddressLat: endLat,
        endAddressLng: endLng,
        sameDayCutoff,
        podRetentionDays,
        autoIngestReadyOrders,
        openrouteserviceApiKey
    });

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'settings_updated', null, null, {
        startAddress: !!startAddress,
        endAddress: !!endAddress
    });

    res.json({ settings });
}));

/**
 * GET /api/delivery/audit
 * Get delivery audit log
 */
router.get('/audit', requireAuth, requireMerchant, validators.getAudit, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { limit, offset, action, orderId, routeId } = req.query;

    const entries = await deliveryApi.getAuditLog(merchantId, {
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        action,
        orderId,
        routeId
    });

    res.json({ entries });
}));

/**
 * GET /api/delivery/stats
 * Get delivery statistics for dashboard
 */
router.get('/stats', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const today = new Date().toISOString().split('T')[0];

    // Get counts by status
    const statusCounts = await db.query(`
        SELECT status, COUNT(*) as count
        FROM delivery_orders
        WHERE merchant_id = $1
        GROUP BY status
    `, [merchantId]);

    // Get today's route info
    const activeRoute = await deliveryApi.getActiveRoute(merchantId, today);

    // Get today's completions
    const todayCompletions = await db.query(`
        SELECT COUNT(*) as count
        FROM delivery_orders
        WHERE merchant_id = $1
          AND status = 'completed'
          AND updated_at::date = CURRENT_DATE
    `, [merchantId]);

    res.json({
        stats: {
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
        }
    });
}));

/**
 * POST /api/delivery/sync
 * Sync open orders from Square that have delivery/shipment fulfillments
 * Use this to backfill orders that were missed while server was offline
 */
router.post('/sync', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.syncOrders, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { daysBack = 7 } = req.body;

    logger.info('Starting delivery order sync from Square', { merchantId, daysBack });

    // Get Square client for this merchant
    const squareClient = await getSquareClientForMerchant(merchantId);

    // Calculate date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    // Get location IDs
    const locationIds = await getLocationIds(merchantId);

    // Search for orders with fulfillments
    const searchResponse = await squareClient.orders.search({
        locationIds: locationIds,
        query: {
            filter: {
                dateTimeFilter: {
                    createdAt: {
                        startAt: startDate.toISOString()
                    }
                },
                stateFilter: {
                    states: ['OPEN', 'COMPLETED']
                },
                fulfillmentFilter: {
                    fulfillmentTypes: ['DELIVERY', 'SHIPMENT']
                }
            },
            sort: {
                sortField: 'CREATED_AT',
                sortOrder: 'DESC'
            }
        },
        limit: 100
    });

    const orders = searchResponse.orders || [];
    let imported = 0;
    let skipped = 0;
    let errors = [];

    for (const order of orders) {
        try {
                // Check if order has delivery-type fulfillment
                const deliveryFulfillment = order.fulfillments?.find(f =>
                    (f.type === 'DELIVERY' || f.type === 'SHIPMENT')
                );

                if (!deliveryFulfillment) {
                    skipped++;
                    continue;
                }

                // Handle completed orders specially
                if (order.state === 'COMPLETED') {
                    const existing = await deliveryApi.getOrderBySquareId(merchantId, order.id);
                    if (existing) {
                        // If we already have this order, update its status if needed
                        if (existing.status !== 'completed') {
                            await deliveryApi.updateOrder(merchantId, existing.id, {
                                status: 'completed',
                                squareSyncedAt: new Date()
                            });
                            logger.info('Updated existing delivery order to completed', {
                                merchantId,
                                orderId: existing.id,
                                squareOrderId: order.id
                            });
                            imported++;
                        } else {
                            // Already completed in our system too
                            skipped++;
                        }
                    } else {
                        // Don't import NEW orders that are already completed in Square
                        // They've already been fulfilled, no point adding to delivery queue
                        logger.debug('Skipping completed Square order - not in our system', {
                            merchantId,
                            squareOrderId: order.id,
                            customerName: order.fulfillments?.[0]?.deliveryDetails?.recipient?.displayName ||
                                         order.fulfillments?.[0]?.shipmentDetails?.recipient?.displayName
                        });
                        skipped++;
                    }
                    continue;
                }

                // Try to ingest OPEN orders only
                const result = await deliveryApi.ingestSquareOrder(merchantId, order);
                if (result) {
                    imported++;
                } else {
                    logger.warn('Delivery order skipped - no address or ingest returned null', {
                        merchantId,
                        squareOrderId: order.id,
                        state: order.state,
                        hasFulfillments: !!order.fulfillments?.length
                    });
                    skipped++;
                }
            } catch (orderError) {
                logger.error('Failed to ingest delivery order', {
                    merchantId,
                    squareOrderId: order.id,
                    error: orderError.message,
                    stack: orderError.stack
                });
                errors.push({ orderId: order.id, error: orderError.message });
            }
        }

        logger.info('Delivery order sync completed', { merchantId, found: orders.length, imported, skipped, errors: errors.length });

    res.json({
        success: true,
        found: orders.length,
        imported,
        skipped,
        errors: errors.length > 0 ? errors : undefined
    });
}));

/**
 * POST /api/delivery/backfill-customers
 * Backfill customer data for orders with "Unknown Customer"
 * Looks up customer details from Square API using square_customer_id
 */
router.post('/backfill-customers', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    logger.info('Starting customer backfill for delivery orders', { merchantId });

    const result = await deliveryApi.backfillUnknownCustomers(merchantId);

    res.json({
        success: true,
        ...result
    });
}));

module.exports = router;
