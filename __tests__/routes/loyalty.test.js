/**
 * Loyalty Routes Test Suite
 *
 * Tests for routes/loyalty/ (48 endpoints across 10 modules).
 * Focuses on highest-risk modules:
 * - offers.js: Offer CRUD (5 handlers)
 * - rewards.js: Reward management (4 handlers)
 * - processing.js: Order processing, manual entry (6 handlers)
 * - customers.js: Customer lookup, search (7 handlers)
 *
 * Issues logged during testing:
 * - settings.js GET /settings has direct DB query (should delegate to service)
 * - processing.js manual-entry has 44 lines inline logic
 * - square-integration.js create-square-reward has 51 lines inline logic
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const mockLoyaltyService = {
    // Offers
    getOffers: jest.fn(),
    createOffer: jest.fn(),
    getOfferById: jest.fn(),
    getQualifyingVariations: jest.fn(),
    updateOffer: jest.fn(),
    deleteOffer: jest.fn(),
    // Rewards
    redeemReward: jest.fn(),
    updateVendorCreditStatus: jest.fn(),
    getRewards: jest.fn(),
    getRedemptions: jest.fn(),
    // Processing
    processOrderManually: jest.fn(),
    runBackfill: jest.fn(),
    runLoyaltyCatchup: jest.fn(),
    refreshCustomersWithMissingData: jest.fn(),
    processQualifyingPurchase: jest.fn(),
    processExpiredWindowEntries: jest.fn(),
    processExpiredEarnedRewards: jest.fn(),
    // Customers
    getCustomerDetails: jest.fn(),
    getCustomerLoyaltyStatus: jest.fn(),
    getCustomerOfferProgress: jest.fn(),
    getCustomerLoyaltyHistory: jest.fn(),
    getCustomerEarnedRewards: jest.fn(),
    getCustomerOrderHistoryForAudit: jest.fn(),
    addOrdersToLoyaltyTracking: jest.fn(),
    searchCustomers: jest.fn(),
    // Audit
    getAuditLogs: jest.fn(),
    getLoyaltyStats: jest.fn(),
    // Settings
    getSettings: jest.fn(),
    updateSetting: jest.fn(),
    // Variations
    addQualifyingVariations: jest.fn(),
    getQualifyingVariationDetails: jest.fn(),
    removeQualifyingVariation: jest.fn(),
    getAllVariationAssignments: jest.fn(),
    // Reports
    generateVendorReceipt: jest.fn(),
    // Discounts
    validateLoyaltyDiscounts: jest.fn(),
    validateAndFixDiscounts: jest.fn(),
    // Square integration
    getSquareLoyaltyProgram: jest.fn(),
    updateSquareTierMapping: jest.fn(),
    getRewardDetails: jest.fn(),
    createSquareCustomerGroupDiscount: jest.fn(),
    cleanupSquareCustomerGroupDiscount: jest.fn(),
    syncRewardsToPos: jest.fn(),
    getPendingSyncRewards: jest.fn(),
};

jest.mock('../../services/loyalty-admin', () => mockLoyaltyService);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
    requireWriteAccess: (req, res, next) => {
        if (req.session?.user?.role === 'viewer') {
            return res.status(403).json({ error: 'Write access required' });
        }
        next();
    },
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(400).json({ error: 'Merchant context required' });
        }
        next();
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');

// Valid v4 UUIDs for validator compliance
const OFFER_UUID = '54de3dd3-0870-469a-9063-677c39b52917';
const REWARD_UUID = '616f80d8-5bb9-4882-8165-ec32b6d395d7';

// ============================================================================
// TEST APP SETUP
// ============================================================================

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true, role = 'admin' } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, email: 'test@test.com', role };
        if (hasMerchant) req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    const loyaltyRoutes = require('../../routes/loyalty');
    app.use('/api/loyalty', loyaltyRoutes);
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ============================================================================
// TESTS — OFFERS
// ============================================================================

describe('Loyalty Offer Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/loyalty/offers', () => {
        it('should list offers for merchant', async () => {
            mockLoyaltyService.getOffers.mockResolvedValueOnce([
                { id: 1, offer_name: 'Buy 12 Get 1 Free', brand_name: 'Acana' }
            ]);
            const res = await request(app).get('/api/loyalty/offers');
            expect(res.status).toBe(200);
            expect(res.body.offers).toHaveLength(1);
            expect(mockLoyaltyService.getOffers).toHaveBeenCalledWith(1, expect.any(Object));
        });

        it('should pass activeOnly filter', async () => {
            mockLoyaltyService.getOffers.mockResolvedValueOnce([]);
            await request(app).get('/api/loyalty/offers?activeOnly=true');
            expect(mockLoyaltyService.getOffers).toHaveBeenCalledWith(1, {
                activeOnly: true,
                brandName: undefined
            });
        });

        it('should return 401 without auth', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/loyalty/offers');
            expect(res.status).toBe(401);
        });
    });

    describe('POST /api/loyalty/offers', () => {
        it('should create a new offer', async () => {
            mockLoyaltyService.createOffer.mockResolvedValueOnce({
                id: 1, offer_name: 'Buy 12 Get 1 Free'
            });
            const res = await request(app)
                .post('/api/loyalty/offers')
                .send({
                    brandName: 'Acana',
                    sizeGroup: 'Large Bags',
                    requiredQuantity: 12,
                    windowMonths: 12
                });
            expect(res.status).toBe(201);
            expect(res.body.offer.id).toBe(1);
            expect(mockLoyaltyService.createOffer).toHaveBeenCalledWith(
                expect.objectContaining({
                    merchantId: 1,
                    brandName: 'Acana',
                    requiredQuantity: 12
                })
            );
        });

        it('should require brandName', async () => {
            const res = await request(app)
                .post('/api/loyalty/offers')
                .send({ sizeGroup: 'Large', requiredQuantity: 12 });
            expect(res.status).toBe(400);
        });

        it('should require sizeGroup', async () => {
            const res = await request(app)
                .post('/api/loyalty/offers')
                .send({ brandName: 'Acana', requiredQuantity: 12 });
            expect(res.status).toBe(400);
        });

        it('should require requiredQuantity', async () => {
            const res = await request(app)
                .post('/api/loyalty/offers')
                .send({ brandName: 'Acana', sizeGroup: 'Large' });
            expect(res.status).toBe(400);
        });

        it('should reject requiredQuantity > 1000', async () => {
            const res = await request(app)
                .post('/api/loyalty/offers')
                .send({ brandName: 'Acana', sizeGroup: 'Large', requiredQuantity: 1001 });
            expect(res.status).toBe(400);
        });

        it('should reject viewer role (write access required)', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post('/api/loyalty/offers')
                .send({ brandName: 'A', sizeGroup: 'B', requiredQuantity: 12 });
            expect(res.status).toBe(403);
        });
    });

    describe('GET /api/loyalty/offers/:id', () => {
        it('should return offer with variations', async () => {
            mockLoyaltyService.getOfferById.mockResolvedValueOnce({
                id: 1, offer_name: 'Buy 12'
            });
            mockLoyaltyService.getQualifyingVariations.mockResolvedValueOnce([
                { variation_id: 'v1', sku: 'SKU001' }
            ]);
            const res = await request(app).get(`/api/loyalty/offers/${OFFER_UUID}`);
            expect(res.status).toBe(200);
            expect(res.body.offer.id).toBe(1);
            expect(res.body.variations).toHaveLength(1);
        });

        it('should return 404 when offer not found', async () => {
            mockLoyaltyService.getOfferById.mockResolvedValueOnce(null);
            const res = await request(app).get(`/api/loyalty/offers/${OFFER_UUID}`);
            expect(res.status).toBe(404);
        });
    });

    describe('PATCH /api/loyalty/offers/:id', () => {
        it('should update offer fields', async () => {
            mockLoyaltyService.updateOffer.mockResolvedValueOnce({
                id: 1, offer_name: 'Updated Name'
            });
            const res = await request(app)
                .patch(`/api/loyalty/offers/${OFFER_UUID}`)
                .send({ offer_name: 'Updated Name', is_active: false });
            expect(res.status).toBe(200);
            expect(mockLoyaltyService.updateOffer).toHaveBeenCalledWith(
                OFFER_UUID,
                expect.objectContaining({ offer_name: 'Updated Name', is_active: false }),
                1,
                1
            );
        });

        it('should skip undefined fields in updates', async () => {
            mockLoyaltyService.updateOffer.mockResolvedValueOnce({ id: 1 });
            await request(app)
                .patch(`/api/loyalty/offers/${OFFER_UUID}`)
                .send({ offer_name: 'New' });
            const updateCall = mockLoyaltyService.updateOffer.mock.calls[0];
            expect(updateCall[1]).toEqual({ offer_name: 'New' });
        });
    });

    describe('DELETE /api/loyalty/offers/:id', () => {
        it('should delete offer', async () => {
            mockLoyaltyService.deleteOffer.mockResolvedValueOnce({
                offerName: 'Old Offer', hadActiveRewards: false
            });
            const res = await request(app).delete(`/api/loyalty/offers/${OFFER_UUID}`);
            expect(res.status).toBe(200);
        });

        it('should reject viewer role', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app).delete(`/api/loyalty/offers/${OFFER_UUID}`);
            expect(res.status).toBe(403);
        });
    });
});

// ============================================================================
// TESTS — REWARDS
// ============================================================================

describe('Loyalty Reward Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('POST /api/loyalty/rewards/:rewardId/redeem', () => {
        it('should redeem a reward', async () => {
            mockLoyaltyService.redeemReward.mockResolvedValueOnce({
                success: true,
                redemption: { id: 100, reward_id: 1 }
            });
            const res = await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/redeem`)
                .send({
                    squareOrderId: 'ord_1',
                    redeemedVariationId: 'var_1',
                    redeemedValueCents: 4999
                });
            expect(res.status).toBe(200);
            expect(mockLoyaltyService.redeemReward).toHaveBeenCalledWith(
                expect.objectContaining({
                    merchantId: 1,
                    rewardId: REWARD_UUID,
                    redeemedValueCents: 4999
                })
            );
        });

        it('should reject viewer role', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/redeem`)
                .send({ squareOrderId: 'ord_1' });
            expect(res.status).toBe(403);
        });
    });

    describe('PATCH /api/loyalty/rewards/:rewardId/vendor-credit', () => {
        it('should update vendor credit status', async () => {
            mockLoyaltyService.updateVendorCreditStatus.mockResolvedValueOnce({
                id: 1, status: 'SUBMITTED'
            });
            const res = await request(app)
                .patch(`/api/loyalty/rewards/${REWARD_UUID}/vendor-credit`)
                .send({ status: 'SUBMITTED', notes: 'Sent to vendor' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('GET /api/loyalty/rewards', () => {
        it('should list rewards with filters', async () => {
            mockLoyaltyService.getRewards.mockResolvedValueOnce([
                { id: 1, status: 'earned' }
            ]);
            const res = await request(app).get('/api/loyalty/rewards?status=earned&limit=50');
            expect(res.status).toBe(200);
            expect(res.body.rewards).toHaveLength(1);
            expect(mockLoyaltyService.getRewards).toHaveBeenCalledWith(
                expect.objectContaining({
                    merchantId: 1,
                    status: 'earned',
                    limit: 50
                })
            );
        });

        it('should default limit to 100', async () => {
            mockLoyaltyService.getRewards.mockResolvedValueOnce([]);
            await request(app).get('/api/loyalty/rewards');
            expect(mockLoyaltyService.getRewards).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 100, offset: 0 })
            );
        });
    });

    describe('GET /api/loyalty/redemptions', () => {
        it('should list redemptions with date filters', async () => {
            mockLoyaltyService.getRedemptions.mockResolvedValueOnce([
                { id: 1, redeemed_at: '2026-03-01' }
            ]);
            const res = await request(app)
                .get('/api/loyalty/redemptions?startDate=2026-01-01&endDate=2026-03-06');
            expect(res.status).toBe(200);
            expect(res.body.redemptions).toHaveLength(1);
        });
    });
});

// ============================================================================
// TESTS — PROCESSING
// ============================================================================

describe('Loyalty Processing Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('POST /api/loyalty/process-order/:orderId', () => {
        it('should process a specific order', async () => {
            mockLoyaltyService.processOrderManually.mockResolvedValueOnce({
                processed: true, items: 3
            });
            const res = await request(app)
                .post('/api/loyalty/process-order/ORD_ABC123');
            expect(res.status).toBe(200);
            expect(mockLoyaltyService.processOrderManually).toHaveBeenCalledWith({
                merchantId: 1,
                squareOrderId: 'ORD_ABC123'
            });
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post('/api/loyalty/process-order/ORD_1');
            expect(res.status).toBe(403);
        });
    });

    describe('POST /api/loyalty/backfill', () => {
        it('should run backfill with default days', async () => {
            mockLoyaltyService.runBackfill.mockResolvedValueOnce({
                ordersProcessed: 15, newPurchases: 8
            });
            const res = await request(app)
                .post('/api/loyalty/backfill')
                .send({});
            expect(res.status).toBe(200);
            expect(mockLoyaltyService.runBackfill).toHaveBeenCalledWith({
                merchantId: 1, days: 7
            });
        });

        it('should accept custom days', async () => {
            mockLoyaltyService.runBackfill.mockResolvedValueOnce({});
            await request(app)
                .post('/api/loyalty/backfill')
                .send({ days: 30 });
            expect(mockLoyaltyService.runBackfill).toHaveBeenCalledWith({
                merchantId: 1, days: 30
            });
        });
    });

    describe('POST /api/loyalty/catchup', () => {
        it('should run catchup', async () => {
            mockLoyaltyService.runLoyaltyCatchup.mockResolvedValueOnce({
                customersProcessed: 5, newPurchases: 12
            });
            const res = await request(app)
                .post('/api/loyalty/catchup')
                .send({});
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.customersProcessed).toBe(5);
        });
    });

    describe('POST /api/loyalty/manual-entry', () => {
        it('should record manual purchase entry', async () => {
            mockLoyaltyService.processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 100, quantity: 2 },
                reward: { currentQuantity: 5, requiredQuantity: 12 }
            });
            const res = await request(app)
                .post('/api/loyalty/manual-entry')
                .send({
                    squareOrderId: 'ORD_1',
                    squareCustomerId: 'CUST_1',
                    variationId: 'VAR_1',
                    quantity: 2
                });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('5/12');
        });

        it('should return 400 when variation not qualifying', async () => {
            mockLoyaltyService.processQualifyingPurchase.mockResolvedValueOnce({
                processed: false,
                reason: 'variation_not_qualifying'
            });
            const res = await request(app)
                .post('/api/loyalty/manual-entry')
                .send({
                    squareOrderId: 'ORD_1',
                    squareCustomerId: 'CUST_1',
                    variationId: 'VAR_BAD',
                    quantity: 1
                });
            expect(res.status).toBe(400);
            expect(res.body.reason).toBe('variation_not_qualifying');
            expect(res.body.message).toContain('qualifying');
        });

        it('should return 400 when already processed', async () => {
            mockLoyaltyService.processQualifyingPurchase.mockResolvedValueOnce({
                processed: false,
                reason: 'already_processed'
            });
            const res = await request(app)
                .post('/api/loyalty/manual-entry')
                .send({
                    squareOrderId: 'ORD_1',
                    squareCustomerId: 'CUST_1',
                    variationId: 'VAR_1',
                    quantity: 1
                });
            expect(res.status).toBe(400);
            expect(res.body.message).toContain('already been recorded');
        });

        it('should default quantity to 1', async () => {
            mockLoyaltyService.processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 100, quantity: 1 },
                reward: { currentQuantity: 1, requiredQuantity: 12 }
            });
            await request(app)
                .post('/api/loyalty/manual-entry')
                .send({
                    squareOrderId: 'ORD_1',
                    squareCustomerId: 'CUST_1',
                    variationId: 'VAR_1'
                });
            expect(mockLoyaltyService.processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({ quantity: 1 })
            );
        });

        it('should pass customerSource as manual', async () => {
            mockLoyaltyService.processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 100, quantity: 1 },
                reward: { currentQuantity: 1, requiredQuantity: 12 }
            });
            await request(app)
                .post('/api/loyalty/manual-entry')
                .send({
                    squareOrderId: 'ORD_1',
                    squareCustomerId: 'CUST_1',
                    variationId: 'VAR_1',
                    quantity: 1
                });
            expect(mockLoyaltyService.processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    customerSource: 'manual',
                    unitPriceCents: 0
                })
            );
        });
    });

    describe('POST /api/loyalty/refresh-customers', () => {
        it('should refresh customer data', async () => {
            mockLoyaltyService.refreshCustomersWithMissingData.mockResolvedValueOnce({
                refreshed: 5, errors: 0
            });
            const res = await request(app)
                .post('/api/loyalty/refresh-customers');
            expect(res.status).toBe(200);
            expect(res.body.refreshed).toBe(5);
        });
    });

    describe('POST /api/loyalty/process-expired', () => {
        it('should process expired entries and rewards', async () => {
            mockLoyaltyService.processExpiredWindowEntries.mockResolvedValueOnce({
                processedCount: 3
            });
            mockLoyaltyService.processExpiredEarnedRewards.mockResolvedValueOnce({
                processedCount: 1
            });
            const res = await request(app)
                .post('/api/loyalty/process-expired');
            expect(res.status).toBe(200);
            expect(res.body.windowEntries.processedCount).toBe(3);
            expect(res.body.expiredEarnedRewards.processedCount).toBe(1);
        });
    });
});

// ============================================================================
// TESTS — CUSTOMERS
// ============================================================================

describe('Loyalty Customer Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/loyalty/customer/:customerId', () => {
        it('should return customer with loyalty status', async () => {
            mockLoyaltyService.getCustomerDetails.mockResolvedValueOnce({
                id: 'CUST_1', name: 'John Doe'
            });
            mockLoyaltyService.getCustomerLoyaltyStatus.mockResolvedValueOnce({
                activeOffers: 2, totalPurchases: 15
            });
            const res = await request(app)
                .get('/api/loyalty/customer/CUST_1');
            expect(res.status).toBe(200);
            expect(res.body.customer.name).toBe('John Doe');
            expect(res.body.loyalty.activeOffers).toBe(2);
        });

        it('should return 404 when customer not found', async () => {
            mockLoyaltyService.getCustomerDetails.mockResolvedValueOnce(null);
            const res = await request(app)
                .get('/api/loyalty/customer/CUST_UNKNOWN');
            expect(res.status).toBe(404);
        });
    });

    describe('GET /api/loyalty/customer/:customerId/profile', () => {
        it('should return profile with offer progress', async () => {
            mockLoyaltyService.getCustomerDetails.mockResolvedValueOnce({
                id: 'CUST_1', name: 'Jane Doe'
            });
            mockLoyaltyService.getCustomerOfferProgress.mockResolvedValueOnce({
                offers: [{ offerId: 1, progress: 8, required: 12 }]
            });
            const res = await request(app)
                .get('/api/loyalty/customer/CUST_1/profile');
            expect(res.status).toBe(200);
            expect(res.body.offers).toHaveLength(1);
        });
    });

    describe('GET /api/loyalty/customer/:customerId/history', () => {
        it('should return customer history', async () => {
            mockLoyaltyService.getCustomerLoyaltyHistory.mockResolvedValueOnce({
                purchases: [], total: 0
            });
            const res = await request(app)
                .get('/api/loyalty/customer/CUST_1/history');
            expect(res.status).toBe(200);
        });

        it('should pass limit and offerId params', async () => {
            mockLoyaltyService.getCustomerLoyaltyHistory.mockResolvedValueOnce({});
            await request(app)
                .get(`/api/loyalty/customer/CUST_1/history?limit=25&offerId=${OFFER_UUID}`);
            expect(mockLoyaltyService.getCustomerLoyaltyHistory).toHaveBeenCalledWith(
                'CUST_1', 1, { limit: 25, offerId: OFFER_UUID }
            );
        });
    });

    describe('GET /api/loyalty/customer/:customerId/rewards', () => {
        it('should return earned rewards', async () => {
            mockLoyaltyService.getCustomerEarnedRewards.mockResolvedValueOnce([
                { id: 1, status: 'earned', offer_name: 'Buy 12' }
            ]);
            const res = await request(app)
                .get('/api/loyalty/customer/CUST_1/rewards');
            expect(res.status).toBe(200);
            expect(res.body.rewards).toHaveLength(1);
        });
    });

    describe('GET /api/loyalty/customer/:customerId/audit-history', () => {
        it('should support chunked loading with month params', async () => {
            mockLoyaltyService.getCustomerOrderHistoryForAudit.mockResolvedValueOnce({
                orders: [], count: 0
            });
            await request(app)
                .get('/api/loyalty/customer/CUST_1/audit-history?startMonthsAgo=0&endMonthsAgo=3');
            expect(mockLoyaltyService.getCustomerOrderHistoryForAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    squareCustomerId: 'CUST_1',
                    merchantId: 1,
                    startMonthsAgo: 0,
                    endMonthsAgo: 3
                })
            );
        });

        it('should fall back to legacy days param', async () => {
            mockLoyaltyService.getCustomerOrderHistoryForAudit.mockResolvedValueOnce({
                orders: [], count: 0
            });
            await request(app)
                .get('/api/loyalty/customer/CUST_1/audit-history?days=180');
            expect(mockLoyaltyService.getCustomerOrderHistoryForAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    periodDays: 180
                })
            );
        });

        it('should default to 91 days', async () => {
            mockLoyaltyService.getCustomerOrderHistoryForAudit.mockResolvedValueOnce({
                orders: [], count: 0
            });
            await request(app)
                .get('/api/loyalty/customer/CUST_1/audit-history');
            expect(mockLoyaltyService.getCustomerOrderHistoryForAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    periodDays: 91
                })
            );
        });
    });

    describe('POST /api/loyalty/customer/:customerId/add-orders', () => {
        it('should add orders to loyalty tracking', async () => {
            mockLoyaltyService.addOrdersToLoyaltyTracking.mockResolvedValueOnce({
                processed: 3, skipped: 0
            });
            const res = await request(app)
                .post('/api/loyalty/customer/CUST_1/add-orders')
                .send({ orderIds: ['ORD_1', 'ORD_2', 'ORD_3'] });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.processed).toBe(3);
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post('/api/loyalty/customer/CUST_1/add-orders')
                .send({ orderIds: ['ORD_1'] });
            expect(res.status).toBe(403);
        });
    });

    describe('GET /api/loyalty/customers/search', () => {
        it('should search customers by query', async () => {
            mockLoyaltyService.searchCustomers.mockResolvedValueOnce({
                customers: [{ id: 'CUST_1', name: 'John Doe' }],
                source: 'cache'
            });
            const res = await request(app)
                .get('/api/loyalty/customers/search?q=john');
            expect(res.status).toBe(200);
            expect(res.body.customers).toHaveLength(1);
        });
    });
});

// ============================================================================
// TESTS — AUTH/MERCHANT MIDDLEWARE (CROSS-CUTTING)
// ============================================================================

describe('Loyalty Routes — Auth and merchant middleware', () => {
    it('should return 401 on all endpoints without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const endpoints = [
            { method: 'get', path: '/api/loyalty/offers' },
            { method: 'get', path: '/api/loyalty/rewards' },
            { method: 'get', path: '/api/loyalty/customer/CUST_1' },
            { method: 'get', path: '/api/loyalty/redemptions' },
        ];
        for (const ep of endpoints) {
            const res = await request(app)[ep.method](ep.path);
            expect(res.status).toBe(401);
        }
    });

    it('should return 400 on all endpoints without merchant', async () => {
        const app = createTestApp({ hasMerchant: false });
        const endpoints = [
            { method: 'get', path: '/api/loyalty/offers' },
            { method: 'get', path: '/api/loyalty/rewards' },
        ];
        for (const ep of endpoints) {
            const res = await request(app)[ep.method](ep.path);
            expect(res.status).toBe(400);
        }
    });

    it('should return 403 on write endpoints for viewer role', async () => {
        const app = createTestApp({ role: 'viewer' });
        const endpoints = [
            { method: 'post', path: '/api/loyalty/offers', body: { brandName: 'A', sizeGroup: 'B', requiredQuantity: 12 } },
            { method: 'post', path: '/api/loyalty/backfill', body: {} },
            { method: 'post', path: '/api/loyalty/catchup', body: {} },
        ];
        for (const ep of endpoints) {
            const res = await request(app)[ep.method](ep.path).send(ep.body);
            expect(res.status).toBe(403);
        }
    });
});
