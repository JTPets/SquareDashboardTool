/**
 * Tests for services/loyalty-admin/order-history-audit-service.js
 *
 * Customer order history analysis for loyalty audit and manual backfill.
 * Covers:
 * - getCustomerOrderHistoryForAudit: chunked mode, legacy mode, order analysis
 * - _analyzeOrders: qualifying/non-qualifying items, free items, redemption cross-ref
 * - addOrdersToLoyaltyTracking: order fetch, customer mismatch, dedup, error handling
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { squareApi: jest.fn(), debug: jest.fn() }
}));

const mockFetchWithTimeout = jest.fn();
const mockGetSquareAccessToken = jest.fn();

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: mockFetchWithTimeout,
    getSquareAccessToken: mockGetSquareAccessToken
}));

const mockLogAuditEvent = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: mockLogAuditEvent
}));

const mockProcessLoyaltyOrder = jest.fn();
jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: mockProcessLoyaltyOrder
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 100 }
}));

jest.mock('../../../services/loyalty-admin/constants', () => ({
    AuditActions: { PURCHASE_RECORDED: 'PURCHASE_RECORDED' }
}));

const db = require('../../../utils/database');
const {
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking,
    analyzeOrders
} = require('../../../services/loyalty-admin/order-history-audit-service');

// ============================================================================
// HELPERS
// ============================================================================

function setupStandardDbQueries({
    offers = [],
    trackedOrders = [],
    redemptions = [],
    rewards = [],
    locations = [{ id: 'LOC_1' }]
} = {}) {
    db.query
        .mockResolvedValueOnce({ rows: offers })           // offers + variations
        .mockResolvedValueOnce({ rows: trackedOrders })     // tracked orders
        .mockResolvedValueOnce({ rows: redemptions })       // redemptions
        .mockResolvedValueOnce({ rows: rewards })           // current rewards
        .mockResolvedValueOnce({ rows: locations });         // locations
}

// ============================================================================
// TESTS — getCustomerOrderHistoryForAudit
// ============================================================================

describe('getCustomerOrderHistoryForAudit', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when squareCustomerId is missing', async () => {
        await expect(getCustomerOrderHistoryForAudit({ merchantId: 1 }))
            .rejects.toThrow('squareCustomerId and merchantId are required');
    });

    it('should throw when merchantId is missing', async () => {
        await expect(getCustomerOrderHistoryForAudit({ squareCustomerId: 'C1' }))
            .rejects.toThrow('squareCustomerId and merchantId are required');
    });

    it('should throw when no access token available', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce(null);

        await expect(getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        })).rejects.toThrow('No access token available');
    });

    it('should throw when no active locations found', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({ locations: [] });

        await expect(getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        })).rejects.toThrow('No active locations found');
    });

    it('should fetch orders with legacy mode (periodDays) and analyze them', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            offers: [{
                id: 10, offer_name: 'Buy 10 Get 1', brand_name: 'Acme',
                size_group: '15kg', required_quantity: 10,
                variation_ids: ['VAR_1', 'VAR_2']
            }]
        });

        // Square orders search returns one order
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1',
                    customer_id: 'C1',
                    closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1',
                    tenders: [{ receipt_url: 'https://receipt.example.com' }],
                    line_items: [{
                        uid: 'LI_1',
                        catalog_object_id: 'VAR_1',
                        name: 'Dog Food 15kg',
                        quantity: '2',
                        base_price_money: { amount: 5999 },
                        total_money: { amount: 11998 }
                    }],
                    total_money: { amount: 11998 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1, periodDays: 30
        });

        expect(result.squareCustomerId).toBe('C1');
        expect(result.periodDays).toBe(30);
        expect(result.summary.totalOrders).toBe(1);
        expect(result.summary.canBeAdded).toBe(1);
        expect(result.orders[0].qualifyingItems).toHaveLength(1);
        expect(result.orders[0].qualifyingItems[0].quantity).toBe(2);
        expect(result.orders[0].totalQualifyingQty).toBe(2);
        expect(result.orders[0].receiptUrl).toBe('https://receipt.example.com');
    });

    it('should use default period of 91 days when periodDays not specified', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ orders: [], cursor: null })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.periodDays).toBe(91);
    });

    it('should include chunk info in chunked mode response', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ orders: [], cursor: null })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1,
            startMonthsAgo: 0, endMonthsAgo: 3
        });

        expect(result.chunk).toEqual({ startMonthsAgo: 0, endMonthsAgo: 3 });
        expect(result.hasMoreHistory).toBe(true);
        expect(result.periodDays).toBeUndefined();
    });

    it('should set hasMoreHistory to false when endMonthsAgo >= 18', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ orders: [], cursor: null })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1,
            startMonthsAgo: 15, endMonthsAgo: 18
        });

        expect(result.hasMoreHistory).toBe(false);
    });

    it('should mark already-tracked orders correctly', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            trackedOrders: [{ square_order_id: 'ORD_1', customer_source: 'webhook' }]
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', line_items: [], tenders: [],
                    total_money: { amount: 0 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.orders[0].isAlreadyTracked).toBe(true);
        expect(result.orders[0].canBeAdded).toBe(false);
        expect(result.orders[0].customerSource).toBe('webhook');
        expect(result.summary.alreadyTracked).toBe(1);
    });

    it('should classify free items (total $0 with positive unit price) as non-qualifying', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            offers: [{
                id: 10, offer_name: 'Buy 10 Get 1', brand_name: 'Acme',
                size_group: '15kg', required_quantity: 10,
                variation_ids: ['VAR_1']
            }]
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    line_items: [{
                        uid: 'LI_FREE', catalog_object_id: 'VAR_1', name: 'Dog Food 15kg',
                        quantity: '1',
                        base_price_money: { amount: 5999 },
                        total_money: { amount: 0 }
                    }],
                    total_money: { amount: 0 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.orders[0].qualifyingItems).toHaveLength(0);
        expect(result.orders[0].nonQualifyingItems).toHaveLength(1);
        expect(result.orders[0].nonQualifyingItems[0].skipReason).toBe('free_item');
        expect(result.orders[0].nonQualifyingItems[0].isFree).toBe(true);
    });

    it('should classify items without variation_id as non-qualifying', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    line_items: [{
                        uid: 'LI_1', catalog_object_id: null, name: 'Custom Item',
                        quantity: '1',
                        base_price_money: { amount: 1000 },
                        total_money: { amount: 1000 }
                    }],
                    total_money: { amount: 1000 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.orders[0].nonQualifyingItems[0].skipReason).toBe('no_variation_id');
    });

    it('should classify items with no matching offer as non-qualifying', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            offers: [{
                id: 10, offer_name: 'Buy 10 Get 1', brand_name: 'Acme',
                size_group: '15kg', required_quantity: 10,
                variation_ids: ['VAR_1']
            }]
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    line_items: [{
                        uid: 'LI_1', catalog_object_id: 'VAR_UNKNOWN', name: 'Random Product',
                        quantity: '1',
                        base_price_money: { amount: 1000 },
                        total_money: { amount: 1000 }
                    }],
                    total_money: { amount: 1000 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.orders[0].nonQualifyingItems[0].skipReason).toBe('no_matching_offer');
    });

    it('should cross-reference redemptions with order data', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            redemptions: [{
                square_order_id: 'ORD_1',
                redeemed_item_name: 'Dog Food',
                redeemed_variation_id: 'VAR_REDEEMED',
                redeemed_variation_name: '15kg',
                redeemed_value_cents: 5999,
                offer_name: 'Buy 10 Get 1'
            }]
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    line_items: [],
                    total_money: { amount: 0 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        const nonQ = result.orders[0].nonQualifyingItems;
        expect(nonQ).toHaveLength(1);
        expect(nonQ[0].skipReason).toBe('redeemed_reward');
        expect(nonQ[0].isFree).toBe(true);
    });

    it('should not duplicate redemption if already detected as free item', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            offers: [{
                id: 10, offer_name: 'Buy 10', brand_name: 'A',
                size_group: 'S', required_quantity: 10,
                variation_ids: ['VAR_1']
            }],
            redemptions: [{
                square_order_id: 'ORD_1',
                redeemed_item_name: 'Dog Food',
                redeemed_variation_id: 'VAR_1',
                redeemed_variation_name: '15kg',
                redeemed_value_cents: 5999,
                offer_name: 'Buy 10'
            }]
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    line_items: [{
                        uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Dog Food',
                        quantity: '1',
                        base_price_money: { amount: 5999 },
                        total_money: { amount: 0 }  // already free
                    }],
                    total_money: { amount: 0 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        // Should NOT add a duplicate — item already marked as free_item
        const nonQ = result.orders[0].nonQualifyingItems;
        expect(nonQ).toHaveLength(1);
        expect(nonQ[0].skipReason).toBe('free_item');
    });

    it('should throw on Square API error', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 500,
            json: async () => ({ errors: [{ code: 'INTERNAL_ERROR' }] })
        });

        await expect(getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        })).rejects.toThrow('Square API error');
    });

    it('should paginate through multiple pages of orders', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();

        // Page 1 with cursor
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{ id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z', location_id: 'LOC_1', tenders: [], line_items: [], total_money: { amount: 0 } }],
                cursor: 'page2'
            })
        });
        // Page 2 without cursor
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{ id: 'ORD_2', customer_id: 'C1', closed_at: '2026-03-02T12:00:00Z', location_id: 'LOC_1', tenders: [], line_items: [], total_money: { amount: 0 } }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.summary.totalOrders).toBe(2);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('should handle order with missing line_items gracefully', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries();
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    total_money: { amount: 0 }
                    // no line_items field
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.orders[0].qualifyingItems).toHaveLength(0);
        expect(result.orders[0].totalQualifyingQty).toBe(0);
    });

    it('should correctly parse quantity strings from Square API', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        setupStandardDbQueries({
            offers: [{
                id: 10, offer_name: 'Test', brand_name: 'A',
                size_group: 'S', required_quantity: 10,
                variation_ids: ['VAR_1']
            }]
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                orders: [{
                    id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
                    location_id: 'LOC_1', tenders: [],
                    line_items: [{
                        uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Item',
                        quantity: '5',
                        base_price_money: { amount: 1000 },
                        total_money: { amount: 5000 }
                    }],
                    total_money: { amount: 5000 }
                }],
                cursor: null
            })
        });

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: 'C1', merchantId: 1
        });

        expect(result.orders[0].qualifyingItems[0].quantity).toBe(5);
        expect(result.summary.totalQualifyingQtyAvailable).toBe(5);
    });
});

// ============================================================================
// TESTS — addOrdersToLoyaltyTracking
// ============================================================================

describe('addOrdersToLoyaltyTracking', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when required params are missing', async () => {
        await expect(addOrdersToLoyaltyTracking({ merchantId: 1, orderIds: ['O1'] }))
            .rejects.toThrow('squareCustomerId, merchantId, and orderIds are required');

        await expect(addOrdersToLoyaltyTracking({ squareCustomerId: 'C1', orderIds: ['O1'] }))
            .rejects.toThrow('squareCustomerId, merchantId, and orderIds are required');

        await expect(addOrdersToLoyaltyTracking({ squareCustomerId: 'C1', merchantId: 1, orderIds: [] }))
            .rejects.toThrow('squareCustomerId, merchantId, and orderIds are required');
    });

    it('should throw when no access token available', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce(null);

        await expect(addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['O1']
        })).rejects.toThrow('No access token available');
    });

    it('should process order successfully via processLoyaltyOrder', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: { id: 'ORD_1', customer_id: 'C1' }
            })
        });
        mockProcessLoyaltyOrder.mockResolvedValueOnce({
            alreadyProcessed: false,
            purchaseEvents: [{ id: 1 }, { id: 2 }]
        });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(result.processed).toHaveLength(1);
        expect(result.processed[0].purchasesRecorded).toBe(2);
        expect(result.skipped).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
        expect(mockLogAuditEvent).toHaveBeenCalled();
    });

    it('should skip already-processed orders', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ order: { id: 'ORD_1', customer_id: 'C1' } })
        });
        mockProcessLoyaltyOrder.mockResolvedValueOnce({ alreadyProcessed: true });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].reason).toBe('already_tracked');
    });

    it('should error when order customer_id does not match expected customer', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: { id: 'ORD_1', customer_id: 'DIFFERENT_CUST' }
            })
        });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toContain('Customer ID mismatch');
    });

    it('should allow order when customer_id is null (no customer on order)', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: { id: 'ORD_1', customer_id: null }
            })
        });
        mockProcessLoyaltyOrder.mockResolvedValueOnce({
            alreadyProcessed: false,
            purchaseEvents: [{ id: 1 }]
        });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(result.processed).toHaveLength(1);
    });

    it('should error when order is not found', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ order: null })
        });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_MISSING']
        });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toBe('Order not found');
    });

    it('should error when Square API returns non-OK status', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 500,
            json: async () => ({ errors: [{ code: 'INTERNAL_ERROR' }] })
        });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toContain('Square API');
    });

    it('should handle processLoyaltyOrder throwing an error', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ order: { id: 'ORD_1', customer_id: 'C1' } })
        });
        mockProcessLoyaltyOrder.mockRejectedValueOnce(new Error('DB constraint violation'));

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toBe('DB constraint violation');
    });

    it('should process multiple orders with mixed results', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');

        // Order 1: success
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ order: { id: 'ORD_1', customer_id: 'C1' } })
        });
        mockProcessLoyaltyOrder.mockResolvedValueOnce({
            alreadyProcessed: false, purchaseEvents: [{ id: 1 }]
        });

        // Order 2: already tracked
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ order: { id: 'ORD_2', customer_id: 'C1' } })
        });
        mockProcessLoyaltyOrder.mockResolvedValueOnce({ alreadyProcessed: true });

        // Order 3: API error
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 500,
            json: async () => ({ errors: [] })
        });

        const result = await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1,
            orderIds: ['ORD_1', 'ORD_2', 'ORD_3']
        });

        expect(result.processed).toHaveLength(1);
        expect(result.skipped).toHaveLength(1);
        expect(result.errors).toHaveLength(1);

        // Audit event should be logged with counts
        expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
            details: {
                ordersProcessed: 1,
                ordersSkipped: 1,
                ordersErrored: 1
            }
        }));
    });

    it('should pass correct source parameters to processLoyaltyOrder', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ order: { id: 'ORD_1', customer_id: 'C1' } })
        });
        mockProcessLoyaltyOrder.mockResolvedValueOnce({
            alreadyProcessed: false, purchaseEvents: []
        });

        await addOrdersToLoyaltyTracking({
            squareCustomerId: 'C1', merchantId: 1, orderIds: ['ORD_1']
        });

        expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith({
            order: { id: 'ORD_1', customer_id: 'C1' },
            merchantId: 1,
            squareCustomerId: 'C1',
            source: 'audit',
            customerSource: 'manual'
        });
    });
});

// ============================================================================
// TESTS — analyzeOrders (BACKLOG-71: extracted for independent testing)
// ============================================================================

describe('analyzeOrders', () => {
    const makeOffer = (offerId, name, brandName, sizeGroup, requiredQty) => ({
        offerId, offerName: name, brandName, sizeGroup, requiredQuantity: requiredQty
    });

    it('should return empty array for empty orders', () => {
        const result = analyzeOrders([], new Map(), new Set(), new Map(), new Map());
        expect(result).toEqual([]);
    });

    it('should correctly count qualifying items', () => {
        const variationToOffer = new Map([
            ['VAR_1', makeOffer(10, 'Buy 10', 'Acme', '15kg', 10)]
        ]);

        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            line_items: [
                { uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Dog Food', quantity: '3', base_price_money: { amount: 5999 }, total_money: { amount: 17997 } }
            ],
            total_money: { amount: 17997 }
        }];

        const result = analyzeOrders(orders, variationToOffer, new Set(), new Map(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].totalQualifyingQty).toBe(3);
        expect(result[0].qualifyingItems).toHaveLength(1);
        expect(result[0].qualifyingItems[0].offer.id).toBe(10);
        expect(result[0].canBeAdded).toBe(true);
    });

    it('should handle refunds (orders with negative/zero totals) as valid orders', () => {
        const orders = [{
            id: 'ORD_REFUND', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            line_items: [],
            total_money: { amount: 0 }
        }];

        const result = analyzeOrders(orders, new Map(), new Set(), new Map(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].totalQualifyingQty).toBe(0);
        expect(result[0].canBeAdded).toBe(false);
    });

    it('should mark duplicate orders as already tracked', () => {
        const trackedOrderIds = new Set(['ORD_1']);
        const trackedOrderSources = new Map([['ORD_1', 'webhook']]);

        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            line_items: [{ uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Item', quantity: '1', base_price_money: { amount: 1000 }, total_money: { amount: 1000 } }],
            total_money: { amount: 1000 }
        }];

        const variationToOffer = new Map([
            ['VAR_1', makeOffer(10, 'Test', 'A', 'S', 10)]
        ]);

        const result = analyzeOrders(orders, variationToOffer, trackedOrderIds, trackedOrderSources, new Map());

        expect(result[0].isAlreadyTracked).toBe(true);
        expect(result[0].canBeAdded).toBe(false);
        expect(result[0].customerSource).toBe('webhook');
    });

    it('should classify free items as non-qualifying', () => {
        const variationToOffer = new Map([
            ['VAR_1', makeOffer(10, 'Buy 10', 'Acme', '15kg', 10)]
        ]);

        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            line_items: [
                { uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Dog Food', quantity: '1', base_price_money: { amount: 5999 }, total_money: { amount: 0 } }
            ],
            total_money: { amount: 0 }
        }];

        const result = analyzeOrders(orders, variationToOffer, new Set(), new Map(), new Map());

        expect(result[0].qualifyingItems).toHaveLength(0);
        expect(result[0].nonQualifyingItems).toHaveLength(1);
        expect(result[0].nonQualifyingItems[0].skipReason).toBe('free_item');
    });

    it('should handle orders with no line_items', () => {
        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            total_money: { amount: 0 }
        }];

        const result = analyzeOrders(orders, new Map(), new Set(), new Map(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].qualifyingItems).toHaveLength(0);
        expect(result[0].nonQualifyingItems).toHaveLength(0);
        expect(result[0].totalQualifyingQty).toBe(0);
    });

    it('should cross-reference redemptions without duplicating free items', () => {
        const variationToOffer = new Map([
            ['VAR_1', makeOffer(10, 'Buy 10', 'A', 'S', 10)]
        ]);

        const orderRedemptionsMap = new Map([
            ['ORD_1', [{ variationId: 'VAR_1', itemName: 'Dog Food', variationName: '15kg', valueCents: 5999, offerName: 'Buy 10' }]]
        ]);

        // The item is already detected as free in line_items
        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            line_items: [
                { uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Dog Food', quantity: '1', base_price_money: { amount: 5999 }, total_money: { amount: 0 } }
            ],
            total_money: { amount: 0 }
        }];

        const result = analyzeOrders(orders, variationToOffer, new Set(), new Map(), orderRedemptionsMap);

        // Should NOT duplicate the free item
        expect(result[0].nonQualifyingItems).toHaveLength(1);
        expect(result[0].nonQualifyingItems[0].skipReason).toBe('free_item');
    });

    it('should add redemption record when not detected as free item', () => {
        const orderRedemptionsMap = new Map([
            ['ORD_1', [{ variationId: 'VAR_REDEEMED', itemName: 'Treat', variationName: 'Large', valueCents: 1000, offerName: 'Buy 5' }]]
        ]);

        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1', tenders: [],
            line_items: [],
            total_money: { amount: 0 }
        }];

        const result = analyzeOrders(orders, new Map(), new Set(), new Map(), orderRedemptionsMap);

        expect(result[0].nonQualifyingItems).toHaveLength(1);
        expect(result[0].nonQualifyingItems[0].skipReason).toBe('redeemed_reward');
        expect(result[0].nonQualifyingItems[0].offerName).toBe('Buy 5');
    });

    it('should extract receipt URL from tenders', () => {
        const orders = [{
            id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01T12:00:00Z',
            location_id: 'LOC_1',
            tenders: [{ receipt_url: 'https://receipt.example.com/123' }],
            line_items: [],
            total_money: { amount: 0 }
        }];

        const result = analyzeOrders(orders, new Map(), new Set(), new Map(), new Map());

        expect(result[0].receiptUrl).toBe('https://receipt.example.com/123');
    });

    it('should handle multiple orders with mixed qualifying status', () => {
        const variationToOffer = new Map([
            ['VAR_1', makeOffer(10, 'Buy 10', 'Acme', '15kg', 10)]
        ]);

        const orders = [
            {
                id: 'ORD_1', customer_id: 'C1', closed_at: '2026-03-01',
                location_id: 'LOC_1', tenders: [],
                line_items: [{ uid: 'LI_1', catalog_object_id: 'VAR_1', name: 'Dog Food', quantity: '2', base_price_money: { amount: 5999 }, total_money: { amount: 11998 } }],
                total_money: { amount: 11998 }
            },
            {
                id: 'ORD_2', customer_id: 'C1', closed_at: '2026-03-02',
                location_id: 'LOC_1', tenders: [],
                line_items: [{ uid: 'LI_2', catalog_object_id: 'VAR_UNKNOWN', name: 'Cat Toy', quantity: '1', base_price_money: { amount: 999 }, total_money: { amount: 999 } }],
                total_money: { amount: 999 }
            }
        ];

        const result = analyzeOrders(orders, variationToOffer, new Set(), new Map(), new Map());

        expect(result).toHaveLength(2);
        expect(result[0].totalQualifyingQty).toBe(2);
        expect(result[0].canBeAdded).toBe(true);
        expect(result[1].totalQualifyingQty).toBe(0);
        expect(result[1].canBeAdded).toBe(false);
    });
});
