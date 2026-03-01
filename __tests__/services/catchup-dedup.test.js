/**
 * Tests for Fix 4: Deduplicate loyalty catchup triggers
 *
 * Verifies that runLoyaltyCatchup skips redundant calls when multiple
 * webhook types (loyalty.event.created, loyalty.account.updated,
 * customer.updated) fire for the same customer within seconds.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../utils/loyalty-logger', () => ({
    loyaltyLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() }
}));

jest.mock('./../../services/loyalty-admin/constants', () => ({
    AuditActions: {}
}));

jest.mock('../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: jest.fn(),
    getSquareAccessToken: jest.fn().mockResolvedValue('test-token')
}));

jest.mock('../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn()
}));

jest.mock('../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn().mockResolvedValue({
        alreadyProcessed: false,
        purchaseEvents: [],
        rewardEarned: false
    })
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getSquareAccessToken } = require('../../services/loyalty-admin/shared-utils');
const { runLoyaltyCatchup, _catchupRecentlyRan } = require('../../services/loyalty-admin/backfill-service');

describe('Fix 4: Deduplicate loyalty catchup triggers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _catchupRecentlyRan.clear();

        // Mock DB queries needed by runLoyaltyCatchup
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT DISTINCT square_customer_id')) {
                return { rows: [{ square_customer_id: 'cust_123' }] };
            }
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            // For the Orders Search fetch mock
            return { rows: [] };
        });

        // Mock fetch for Square API calls
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ orders: [] })
        });
    });

    afterEach(() => {
        _catchupRecentlyRan.clear();
        delete global.fetch;
    });

    it('should run catchup on first call for a customer', async () => {
        const result = await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_123'],
            periodDays: 1,
            maxCustomers: 1
        });

        expect(result.skippedByDedup).toBeUndefined();
        // Should have called getSquareAccessToken (proceeding past dedup)
        expect(getSquareAccessToken).toHaveBeenCalledWith(1);
    });

    it('should skip catchup on second call within 120s for same customer', async () => {
        // First call
        await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_123'],
            periodDays: 1,
            maxCustomers: 1
        });

        jest.clearAllMocks();

        // Second call for same customer within TTL
        const result = await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_123'],
            periodDays: 1,
            maxCustomers: 1
        });

        expect(result.skippedByDedup).toBe(true);
        expect(result.ordersNewlyTracked).toBe(0);
        // Should NOT have called getSquareAccessToken (skipped early)
        expect(getSquareAccessToken).not.toHaveBeenCalled();
        // Should log debug with reason
        expect(logger.debug).toHaveBeenCalledWith(
            'Loyalty catchup skipped - recently ran for this customer',
            expect.objectContaining({
                customerId: 'cust_123',
                merchantId: 1,
                reason: 'catchup_dedup_guard'
            })
        );
    });

    it('should run again after TTL expires', async () => {
        // Manually set a cache entry that's already expired
        _catchupRecentlyRan.set('cust_123:1', true);
        // Override the cache entry with an expired timestamp
        _catchupRecentlyRan.cache.set('cust_123:1', {
            value: true,
            expires: Date.now() - 1000 // expired 1 second ago
        });

        const result = await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_123'],
            periodDays: 1,
            maxCustomers: 1
        });

        expect(result.skippedByDedup).toBeUndefined();
        expect(getSquareAccessToken).toHaveBeenCalled();
    });

    it('should not interfere between different customer IDs', async () => {
        // First call for customer A
        await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_A'],
            periodDays: 1,
            maxCustomers: 1
        });

        jest.clearAllMocks();

        // Call for different customer B — should NOT be skipped
        const result = await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_B'],
            periodDays: 1,
            maxCustomers: 1
        });

        expect(result.skippedByDedup).toBeUndefined();
        expect(getSquareAccessToken).toHaveBeenCalled();
    });

    it('should not apply dedup for batch catchup (no customerIds)', async () => {
        // First batch call
        await runLoyaltyCatchup({
            merchantId: 1,
            periodDays: 1,
            maxCustomers: 5
        });

        jest.clearAllMocks();

        // Second batch call — should NOT be skipped (dedup only for single-customer)
        const result = await runLoyaltyCatchup({
            merchantId: 1,
            periodDays: 1,
            maxCustomers: 5
        });

        expect(result.skippedByDedup).toBeUndefined();
        expect(getSquareAccessToken).toHaveBeenCalled();
    });

    it('should not apply dedup for multi-customer catchup', async () => {
        await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_A', 'cust_B'],
            periodDays: 1,
            maxCustomers: 2
        });

        jest.clearAllMocks();

        const result = await runLoyaltyCatchup({
            merchantId: 1,
            customerIds: ['cust_A', 'cust_B'],
            periodDays: 1,
            maxCustomers: 2
        });

        expect(result.skippedByDedup).toBeUndefined();
        expect(getSquareAccessToken).toHaveBeenCalled();
    });
});
