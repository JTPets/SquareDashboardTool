/**
 * Tests for services/loyalty-admin/square-discount-service.js
 *
 * T-1: Financial/loyalty services — Square discount CRUD.
 * Focus on: orchestration failure cleanup, zero-dollar discount safety,
 * idempotency, catalog object lifecycle.
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockFetch = jest.fn();
global.fetch = mockFetch;

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
    loyaltyLogger: { squareApi: jest.fn(), debug: jest.fn(), audit: jest.fn(), error: jest.fn() }
}));

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: mockFetch,
    getSquareAccessToken: jest.fn().mockResolvedValue('test-token'),
    generateIdempotencyKey: jest.fn(prefix => `${prefix}-idem`),
    getSquareApi: jest.fn().mockReturnValue({
        getMerchantToken: jest.fn().mockResolvedValue('test-token'),
        makeSquareRequest: jest.fn().mockResolvedValue({})
    })
}));

// discount-validation-service was migrated onto square-client in Task 4.
// Bridge makeSquareRequest onto the same mockFetch queue the validation
// tests below were written against (ok/status/json response shape), so
// those tests keep driving it with their existing mockFetch helpers.
jest.mock('../../../services/square/square-client', () => {
    class SquareApiError extends Error {
        constructor(message, { status, endpoint, details = [], nonRetryable = false } = {}) {
            super(message);
            this.name = 'SquareApiError';
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
            this.nonRetryable = nonRetryable;
            this.squareErrors = details;
        }
    }
    return {
        // Delegate to shared-utils' getSquareAccessToken so legacy tests that
        // drive validation via getSquareAccessToken.mockResolvedValueOnce(null)
        // keep working after the migration.
        getMerchantToken: jest.fn(async (merchantId) => {
            const { getSquareAccessToken } = require('../../../services/loyalty-admin/shared-utils');
            const token = await getSquareAccessToken(merchantId);
            if (!token) throw new Error(`Merchant ${merchantId} has no access token configured`);
            return token;
        }),
        makeSquareRequest: jest.fn(async (endpoint, opts = {}) => {
            const response = await mockFetch(`https://connect.squareup.com${endpoint}`, opts);
            const data = await response.json();
            if (!response.ok) {
                throw new SquareApiError(`Square API error: ${response.status}`, {
                    status: response.status,
                    endpoint,
                    details: data.errors || []
                });
            }
            return data;
        }),
        SquareApiError,
        sleep: () => Promise.resolve(),
        SQUARE_BASE_URL: 'https://connect.squareup.com',
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 1000
    };
});

jest.mock('../../../services/loyalty-admin/customer-admin-service', () => ({
    getCustomerDetails: jest.fn().mockResolvedValue({ displayName: 'John Doe' })
}));

jest.mock('../../../utils/square-catalog-cleanup', () => ({
    deleteCatalogObjects: jest.fn().mockResolvedValue({
        success: true,
        deleted: ['d1', 'd2', 'd3'],
        errors: []
    }),
    deleteCustomerGroupWithMembers: jest.fn().mockResolvedValue({
        customersRemoved: true,
        groupDeleted: true
    })
}));

const db = require('../../../utils/database');
const { getSquareAccessToken } = require('../../../services/loyalty-admin/shared-utils');
const { deleteCatalogObjects, deleteCustomerGroupWithMembers } = require('../../../utils/square-catalog-cleanup');
const {
    getSquareLoyaltyProgram,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    updateCustomerRewardNote
} = require('../../../services/loyalty-admin/square-discount-service');
const {
    createRewardCustomerGroup,
    addCustomerToGroup,
    removeCustomerFromGroup,
    deleteCustomerGroup
} = require('../../../services/loyalty-admin/square-customer-group-service');
const {
    createRewardDiscount,
    deleteRewardDiscountObjects,
    updateRewardDiscountAmount
} = require('../../../services/loyalty-admin/square-discount-catalog-service');
const {
    syncRewardDiscountPrices,
    validateEarnedRewardsDiscounts
} = require('../../../services/loyalty-admin/discount-validation-service');

// ============================================================================
// HELPERS
// ============================================================================

function mockFetchSuccess(data) {
    return mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data))
    });
}

function mockFetchError(status, data = {}) {
    return mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data))
    });
}

// ============================================================================
// TESTS — getSquareLoyaltyProgram
// ============================================================================

describe('getSquareLoyaltyProgram', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return null when no access token', async () => {
        getSquareAccessToken.mockResolvedValueOnce(null);
        const result = await getSquareLoyaltyProgram(1);
        expect(result).toBeNull();
    });

    it('should return null when program not found (404)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve('')
        });

        const result = await getSquareLoyaltyProgram(1);
        expect(result).toBeNull();
    });

    it('should return program data on success', async () => {
        mockFetchSuccess({ program: { id: 'prog_1', terminology: { one: 'point', other: 'points' } } });

        const result = await getSquareLoyaltyProgram(1);
        expect(result).toEqual({ id: 'prog_1', terminology: { one: 'point', other: 'points' } });
    });

    it('should return null on API error', async () => {
        mockFetchError(500, { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] });

        const result = await getSquareLoyaltyProgram(1);
        expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

        const result = await getSquareLoyaltyProgram(1);
        expect(result).toBeNull();
    });
});

// ============================================================================
// TESTS — createRewardCustomerGroup
// ============================================================================

describe('createRewardCustomerGroup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return failure when no access token', async () => {
        getSquareAccessToken.mockResolvedValueOnce(null);

        const result = await createRewardCustomerGroup({
            merchantId: 1, internalRewardId: 10, offerName: 'Test', customerName: 'John'
        });

        expect(result.success).toBe(false);
    });

    it('should create group and return groupId', async () => {
        mockFetchSuccess({ group: { id: 'grp_123' } });

        const result = await createRewardCustomerGroup({
            merchantId: 1, internalRewardId: 10, offerName: 'Buy 12', customerName: 'John Doe'
        });

        expect(result.success).toBe(true);
        expect(result.groupId).toBe('grp_123');
    });

    it('should truncate group name to 255 chars', async () => {
        const longName = 'A'.repeat(300);
        mockFetchSuccess({ group: { id: 'grp_123' } });

        await createRewardCustomerGroup({
            merchantId: 1, internalRewardId: 10, offerName: longName, customerName: 'John'
        });

        const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(fetchBody.group.name.length).toBeLessThanOrEqual(255);
    });

    it('should return failure when no group ID in response', async () => {
        mockFetchSuccess({ group: null });

        const result = await createRewardCustomerGroup({
            merchantId: 1, internalRewardId: 10, offerName: 'Test', customerName: 'John'
        });

        expect(result.success).toBe(false);
    });
});

// ============================================================================
// TESTS — createRewardDiscount
// ============================================================================

describe('createRewardDiscount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return failure when no access token', async () => {
        getSquareAccessToken.mockResolvedValueOnce(null);

        const result = await createRewardDiscount({
            merchantId: 1, internalRewardId: 10, groupId: 'grp_1',
            offerName: 'Test', variationIds: ['var_1'], maxDiscountAmountCents: 3999
        });

        expect(result.success).toBe(false);
    });

    it('should create discount + product set + pricing rule in batch', async () => {
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'REAL_DISC_1' },
                { client_object_id: '#loyalty-productset-10', object_id: 'REAL_PS_1' },
                { client_object_id: '#loyalty-pricingrule-10', object_id: 'REAL_PR_1' }
            ]
        });

        const result = await createRewardDiscount({
            merchantId: 1, internalRewardId: 10, groupId: 'grp_1',
            offerName: 'Buy 12 Get 1 Free', variationIds: ['var_1', 'var_2'],
            maxDiscountAmountCents: 5500
        });

        expect(result.success).toBe(true);
        expect(result.discountId).toBe('REAL_DISC_1');
        expect(result.productSetId).toBe('REAL_PS_1');
        expect(result.pricingRuleId).toBe('REAL_PR_1');

        // Verify the request body structure
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const objects = body.batches[0].objects;
        expect(objects).toHaveLength(3);

        // Discount is 100% with safety cap
        const discount = objects.find(o => o.type === 'DISCOUNT');
        expect(discount.discount_data.percentage).toBe('100');
        expect(discount.discount_data.maximum_amount_money.amount).toBe(5500);
        expect(discount.discount_data.maximum_amount_money.currency).toBe('CAD');

        // Product set has correct variation IDs
        const productSet = objects.find(o => o.type === 'PRODUCT_SET');
        expect(productSet.product_set_data.product_ids_any).toEqual(['var_1', 'var_2']);
        expect(productSet.product_set_data.quantity_exact).toBe(1);

        // Pricing rule links discount, product set, and group
        const rule = objects.find(o => o.type === 'PRICING_RULE');
        expect(rule.pricing_rule_data.customer_group_ids_any).toEqual(['grp_1']);
    });

    it('should return failure when ID mappings are incomplete', async () => {
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'REAL_DISC_1' }
                // Missing product set and pricing rule
            ]
        });

        const result = await createRewardDiscount({
            merchantId: 1, internalRewardId: 10, groupId: 'grp_1',
            offerName: 'Test', variationIds: ['var_1'], maxDiscountAmountCents: 3999
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Missing ID mappings');
    });
});

// ============================================================================
// TESTS — createSquareCustomerGroupDiscount (orchestrator)
// ============================================================================

describe('createSquareCustomerGroupDiscount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return failure when offer not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 999
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Offer not found');
    });

    it('should return failure when offer has no qualifying variations', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: [null] }]
        });

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('No qualifying variations');
    });

    it('should refuse to create discount with $0 safety cap', async () => {
        // Mock offer query
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Mock group creation
        mockFetchSuccess({ group: { id: 'grp_1' } });

        // Mock add customer to group
        mockFetchSuccess({});

        // Mock price query — zero both ways
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '0', max_catalog_price_cents: '0' }]
        });

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot determine discount amount');
    });

    it('should use catalog price when higher than purchase price', async () => {
        // Offer
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Group creation
        mockFetchSuccess({ group: { id: 'grp_1' } });
        // Add customer to group
        mockFetchSuccess({});

        // Price query — catalog > purchase
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '3000', max_catalog_price_cents: '4500' }]
        });

        // Discount creation
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'D1' },
                { client_object_id: '#loyalty-productset-10', object_id: 'PS1' },
                { client_object_id: '#loyalty-pricingrule-10', object_id: 'PR1' }
            ]
        });

        // Update reward record
        db.query.mockResolvedValueOnce({ rows: [] });

        // Customer reward note (GET + PUT)
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchSuccess({});

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(true);

        // Verify the discount used 4500 (catalog) not 3000 (purchase)
        const discountBody = JSON.parse(mockFetch.mock.calls[2][1].body);
        const discountObj = discountBody.batches[0].objects.find(o => o.type === 'DISCOUNT');
        expect(discountObj.discount_data.maximum_amount_money.amount).toBe(4500);
    });

    it('should cleanup group when add-customer-to-group fails', async () => {
        // Offer
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Group creation succeeds
        mockFetchSuccess({ group: { id: 'grp_cleanup' } });

        // Add customer to group FAILS
        mockFetchError(400, { errors: [{ code: 'CUSTOMER_NOT_FOUND' }] });

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(false);
    });

    it('should cleanup group + customer when discount creation fails', async () => {
        // Offer
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Group creation succeeds
        mockFetchSuccess({ group: { id: 'grp_cleanup' } });
        // Add customer succeeds
        mockFetchSuccess({});
        // Price query
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '5000', max_catalog_price_cents: '0' }]
        });
        // Discount creation FAILS
        mockFetchError(500, { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] });

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(false);
    });
});

// ============================================================================
// TESTS — cleanupSquareCustomerGroupDiscount
// ============================================================================

describe('cleanupSquareCustomerGroupDiscount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return failure when reward not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 999
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Reward not found');
    });

    it('should cleanup all Square objects and clear local IDs', async () => {
        // Reward lookup
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: 'grp_1',
                square_discount_id: 'disc_1',
                square_product_set_id: 'ps_1',
                square_pricing_rule_id: 'pr_1',
                offer_id: 10,
                offer_name: 'Buy 12'
            }]
        });

        // Clear local IDs
        db.query.mockResolvedValueOnce({ rows: [] });

        // Customer note update (GET + PUT)
        mockFetchSuccess({ customer: { note: '🎁 REWARD: Free Buy 12', version: 2 } });
        mockFetchSuccess({});

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 42
        });

        expect(result.success).toBe(true);

        // Verify group + members cleanup
        expect(deleteCustomerGroupWithMembers).toHaveBeenCalledWith(1, 'grp_1', ['cust_1']);

        // Verify catalog objects deletion
        expect(deleteCatalogObjects).toHaveBeenCalledWith(
            1,
            ['pr_1', 'ps_1', 'disc_1'],
            { auditContext: 'loyalty-reward-cleanup' }
        );

        // Verify local IDs cleared
        const clearCall = db.query.mock.calls[1];
        expect(clearCall[0]).toContain('square_group_id = NULL');
    });

    it('should handle missing group_id gracefully', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: null,
                square_discount_id: 'disc_1',
                square_product_set_id: null,
                square_pricing_rule_id: null,
                offer_id: 10,
                offer_name: 'Buy 12'
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs
        mockFetchSuccess({ customer: { note: '', version: 1 } }); // Note (GET)

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 42
        });

        expect(result.success).toBe(true);
        expect(deleteCustomerGroupWithMembers).not.toHaveBeenCalled();
    });
});

// ============================================================================
// TESTS — syncRewardDiscountPrices
// ============================================================================

describe('syncRewardDiscountPrices', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should throw when merchantId is missing', async () => {
        await expect(syncRewardDiscountPrices({})).rejects.toThrow('merchantId is required');
    });

    it('should skip rewards with zero current price', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'disc_1',
                discount_amount_cents: 5000, offer_id: 10,
                offer_name: 'Test', current_max_price_cents: '0'
            }]
        });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.skipped).toBe(1);
        expect(result.updated).toBe(0);
    });

    // BACKLOG-70: price cap now syncs both directions — cap > price triggers downward update
    it('should update when cap exceeds current price (bidirectional sync)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'disc_1',
                discount_amount_cents: '5000', offer_id: 10,
                offer_name: 'Test', current_max_price_cents: '4500'
            }]
        });

        // Mock the GET to fetch existing discount (for updateRewardDiscountAmount)
        mockFetchSuccess({
            object: {
                id: 'disc_1',
                version: 5,
                discount_data: {
                    name: 'Loyalty: Test',
                    discount_type: 'FIXED_PERCENTAGE',
                    percentage: '100',
                    maximum_amount_money: { amount: 5000, currency: 'CAD' }
                }
            }
        });

        // Mock the upsert
        mockFetchSuccess({});

        // Mock local DB update
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.upToDate).toBe(0);
        expect(result.details[0].oldCap).toBe(5000);
        expect(result.details[0].newCap).toBe(4500);
        expect(result.details[0].direction).toBe('decrease');
    });

    it('should update when current price exceeds stored cap', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'disc_1',
                discount_amount_cents: '3000', offer_id: 10,
                offer_name: 'Test', current_max_price_cents: '4500'
            }]
        });

        // Mock the GET to fetch existing discount
        mockFetchSuccess({
            object: {
                id: 'disc_1',
                version: 5,
                discount_data: {
                    name: 'Loyalty: Test',
                    discount_type: 'FIXED_PERCENTAGE',
                    percentage: '100',
                    maximum_amount_money: { amount: 3000, currency: 'CAD' }
                }
            }
        });

        // Mock the upsert
        mockFetchSuccess({});

        // Mock local DB update
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.updated).toBe(1);
        expect(result.details[0].oldCap).toBe(3000);
        expect(result.details[0].newCap).toBe(4500);
    });

    it('should handle update failure without crashing', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 1, square_discount_id: 'disc_1',
                discount_amount_cents: '3000', offer_id: 10,
                offer_name: 'Test', current_max_price_cents: '4500'
            }]
        });

        // Fetch existing discount fails
        mockFetchError(500);

        const result = await syncRewardDiscountPrices({ merchantId: 1 });

        expect(result.failed).toBe(1);
        expect(result.updated).toBe(0);
    });
});

// ============================================================================
// TESTS — updateCustomerRewardNote
// ============================================================================

describe('updateCustomerRewardNote', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should add reward line to empty note', async () => {
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchSuccess({});

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Buy 12 Get 1 Free'
        });

        expect(result.success).toBe(true);

        // Verify the PUT body
        const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(putBody.note).toBe('🎁 REWARD: Free Buy 12 Get 1 Free');
        expect(putBody.version).toBe(1);
    });

    it('should append to existing note without overwriting', async () => {
        mockFetchSuccess({ customer: { note: 'Delivery: Back door', version: 3 } });
        mockFetchSuccess({});

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Dog Food'
        });

        expect(result.success).toBe(true);
        const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(putBody.note).toBe('Delivery: Back door\n🎁 REWARD: Free Dog Food');
    });

    it('should not duplicate existing reward line (idempotent)', async () => {
        mockFetchSuccess({
            customer: { note: '🎁 REWARD: Free Dog Food', version: 4 }
        });

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Dog Food'
        });

        expect(result.success).toBe(true);
        // Should NOT have made a PUT call
        expect(mockFetch).toHaveBeenCalledTimes(1); // Only the GET
    });

    it('should remove reward line and preserve other content', async () => {
        mockFetchSuccess({
            customer: {
                note: 'Delivery: Back door\n🎁 REWARD: Free Dog Food\nOther note',
                version: 5
            }
        });
        mockFetchSuccess({});

        const result = await updateCustomerRewardNote({
            operation: 'remove', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Dog Food'
        });

        expect(result.success).toBe(true);
        const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(putBody.note).toBe('Delivery: Back door\nOther note');
    });

    it('should return success when removing non-existent line (idempotent)', async () => {
        mockFetchSuccess({ customer: { note: 'Some note', version: 2 } });

        const result = await updateCustomerRewardNote({
            operation: 'remove', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Nonexistent Offer'
        });

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1); // Only the GET
    });

    it('should return error for invalid operation', async () => {
        mockFetchSuccess({ customer: { note: '', version: 1 } });

        const result = await updateCustomerRewardNote({
            operation: 'invalid', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Test'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid operation');
    });

    it('should return failure when no access token', async () => {
        getSquareAccessToken.mockResolvedValueOnce(null);

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Test'
        });

        expect(result.success).toBe(false);
    });
});

// ============================================================================
// TESTS — validateEarnedRewardsDiscounts
// ============================================================================

describe('validateEarnedRewardsDiscounts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should throw when merchantId is missing', async () => {
        await expect(validateEarnedRewardsDiscounts({})).rejects.toThrow('merchantId is required');
    });

    it('should return failure when no access token', async () => {
        getSquareAccessToken.mockResolvedValueOnce(null);

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.success).toBe(false);
    });

    it('should report MISSING_SQUARE_IDS issue', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: null, square_group_id: null,
                offer_name: 'Test', earned_at: '2026-01-01', square_customer_id: 'cust_1',
                offer_id: 10
            }]
        });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.totalEarned).toBe(1);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].issue).toBe('MISSING_SQUARE_IDS');
    });

    it('should report DISCOUNT_NOT_FOUND for 404 response', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: 'disc_gone', square_group_id: 'grp_1',
                offer_name: 'Test', earned_at: '2026-01-01', square_customer_id: 'cust_1',
                offer_id: 10
            }]
        });

        mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].issue).toBe('DISCOUNT_NOT_FOUND');
    });

    it('should validate successfully when discount exists and is active', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: 'disc_1', square_group_id: 'grp_1',
                offer_name: 'Test', earned_at: '2026-01-01', square_customer_id: 'cust_1',
                offer_id: 10
            }]
        });

        // Discount check
        mockFetchSuccess({ object: { id: 'disc_1', is_deleted: false } });

        // Customer group check
        mockFetchSuccess({ customer: { group_ids: ['grp_1', 'other_grp'] } });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.validated).toBe(1);
        expect(result.issues).toHaveLength(0);
    });

    it('should report CUSTOMER_NOT_IN_GROUP', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, square_discount_id: 'disc_1', square_group_id: 'grp_1',
                offer_name: 'Test', earned_at: '2026-01-01', square_customer_id: 'cust_1',
                offer_id: 10
            }]
        });

        // Discount check passes
        mockFetchSuccess({ object: { id: 'disc_1', is_deleted: false } });

        // Customer NOT in group
        mockFetchSuccess({ customer: { group_ids: ['other_grp'] } });

        const result = await validateEarnedRewardsDiscounts({ merchantId: 1 });

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].issue).toBe('CUSTOMER_NOT_IN_GROUP');
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — createSquareCustomerGroupDiscount orchestration
// ============================================================================

describe('createSquareCustomerGroupDiscount — additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should use purchase price when higher than catalog price', async () => {
        // Offer
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Group creation
        mockFetchSuccess({ group: { id: 'grp_1' } });
        // Add customer
        mockFetchSuccess({});

        // Price query — purchase > catalog
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '6000', max_catalog_price_cents: '4500' }]
        });

        // Discount creation
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'D1' },
                { client_object_id: '#loyalty-productset-10', object_id: 'PS1' },
                { client_object_id: '#loyalty-pricingrule-10', object_id: 'PR1' }
            ]
        });

        // Update reward record
        db.query.mockResolvedValueOnce({ rows: [] });

        // Customer reward note (GET + PUT)
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchSuccess({});

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(true);

        // Verify discount used 6000 (purchase) not 4500 (catalog)
        const discountBody = JSON.parse(mockFetch.mock.calls[2][1].body);
        const discountObj = discountBody.batches[0].objects.find(o => o.type === 'DISCOUNT');
        expect(discountObj.discount_data.maximum_amount_money.amount).toBe(6000);
    });

    it('should store Square object IDs in reward record on success', async () => {
        // Offer
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Group creation
        mockFetchSuccess({ group: { id: 'grp_created' } });
        // Add customer
        mockFetchSuccess({});
        // Price query
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '5000', max_catalog_price_cents: '0' }]
        });
        // Discount creation
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'D_FINAL' },
                { client_object_id: '#loyalty-productset-10', object_id: 'PS_FINAL' },
                { client_object_id: '#loyalty-pricingrule-10', object_id: 'PR_FINAL' }
            ]
        });
        // Update reward record
        db.query.mockResolvedValueOnce({ rows: [] });
        // Customer note (GET + PUT)
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchSuccess({});

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(true);

        // Verify the UPDATE query stored the correct IDs
        // db.query calls: [0]=offer, [1]=price, [2]=update reward
        const updateCall = db.query.mock.calls[2];
        expect(updateCall[0]).toContain('square_group_id = $1');
        expect(updateCall[1]).toEqual([
            'grp_created', 'D_FINAL', 'PS_FINAL', 'PR_FINAL', 5000, 10, 1
        ]);
    });

    it('should use truncated customer ID when getCustomerDetails returns null', async () => {
        const { getCustomerDetails } = require('../../../services/loyalty-admin/customer-admin-service');
        getCustomerDetails.mockResolvedValueOnce(null);

        // Offer
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: ['var_1'] }]
        });

        // Group creation
        mockFetchSuccess({ group: { id: 'grp_1' } });
        // Add customer
        mockFetchSuccess({});
        // Price
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '3000', max_catalog_price_cents: '0' }]
        });
        // Discount
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'D1' },
                { client_object_id: '#loyalty-productset-10', object_id: 'PS1' },
                { client_object_id: '#loyalty-pricingrule-10', object_id: 'PR1' }
            ]
        });
        // Update
        db.query.mockResolvedValueOnce({ rows: [] });
        // Note
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchSuccess({});

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'ABCDEFGHIJKLMNOP', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(true);

        // Verify group name used truncated customer ID (first 8 chars)
        const groupBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(groupBody.group.name).toContain('ABCDEFGH');
    });

    it('should return {success: false} when unexpected error thrown', async () => {
        db.query.mockRejectedValueOnce(new Error('Unexpected DB crash'));

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Unexpected DB crash');
    });

    it('should filter out null variation_ids from offer query', async () => {
        // Offer with mixed null and valid variation_ids (LEFT JOIN behavior)
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, offer_name: 'Test', variation_ids: [null, 'var_1', null, 'var_2'] }]
        });

        // Group
        mockFetchSuccess({ group: { id: 'grp_1' } });
        // Add customer
        mockFetchSuccess({});
        // Price
        db.query.mockResolvedValueOnce({
            rows: [{ max_purchase_price_cents: '4000', max_catalog_price_cents: '0' }]
        });
        // Discount
        mockFetchSuccess({
            id_mappings: [
                { client_object_id: '#loyalty-discount-10', object_id: 'D1' },
                { client_object_id: '#loyalty-productset-10', object_id: 'PS1' },
                { client_object_id: '#loyalty-pricingrule-10', object_id: 'PR1' }
            ]
        });
        db.query.mockResolvedValueOnce({ rows: [] });
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchSuccess({});

        const result = await createSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 10, offerId: 10
        });

        expect(result.success).toBe(true);

        // Verify only non-null IDs passed to discount
        const discountBody = JSON.parse(mockFetch.mock.calls[2][1].body);
        const productSet = discountBody.batches[0].objects.find(o => o.type === 'PRODUCT_SET');
        expect(productSet.product_set_data.product_ids_any).toEqual(['var_1', 'var_2']);
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — cleanupSquareCustomerGroupDiscount edge cases
// ============================================================================

describe('cleanupSquareCustomerGroupDiscount — additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should skip note removal when offer_name is null', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: 'grp_1',
                square_discount_id: 'disc_1',
                square_product_set_id: null,
                square_pricing_rule_id: null,
                offer_id: 10,
                offer_name: null
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 42
        });

        expect(result.success).toBe(true);
        // No fetchWithTimeout calls — note update was skipped
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip note removal when squareCustomerId is null', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: 'grp_1',
                square_discount_id: 'disc_1',
                square_product_set_id: null,
                square_pricing_rule_id: null,
                offer_id: 10,
                offer_name: 'Buy 12'
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: null, internalRewardId: 42
        });

        expect(result.success).toBe(true);
        // Note update skipped (both offer_name AND squareCustomerId required)
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should pass empty customerIds when squareCustomerId is null', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: 'grp_1',
                square_discount_id: null,
                square_product_set_id: null,
                square_pricing_rule_id: null,
                offer_id: 10,
                offer_name: null
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: null, internalRewardId: 42
        });

        expect(result.success).toBe(true);
        expect(deleteCustomerGroupWithMembers).toHaveBeenCalledWith(1, 'grp_1', []);
    });

    it('should return {success: false} when unexpected error thrown', async () => {
        db.query.mockRejectedValueOnce(new Error('Network partition'));

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 42
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network partition');
    });

    it('should clear all Square IDs from reward record after cleanup', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: 'grp_1',
                square_discount_id: 'disc_1',
                square_product_set_id: 'ps_1',
                square_pricing_rule_id: 'pr_1',
                offer_id: 10,
                offer_name: 'Buy 12'
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs

        // Note update
        mockFetchSuccess({ customer: { note: '🎁 REWARD: Free Buy 12', version: 2 } });
        mockFetchSuccess({});

        await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 42
        });

        // Verify the NULL update query
        const clearCall = db.query.mock.calls[1];
        expect(clearCall[0]).toContain('square_group_id = NULL');
        expect(clearCall[0]).toContain('square_discount_id = NULL');
        expect(clearCall[0]).toContain('square_product_set_id = NULL');
        expect(clearCall[0]).toContain('square_pricing_rule_id = NULL');
        expect(clearCall[1]).toEqual([42, 1]);
    });

    it('should handle reward with all null Square IDs gracefully', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                square_group_id: null,
                square_discount_id: null,
                square_product_set_id: null,
                square_pricing_rule_id: null,
                offer_id: 10,
                offer_name: null
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [] }); // Clear IDs (still runs)

        const result = await cleanupSquareCustomerGroupDiscount({
            merchantId: 1, squareCustomerId: 'cust_1', internalRewardId: 42
        });

        expect(result.success).toBe(true);
        expect(deleteCustomerGroupWithMembers).not.toHaveBeenCalled();
        // deleteCatalogObjects still called with null IDs (it handles them)
        expect(deleteCatalogObjects).toHaveBeenCalled();
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — updateCustomerRewardNote retry behavior
// ============================================================================

describe('updateCustomerRewardNote — retry behavior', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should retry on 409 version conflict and succeed on second attempt', async () => {
        // First attempt: GET succeeds, PUT returns 409
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetch.mockResolvedValueOnce({
            ok: false, status: 409,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve('VERSION_CONFLICT')
        });

        // Second attempt: GET succeeds with new version, PUT succeeds
        mockFetchSuccess({ customer: { note: '', version: 2 } });
        mockFetchSuccess({});

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Test Offer'
        });

        expect(result.success).toBe(true);
        // 4 total fetch calls: GET, PUT(409), GET, PUT(200)
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('should return max retries exceeded after 3 consecutive 409s', async () => {
        // 3 attempts (0, 1, 2) — all get 409 on PUT
        for (let i = 0; i < 3; i++) {
            mockFetchSuccess({ customer: { note: '', version: i + 1 } });
            mockFetch.mockResolvedValueOnce({
                ok: false, status: 409,
                json: () => Promise.resolve({}),
                text: () => Promise.resolve('VERSION_CONFLICT')
            });
        }

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Test Offer'
        });

        expect(result.success).toBe(false);
        // On last attempt (attempt === MAX_RETRIES), 409 falls through to generic error handler
        expect(result.error).toContain('Square API error: 409');
    });

    it('should not retry non-409 PUT errors', async () => {
        mockFetchSuccess({ customer: { note: '', version: 1 } });
        mockFetchError(500, { errors: [{ code: 'INTERNAL_ERROR' }] });

        const result = await updateCustomerRewardNote({
            operation: 'add', merchantId: 1,
            squareCustomerId: 'cust_1', offerName: 'Test'
        });

        expect(result.success).toBe(false);
        // Only 2 calls: GET + PUT (no retry)
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
