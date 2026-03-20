/**
 * Tests for services/loyalty-admin/discount-validation-service.js
 *
 * Validates earned rewards' Square discount objects and syncs discount
 * price caps with current catalog prices. Covers:
 * - validateEarnedRewardsDiscounts: all issue types, fix flows
 * - validateSingleRewardDiscount: each check (missing IDs, 404, deleted, group membership)
 * - syncRewardDiscountPrices: price cap comparison, update/skip/fail paths
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

const mockAddCustomerToGroup = jest.fn();
jest.mock('../../../services/loyalty-admin/square-customer-group-service', () => ({
    addCustomerToGroup: mockAddCustomerToGroup
}));

const mockUpdateRewardDiscountAmount = jest.fn();
jest.mock('../../../services/loyalty-admin/square-discount-catalog-service', () => ({
    updateRewardDiscountAmount: mockUpdateRewardDiscountAmount
}));

const mockCreateSquareCustomerGroupDiscount = jest.fn();
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: mockCreateSquareCustomerGroupDiscount
}));

const db = require('../../../utils/database');
const {
    validateEarnedRewardsDiscounts,
    validateSingleRewardDiscount,
    syncRewardDiscountPrices,
    recreateDiscountIfInvalid
} = require('../../../services/loyalty-admin/discount-validation-service');

// ============================================================================
// TESTS — validateEarnedRewardsDiscounts
// ============================================================================

describe('validateEarnedRewardsDiscounts', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when merchantId is missing', async () => {
        await expect(validateEarnedRewardsDiscounts({}))
            .rejects.toThrow('merchantId is required');
    });

    it('should return error when no access token available', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce(null);

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result).toEqual({ success: false, error: 'No access token available' });
    });

    it('should return success with zero issues when no earned rewards exist', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.success).toBe(true);
        expect(result.totalEarned).toBe(0);
        expect(result.validated).toBe(0);
        expect(result.issues).toEqual([]);
        expect(result.fixed).toEqual([]);
    });

    it('should validate all earned rewards and count valid ones', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: 'DISC_1', square_group_id: null,
                square_customer_id: 'CUST_1', offer_id: 10,
                offer_name: 'Buy 10 Get 1', earned_at: '2026-01-01',
                brand_name: 'Acme', size_group: 'Large'
            }]
        });

        // Discount exists in Square and is valid
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.success).toBe(true);
        expect(result.totalEarned).toBe(1);
        expect(result.validated).toBe(1);
        expect(result.issues).toHaveLength(0);
    });

    it('should collect issues from invalid rewards without fixing when fixIssues is false', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: null, square_group_id: null,
                square_customer_id: 'CUST_1', offer_id: 10,
                offer_name: 'Buy 10 Get 1', earned_at: '2026-01-01'
            }]
        });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1, fixIssues: false });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].issue).toBe('MISSING_SQUARE_IDS');
        expect(result.fixed).toHaveLength(0);
    });

    it('should fix issues and track fixes when fixIssues is true', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: null, square_group_id: null,
                square_customer_id: 'CUST_1', offer_id: 10,
                offer_name: 'Buy 10 Get 1', earned_at: '2026-01-01'
            }]
        });

        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: true });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1, fixIssues: true });

        expect(result.issues).toHaveLength(1);
        expect(result.fixed).toHaveLength(1);
        expect(result.fixed[0].action).toBe('CREATED_DISCOUNT');
    });

    it('should handle multiple rewards with mixed validity', async () => {
        mockGetSquareAccessToken.mockResolvedValueOnce('test-token');
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    id: 1, square_discount_id: 'DISC_1', square_group_id: null,
                    square_customer_id: 'CUST_1', offer_id: 10,
                    offer_name: 'Offer A', earned_at: '2026-01-01'
                },
                {
                    id: 2, square_discount_id: null, square_group_id: null,
                    square_customer_id: 'CUST_2', offer_id: 11,
                    offer_name: 'Offer B', earned_at: '2026-01-02'
                }
            ]
        });

        // First reward: valid discount in Square
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.totalEarned).toBe(2);
        expect(result.validated).toBe(1);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].rewardId).toBe(2);
    });
});

// ============================================================================
// TESTS — validateSingleRewardDiscount
// ============================================================================

describe('validateSingleRewardDiscount', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should return valid when discount exists and is not deleted', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_1', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(true);
        expect(result.issue).toBeNull();
    });

    // -- Check 1: Missing Square IDs --

    it('should detect MISSING_SQUARE_IDS when both IDs are null', async () => {
        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: null, square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('MISSING_SQUARE_IDS');
        expect(result.fixed).toBe(false);
    });

    it('should fix MISSING_SQUARE_IDS by creating discount when fixIssues is true', async () => {
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: true });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: null, square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: true
        });

        expect(result.fixed).toBe(true);
        expect(result.fixAction).toBe('CREATED_DISCOUNT');
        expect(mockCreateSquareCustomerGroupDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'CUST_1',
            internalRewardId: 1,
            offerId: 10
        });
    });

    it('should record fixError when MISSING_SQUARE_IDS fix fails', async () => {
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: false, error: 'API error' });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: null, square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: true
        });

        expect(result.fixed).toBe(false);
        expect(result.details.fixError).toBe('API error');
    });

    // -- Check 2: Discount not found in Square (404) --

    it('should detect DISCOUNT_NOT_FOUND when Square returns 404', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 404,
            json: async () => ({ errors: [{ code: 'NOT_FOUND' }] })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_GONE', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('DISCOUNT_NOT_FOUND');
        expect(result.details.squareDiscountId).toBe('DISC_GONE');
    });

    it('should fix DISCOUNT_NOT_FOUND by clearing IDs and recreating', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: true });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_GONE', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: true
        });

        expect(result.fixed).toBe(true);
        expect(result.fixAction).toBe('RECREATED_DISCOUNT');
        // Verify the UPDATE query cleared Square IDs
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('square_group_id = NULL'),
            [1, 1]
        );
    });

    // -- Check 2b: Discount API error (non-404) --

    it('should detect DISCOUNT_API_ERROR when Square returns non-404 error', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 500,
            json: async () => ({ errors: [{ code: 'INTERNAL_ERROR' }] })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_1', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('DISCOUNT_API_ERROR');
    });

    // -- Check 2c: Discount deleted in Square --

    it('should detect DISCOUNT_DELETED when is_deleted is true', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: true } })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_DEL', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('DISCOUNT_DELETED');
    });

    it('should fix DISCOUNT_DELETED by clearing IDs and recreating', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: true } })
        });
        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: true });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_DEL', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: true
        });

        expect(result.fixed).toBe(true);
        expect(result.fixAction).toBe('RECREATED_DELETED_DISCOUNT');
    });

    // -- Check 2d: Validation error (network/timeout) --

    it('should detect VALIDATION_ERROR when fetch throws', async () => {
        mockFetchWithTimeout.mockRejectedValueOnce(new Error('Network timeout'));

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: { id: 1, square_discount_id: 'DISC_1', square_group_id: null, square_customer_id: 'CUST_1', offer_id: 10 },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('VALIDATION_ERROR');
        expect(result.details.message).toBe('Network timeout');
    });

    // -- Check 3: Customer group membership --

    it('should detect CUSTOMER_NOT_IN_GROUP when customer is not in the discount group', async () => {
        // Discount check passes
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });
        // Customer check shows wrong groups
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ customer: { group_ids: ['OTHER_GROUP'] } })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: {
                id: 1, square_discount_id: 'DISC_1', square_group_id: 'GRP_LOYALTY',
                square_customer_id: 'CUST_1', offer_id: 10
            },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('CUSTOMER_NOT_IN_GROUP');
        expect(result.details.squareGroupId).toBe('GRP_LOYALTY');
        expect(result.details.customerGroups).toEqual(['OTHER_GROUP']);
    });

    it('should fix CUSTOMER_NOT_IN_GROUP by re-adding customer to group', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ customer: { group_ids: [] } })
        });
        mockAddCustomerToGroup.mockResolvedValueOnce({ success: true });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: {
                id: 1, square_discount_id: 'DISC_1', square_group_id: 'GRP_1',
                square_customer_id: 'CUST_1', offer_id: 10
            },
            accessToken: 'test-token',
            fixIssues: true
        });

        expect(result.fixed).toBe(true);
        expect(result.fixAction).toBe('READDED_TO_GROUP');
        expect(mockAddCustomerToGroup).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'CUST_1',
            groupId: 'GRP_1'
        });
    });

    it('should return valid when customer IS in the correct group', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ customer: { group_ids: ['GRP_1', 'OTHER'] } })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: {
                id: 1, square_discount_id: 'DISC_1', square_group_id: 'GRP_1',
                square_customer_id: 'CUST_1', offer_id: 10
            },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(true);
    });

    it('should treat customer API failure as non-fatal (valid result)', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });
        // Customer fetch throws
        mockFetchWithTimeout.mockRejectedValueOnce(new Error('Customer API down'));

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: {
                id: 1, square_discount_id: 'DISC_1', square_group_id: 'GRP_1',
                square_customer_id: 'CUST_1', offer_id: 10
            },
            accessToken: 'test-token',
            fixIssues: false
        });

        // Customer check failure is non-fatal — reward is still valid
        expect(result.valid).toBe(true);
    });

    it('should handle customer response with no group_ids field', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ customer: {} })  // no group_ids
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: {
                id: 1, square_discount_id: 'DISC_1', square_group_id: 'GRP_1',
                square_customer_id: 'CUST_1', offer_id: 10
            },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(false);
        expect(result.issue).toBe('CUSTOMER_NOT_IN_GROUP');
        expect(result.details.customerGroups).toEqual([]);
    });

    it('should skip group check when square_group_id is null', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({ object: { is_deleted: false } })
        });

        const result = await validateSingleRewardDiscount({
            merchantId: 1,
            reward: {
                id: 1, square_discount_id: 'DISC_1', square_group_id: null,
                square_customer_id: 'CUST_1', offer_id: 10
            },
            accessToken: 'test-token',
            fixIssues: false
        });

        expect(result.valid).toBe(true);
        // Only one fetch call (discount check), no customer check
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// TESTS — syncRewardDiscountPrices
// ============================================================================

describe('syncRewardDiscountPrices', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when merchantId is missing', async () => {
        await expect(syncRewardDiscountPrices({}))
            .rejects.toThrow('merchantId is required');
    });

    it('should return success when no rewards have discount IDs', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.success).toBe(true);
        expect(result.totalChecked).toBe(0);
    });

    it('should skip rewards where current price is zero or negative', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '1000', current_max_price_cents: '0',
                offer_id: 10, offer_name: 'Test Offer'
            }]
        });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.skipped).toBe(1);
        expect(result.updated).toBe(0);
    });

    it('should skip rewards where current price is null (parseInt returns NaN -> 0)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '1000', current_max_price_cents: null,
                offer_id: 10, offer_name: 'Test Offer'
            }]
        });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.skipped).toBe(1);
    });

    it('should mark as up-to-date when stored cap >= current price', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '1500', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Test Offer'
            }]
        });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.upToDate).toBe(1);
        expect(result.updated).toBe(0);
        expect(mockUpdateRewardDiscountAmount).not.toHaveBeenCalled();
    });

    // BACKLOG-70: stored cap > current price now triggers a downward update
    it('should update when stored cap exceeds current price (bidirectional sync)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '2000', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Test Offer'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: true });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.upToDate).toBe(0);
        expect(mockUpdateRewardDiscountAmount).toHaveBeenCalledWith({
            merchantId: 1,
            squareDiscountId: 'DISC_1',
            newAmountCents: 1500,
            rewardId: 1
        });
    });

    it('should update discount when current price exceeds stored cap', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '1000', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Test Offer'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: true });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.details[0]).toEqual({
            rewardId: 1,
            offerName: 'Test Offer',
            oldCap: 1000,
            newCap: 1500,
            direction: 'increase'
        });
        expect(mockUpdateRewardDiscountAmount).toHaveBeenCalledWith({
            merchantId: 1,
            squareDiscountId: 'DISC_1',
            newAmountCents: 1500,
            rewardId: 1
        });
    });

    it('should count failed updates and set success to false', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '1000', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Test Offer'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: false, error: 'API error' });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.success).toBe(false);
        expect(result.failed).toBe(1);
        expect(result.details[0].error).toBe('API error');
    });

    it('should handle mixed results across multiple rewards', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { reward_id: 1, square_discount_id: 'D1', discount_amount_cents: '1000', current_max_price_cents: '1000', offer_id: 10, offer_name: 'A' },
                { reward_id: 2, square_discount_id: 'D2', discount_amount_cents: '500', current_max_price_cents: '800', offer_id: 11, offer_name: 'B' },
                { reward_id: 3, square_discount_id: 'D3', discount_amount_cents: '0', current_max_price_cents: '0', offer_id: 12, offer_name: 'C' },
                { reward_id: 4, square_discount_id: 'D4', discount_amount_cents: '700', current_max_price_cents: '900', offer_id: 13, offer_name: 'D' }
            ]
        });
        mockUpdateRewardDiscountAmount
            .mockResolvedValueOnce({ success: true })   // reward 2
            .mockResolvedValueOnce({ success: false, error: 'fail' }); // reward 4

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.totalChecked).toBe(4);
        expect(result.upToDate).toBe(1);    // reward 1
        expect(result.updated).toBe(1);     // reward 2
        expect(result.skipped).toBe(1);     // reward 3 (price 0)
        expect(result.failed).toBe(1);      // reward 4
        expect(result.success).toBe(false); // has failures
    });

    it('should correctly parse string cents values from database', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'D1',
                discount_amount_cents: '999', current_max_price_cents: '1001',
                offer_id: 10, offer_name: 'Penny test'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: true });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.details[0].oldCap).toBe(999);
        expect(result.details[0].newCap).toBe(1001);
    });

    it('should handle boundary case: stored cap is 1 cent below current price', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'D1',
                discount_amount_cents: '1499', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Boundary'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: true });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.details[0].oldCap).toBe(1499);
        expect(result.details[0].newCap).toBe(1500);
    });

    // BACKLOG-70: price cap now syncs both directions
    it('should update discount when current price DECREASES below stored cap', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'DISC_1',
                discount_amount_cents: '2000', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Price Drop'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: true });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.upToDate).toBe(0);
        expect(result.details[0]).toEqual({
            rewardId: 1,
            offerName: 'Price Drop',
            oldCap: 2000,
            newCap: 1500,
            direction: 'decrease'
        });
        expect(mockUpdateRewardDiscountAmount).toHaveBeenCalledWith({
            merchantId: 1,
            squareDiscountId: 'DISC_1',
            newAmountCents: 1500,
            rewardId: 1
        });
    });

    it('should include direction "increase" when price goes up', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'D1',
                discount_amount_cents: '1000', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Price Up'
            }]
        });
        mockUpdateRewardDiscountAmount.mockResolvedValueOnce({ success: true });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.details[0].direction).toBe('increase');
    });

    it('should mark as up-to-date only when prices are exactly equal', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'D1',
                discount_amount_cents: '1500', current_max_price_cents: '1500',
                offer_id: 10, offer_name: 'Same'
            }]
        });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.upToDate).toBe(1);
        expect(result.updated).toBe(0);
        expect(mockUpdateRewardDiscountAmount).not.toHaveBeenCalled();
    });
});

// ============================================================================
// TESTS — recreateDiscountIfInvalid (BACKLOG-69)
// ============================================================================

describe('recreateDiscountIfInvalid', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should clear IDs and recreate discount successfully', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: true });

        const result = await recreateDiscountIfInvalid({
            merchantId: 1,
            reward: { id: 10, square_customer_id: 'CUST_1', offer_id: 5 }
        });

        expect(result.success).toBe(true);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('square_group_id = NULL'),
            [10, 1]
        );
        expect(mockCreateSquareCustomerGroupDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'CUST_1',
            internalRewardId: 10,
            offerId: 5
        });
    });

    it('should return error when recreation fails', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({
            success: false, error: 'Square API error'
        });

        const result = await recreateDiscountIfInvalid({
            merchantId: 1,
            reward: { id: 10, square_customer_id: 'CUST_1', offer_id: 5 }
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Square API error');
    });

    it('should skip clearing IDs when clearIds is false', async () => {
        mockCreateSquareCustomerGroupDiscount.mockResolvedValueOnce({ success: true });

        const result = await recreateDiscountIfInvalid({
            merchantId: 1,
            reward: { id: 10, square_customer_id: 'CUST_1', offer_id: 5 },
            clearIds: false
        });

        expect(result.success).toBe(true);
        // No UPDATE query should have been called
        expect(db.query).not.toHaveBeenCalled();
        expect(mockCreateSquareCustomerGroupDiscount).toHaveBeenCalled();
    });
});
