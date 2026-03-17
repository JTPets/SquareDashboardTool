/**
 * Tests for services/loyalty-admin/customer-admin-service.js
 *
 * Customer lookup, status queries, history retrieval, and offer progress.
 * Covers:
 * - getCustomerDetails: cache hit, cache miss (API fetch), API errors
 * - getCustomerLoyaltyStatus: tenant isolation, query results
 * - getCustomerLoyaltyHistory: purchase/reward/redemption queries, offer filter
 * - getCustomerEarnedRewards: basic query + tenant isolation
 * - getCustomerOfferProgress: CTE-based progress calculation
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

const mockCacheCustomerDetails = jest.fn().mockResolvedValue();
const mockGetCachedCustomer = jest.fn();

jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    cacheCustomerDetails: mockCacheCustomerDetails,
    getCachedCustomer: mockGetCachedCustomer
}));

const mockLoyaltyCustomerServiceInstance = {
    initialize: jest.fn().mockResolvedValue(),
    identifyFromLoyaltyEvents: jest.fn(),
    identifyFromFulfillmentRecipient: jest.fn(),
    identifyFromOrderRewards: jest.fn()
};

jest.mock('../../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => mockLoyaltyCustomerServiceInstance)
}));

const db = require('../../../utils/database');
// LOGIC CHANGE: removed 3 dead lookup wrappers (BACKLOG-72)
const {
    getCustomerDetails,
    getCustomerLoyaltyStatus,
    getCustomerLoyaltyHistory,
    getCustomerEarnedRewards,
    getCustomerOfferProgress
} = require('../../../services/loyalty-admin/customer-admin-service');

// ============================================================================
// TESTS — getCustomerDetails
// ============================================================================

describe('getCustomerDetails', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should return null when customerId is missing', async () => {
        const result = await getCustomerDetails(null, 1);
        expect(result).toBeNull();
    });

    it('should return null when merchantId is missing', async () => {
        const result = await getCustomerDetails('CUST_1', null);
        expect(result).toBeNull();
    });

    it('should return cached customer when available', async () => {
        const cached = { id: 'CUST_1', displayName: 'John Doe' };
        mockGetCachedCustomer.mockResolvedValueOnce(cached);

        const result = await getCustomerDetails('CUST_1', 1);

        expect(result).toBe(cached);
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('should fetch from Square API when not cached', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                customer: {
                    id: 'CUST_1',
                    given_name: 'John',
                    family_name: 'Doe',
                    email_address: 'john@example.com',
                    phone_number: '+15551234567',
                    company_name: null,
                    birthday: '1990-01-15',
                    created_at: '2025-01-01T00:00:00Z',
                    updated_at: '2025-06-01T00:00:00Z'
                }
            })
        });

        const result = await getCustomerDetails('CUST_1', 1);

        expect(result).toEqual({
            id: 'CUST_1',
            givenName: 'John',
            familyName: 'Doe',
            displayName: 'John Doe',
            email: 'john@example.com',
            phone: '+15551234567',
            companyName: null,
            birthday: '1990-01-15',
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-06-01T00:00:00Z'
        });
        expect(mockCacheCustomerDetails).toHaveBeenCalledWith(result, 1);
    });

    it('should use company_name as displayName when given/family names are missing', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                customer: {
                    id: 'CUST_2',
                    given_name: null,
                    family_name: null,
                    company_name: 'ACME Corp',
                    created_at: '2025-01-01T00:00:00Z',
                    updated_at: '2025-01-01T00:00:00Z'
                }
            })
        });

        const result = await getCustomerDetails('CUST_2', 1);

        expect(result.displayName).toBe('ACME Corp');
        expect(result.givenName).toBeNull();
        expect(result.familyName).toBeNull();
    });

    it('should use given_name only when family_name is missing', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                customer: {
                    id: 'CUST_3', given_name: 'Jane', family_name: null,
                    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z'
                }
            })
        });

        const result = await getCustomerDetails('CUST_3', 1);
        expect(result.displayName).toBe('Jane');
    });

    it('should return null when no access token available', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce(null);

        const result = await getCustomerDetails('CUST_1', 1);

        expect(result).toBeNull();
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('should return null when Square API returns non-OK status', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 404
        });

        const result = await getCustomerDetails('CUST_1', 1);

        expect(result).toBeNull();
    });

    it('should return null when response has no customer object', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({})
        });

        const result = await getCustomerDetails('CUST_1', 1);

        expect(result).toBeNull();
    });

    it('should return null and log error when fetch throws', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockRejectedValueOnce(new Error('Network error'));

        const result = await getCustomerDetails('CUST_1', 1);

        expect(result).toBeNull();
    });

    it('should set displayName to null when all name fields are empty', async () => {
        mockGetCachedCustomer.mockResolvedValueOnce(null);
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                customer: {
                    id: 'CUST_ANON', given_name: null, family_name: null,
                    company_name: null,
                    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z'
                }
            })
        });

        const result = await getCustomerDetails('CUST_ANON', 1);
        expect(result.displayName).toBeNull();
    });
});

// LOGIC CHANGE: removed tests for 3 dead lookup wrappers (BACKLOG-72)

// ============================================================================
// TESTS — getCustomerLoyaltyStatus
// ============================================================================

describe('getCustomerLoyaltyStatus', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when merchantId is missing', async () => {
        await expect(getCustomerLoyaltyStatus('CUST_1', null))
            .rejects.toThrow('merchantId is required');
    });

    it('should return offers with customer progress data', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    offer_id: 10, offer_name: 'Buy 10 Get 1', brand_name: 'Acme',
                    size_group: '15kg', required_quantity: 10, window_months: 12,
                    current_quantity: 5, window_start_date: '2025-06-01',
                    window_end_date: '2026-06-01', has_earned_reward: false,
                    earned_reward_id: null, total_lifetime_purchases: 25,
                    total_rewards_earned: 2, total_rewards_redeemed: 1,
                    last_purchase_at: '2026-03-01'
                }
            ]
        });

        const result = await getCustomerLoyaltyStatus('CUST_1', 1);

        expect(result.squareCustomerId).toBe('CUST_1');
        expect(result.offers).toHaveLength(1);
        expect(result.offers[0].current_quantity).toBe(5);
    });

    it('should return empty offers array when no active offers exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await getCustomerLoyaltyStatus('CUST_1', 1);

        expect(result.offers).toEqual([]);
    });

    it('should filter by merchant_id in the SQL query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getCustomerLoyaltyStatus('CUST_1', 42);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('o.merchant_id = $1'),
            [42, 'CUST_1']
        );
    });
});

// ============================================================================
// TESTS — getCustomerLoyaltyHistory
// ============================================================================

describe('getCustomerLoyaltyHistory', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when merchantId is missing', async () => {
        await expect(getCustomerLoyaltyHistory('CUST_1', null))
            .rejects.toThrow('merchantId is required');
    });

    it('should return purchases, rewards, and redemptions', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, type: 'purchase' }] })  // purchases
            .mockResolvedValueOnce({ rows: [{ id: 2, type: 'reward' }] })    // rewards
            .mockResolvedValueOnce({ rows: [{ id: 3, type: 'redemption' }] }); // redemptions

        const result = await getCustomerLoyaltyHistory('CUST_1', 1);

        expect(result.squareCustomerId).toBe('CUST_1');
        expect(result.purchases).toHaveLength(1);
        expect(result.rewards).toHaveLength(1);
        expect(result.redemptions).toHaveLength(1);
    });

    it('should use default limit of 50 for purchases', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await getCustomerLoyaltyHistory('CUST_1', 1);

        // Purchase query should have params [merchantId, customerId, limit=50]
        const purchaseCall = db.query.mock.calls[0];
        expect(purchaseCall[1]).toEqual([1, 'CUST_1', 50]);
    });

    it('should respect custom limit option', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await getCustomerLoyaltyHistory('CUST_1', 1, { limit: 10 });

        const purchaseCall = db.query.mock.calls[0];
        expect(purchaseCall[1]).toEqual([1, 'CUST_1', 10]);
    });

    it('should add offerId filter when provided', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await getCustomerLoyaltyHistory('CUST_1', 1, { offerId: 10 });

        // All three queries should include offerId in params
        expect(db.query.mock.calls[0][1]).toEqual([1, 'CUST_1', 10, 50]);
        expect(db.query.mock.calls[1][1]).toEqual([1, 'CUST_1', 10]);
        expect(db.query.mock.calls[2][1]).toEqual([1, 'CUST_1', 10]);

        // SQL should contain offer_id filter
        expect(db.query.mock.calls[0][0]).toContain('pe.offer_id = $3');
    });

    it('should run all three queries in parallel via Promise.all', async () => {
        let resolveOrder = [];
        db.query.mockImplementation(() => new Promise(resolve => {
            resolveOrder.push(resolve);
        }));

        const promise = getCustomerLoyaltyHistory('CUST_1', 1);

        // All 3 queries should be launched before any resolve
        expect(resolveOrder).toHaveLength(3);

        resolveOrder[0]({ rows: [] });
        resolveOrder[1]({ rows: [] });
        resolveOrder[2]({ rows: [] });

        const result = await promise;
        expect(result.purchases).toEqual([]);
    });
});

// ============================================================================
// TESTS — getCustomerEarnedRewards
// ============================================================================

describe('getCustomerEarnedRewards', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when merchantId is missing', async () => {
        await expect(getCustomerEarnedRewards('CUST_1', null))
            .rejects.toThrow('merchantId is required');
    });

    it('should return only earned rewards for the customer', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, status: 'earned', offer_name: 'Offer A' },
                { id: 2, status: 'earned', offer_name: 'Offer B' }
            ]
        });

        const result = await getCustomerEarnedRewards('CUST_1', 1);

        expect(result).toHaveLength(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("r.status = 'earned'"),
            [1, 'CUST_1']
        );
    });

    it('should return empty array when no earned rewards exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await getCustomerEarnedRewards('CUST_1', 1);

        expect(result).toEqual([]);
    });
});

// ============================================================================
// TESTS — getCustomerOfferProgress
// ============================================================================

describe('getCustomerOfferProgress', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when merchantId is missing', async () => {
        await expect(getCustomerOfferProgress({ squareCustomerId: 'CUST_1' }))
            .rejects.toThrow('merchantId is required');
    });

    it('should throw when squareCustomerId is missing', async () => {
        await expect(getCustomerOfferProgress({ merchantId: 1 }))
            .rejects.toThrow('squareCustomerId is required');
    });

    it('should return offer progress from purchase events (source of truth)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    offer_id: 10, offer_name: 'Buy 10 Get 1', brand_name: 'Acme',
                    size_group: '15kg', required_quantity: 10, window_months: 12,
                    current_quantity: 7, window_start_date: '2025-06-01',
                    window_end_date: '2026-06-01', has_earned_reward: false,
                    earned_reward_id: null, total_lifetime_purchases: 37,
                    total_rewards_earned: 3, total_rewards_redeemed: 2,
                    last_purchase_at: '2026-03-10'
                },
                {
                    offer_id: 11, offer_name: 'Buy 8 Get 1', brand_name: 'Beta',
                    size_group: '10kg', required_quantity: 8, window_months: 6,
                    current_quantity: 0, window_start_date: null,
                    window_end_date: null, has_earned_reward: false,
                    earned_reward_id: null, total_lifetime_purchases: 0,
                    total_rewards_earned: 0, total_rewards_redeemed: 0,
                    last_purchase_at: null
                }
            ]
        });

        const result = await getCustomerOfferProgress({
            squareCustomerId: 'CUST_1', merchantId: 1
        });

        expect(result.squareCustomerId).toBe('CUST_1');
        expect(result.offers).toHaveLength(2);
        expect(result.offers[0].current_quantity).toBe(7);
        expect(result.offers[1].current_quantity).toBe(0);
    });

    it('should only include active offers in results', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getCustomerOfferProgress({ squareCustomerId: 'CUST_1', merchantId: 1 });

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('o.is_active = TRUE'),
            [1, 'CUST_1']
        );
    });

    it('should filter by merchant_id for tenant isolation', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getCustomerOfferProgress({ squareCustomerId: 'CUST_1', merchantId: 42 });

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('o.merchant_id = $1'),
            [42, 'CUST_1']
        );
    });
});
