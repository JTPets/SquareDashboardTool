/**
 * Tests for services/loyalty-admin/customer-cache-service.js
 *
 * Covers: cacheCustomerDetails, getCachedCustomer, searchCachedCustomers, updateCustomerStats
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const db = require('../../../utils/database');
const {
    cacheCustomerDetails,
    getCachedCustomer,
    searchCachedCustomers,
    updateCustomerStats,
} = require('../../../services/loyalty-admin/customer-cache-service');

const MERCHANT_ID = 1;

describe('customer-cache-service', () => {
    beforeEach(() => jest.clearAllMocks());

    // ========================================================================
    // cacheCustomerDetails
    // ========================================================================

    describe('cacheCustomerDetails', () => {
        test('inserts customer with upsert SQL', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await cacheCustomerDetails({
                id: 'cust-1',
                givenName: 'John',
                familyName: 'Doe',
                phone: '555-1234',
                email: 'john@test.com',
            }, MERCHANT_ID);

            expect(db.query).toHaveBeenCalledTimes(1);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO loyalty_customers');
            expect(sql).toContain('ON CONFLICT');
            expect(params[0]).toBe(MERCHANT_ID);
            expect(params[1]).toBe('cust-1');
            expect(params[2]).toBe('John');
            expect(params[3]).toBe('Doe');
        });

        test('handles camelCase and snake_case field names', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await cacheCustomerDetails({
                id: 'cust-2',
                given_name: 'Jane',
                family_name: 'Smith',
                phone_number: '555-5678',
                email_address: 'jane@test.com',
            }, MERCHANT_ID);

            const params = db.query.mock.calls[0][1];
            expect(params[2]).toBe('Jane');
            expect(params[3]).toBe('Smith');
            expect(params[5]).toBe('555-5678');
            expect(params[6]).toBe('jane@test.com');
        });

        test('skips if customer has no id', async () => {
            await cacheCustomerDetails({}, MERCHANT_ID);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('skips if merchantId is missing', async () => {
            await cacheCustomerDetails({ id: 'c1' }, null);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('does not throw on database error', async () => {
            db.query.mockRejectedValue(new Error('DB down'));

            await expect(cacheCustomerDetails({ id: 'c1' }, MERCHANT_ID))
                .resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // getCachedCustomer
    // ========================================================================

    describe('getCachedCustomer', () => {
        test('returns formatted customer when found', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    id: 'cust-1',
                    given_name: 'John',
                    family_name: 'Doe',
                    display_name: 'John Doe',
                    phone: '555-1234',
                    email: 'john@test.com',
                    company_name: null,
                    total_orders: 5,
                    total_rewards_earned: 2,
                    has_active_rewards: true,
                    last_updated_at: '2026-01-01',
                }]
            });

            const result = await getCachedCustomer('cust-1', MERCHANT_ID);

            expect(result).toEqual({
                id: 'cust-1',
                givenName: 'John',
                familyName: 'Doe',
                displayName: 'John Doe',
                phone: '555-1234',
                email: 'john@test.com',
                companyName: null,
                totalOrders: 5,
                totalRewardsEarned: 2,
                hasActiveRewards: true,
                cached: true,
                lastUpdatedAt: '2026-01-01',
            });
        });

        test('builds displayName from given+family when display_name is null', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    id: 'c1',
                    given_name: 'Jane',
                    family_name: 'Smith',
                    display_name: null,
                    phone: null,
                    email: null,
                    company_name: null,
                    total_orders: 0,
                    total_rewards_earned: 0,
                    has_active_rewards: false,
                    last_updated_at: null,
                }]
            });

            const result = await getCachedCustomer('c1', MERCHANT_ID);

            expect(result.displayName).toBe('Jane Smith');
        });

        test('returns null when not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await getCachedCustomer('missing', MERCHANT_ID);

            expect(result).toBeNull();
        });

        test('returns null for missing params', async () => {
            expect(await getCachedCustomer(null, MERCHANT_ID)).toBeNull();
            expect(await getCachedCustomer('c1', null)).toBeNull();
            expect(db.query).not.toHaveBeenCalled();
        });

        test('returns null on database error', async () => {
            db.query.mockRejectedValue(new Error('DB error'));

            const result = await getCachedCustomer('c1', MERCHANT_ID);

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // searchCachedCustomers
    // ========================================================================

    describe('searchCachedCustomers', () => {
        test('searches by phone number', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 'c1', given_name: 'John', family_name: 'Doe', display_name: 'John Doe', phone: '5551234567', email: null }]
            });

            const result = await searchCachedCustomers('5551234567', MERCHANT_ID);

            expect(result).toHaveLength(1);
            expect(result[0].cached).toBe(true);
            const [sql] = db.query.mock.calls[0];
            expect(sql).toContain('REPLACE');
        });

        test('searches by email', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await searchCachedCustomers('john@test.com', MERCHANT_ID);

            const [sql] = db.query.mock.calls[0];
            expect(sql).toContain('LOWER(email_address)');
        });

        test('searches by name', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await searchCachedCustomers('John', MERCHANT_ID);

            const [sql] = db.query.mock.calls[0];
            expect(sql).toContain('LOWER(display_name)');
            expect(sql).toContain('LOWER(given_name)');
            expect(sql).toContain('LOWER(family_name)');
        });

        test('returns empty for missing query', async () => {
            const result = await searchCachedCustomers('', MERCHANT_ID);
            expect(result).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('returns empty for missing merchantId', async () => {
            const result = await searchCachedCustomers('test', null);
            expect(result).toEqual([]);
        });

        test('returns empty on database error', async () => {
            db.query.mockRejectedValue(new Error('fail'));

            const result = await searchCachedCustomers('test', MERCHANT_ID);

            expect(result).toEqual([]);
        });

        test('builds displayName fallback when display_name is null', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 'c1', given_name: 'Jane', family_name: null, display_name: null, phone: null, email: null }]
            });

            const result = await searchCachedCustomers('Jane', MERCHANT_ID);

            expect(result[0].displayName).toBe('Jane');
        });

        test('uses Unknown when no name available', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 'c1', given_name: null, family_name: null, display_name: null, phone: '555', email: null }]
            });

            const result = await searchCachedCustomers('5551234567', MERCHANT_ID);

            expect(result[0].displayName).toBe('Unknown');
        });
    });

    // ========================================================================
    // updateCustomerStats
    // ========================================================================

    describe('updateCustomerStats', () => {
        test('increments orders and sets last_order_at', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await updateCustomerStats('c1', MERCHANT_ID, { incrementOrders: true });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('total_orders = total_orders + 1');
            expect(sql).toContain('last_order_at = NOW()');
            expect(params).toEqual([MERCHANT_ID, 'c1']);
        });

        test('increments rewards', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await updateCustomerStats('c1', MERCHANT_ID, { incrementRewards: true });

            const [sql] = db.query.mock.calls[0];
            expect(sql).toContain('total_rewards_earned = total_rewards_earned + 1');
        });

        test('sets hasActiveRewards flag', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await updateCustomerStats('c1', MERCHANT_ID, { hasActiveRewards: true });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('has_active_rewards = $3');
            expect(params).toEqual([MERCHANT_ID, 'c1', true]);
        });

        test('handles multiple stats at once', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await updateCustomerStats('c1', MERCHANT_ID, {
                incrementOrders: true,
                incrementRewards: true,
                hasActiveRewards: false,
            });

            const [sql] = db.query.mock.calls[0];
            expect(sql).toContain('total_orders = total_orders + 1');
            expect(sql).toContain('total_rewards_earned = total_rewards_earned + 1');
            expect(sql).toContain('has_active_rewards');
        });

        test('skips query when no stats to update', async () => {
            await updateCustomerStats('c1', MERCHANT_ID, {});
            expect(db.query).not.toHaveBeenCalled();
        });

        test('skips when customerId or merchantId missing', async () => {
            await updateCustomerStats(null, MERCHANT_ID, { incrementOrders: true });
            await updateCustomerStats('c1', null, { incrementOrders: true });
            expect(db.query).not.toHaveBeenCalled();
        });

        test('does not throw on database error', async () => {
            db.query.mockRejectedValue(new Error('DB error'));

            await expect(updateCustomerStats('c1', MERCHANT_ID, { incrementOrders: true }))
                .resolves.toBeUndefined();
        });
    });
});
