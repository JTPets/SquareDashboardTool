/**
 * Tests for Fix 5: Velocity idempotency
 *
 * Verifies that updateSalesVelocityFromOrder skips duplicate calls
 * when both order.updated and order.fulfillment.updated fire for
 * the same COMPLETED order.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: jest.fn(),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn()
}));

jest.mock('../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 100 },
    SYNC: { BATCH_DELAY_MS: 0 }
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const {
    updateSalesVelocityFromOrder,
    _recentlyProcessedVelocityOrders
} = require('../../services/square/square-velocity');

describe('Fix 5: Velocity idempotency', () => {
    const completedOrder = {
        id: 'order_vel_1',
        state: 'COMPLETED',
        line_items: [
            {
                catalog_object_id: 'var_1',
                quantity: '2',
                total_money: { amount: 2000, currency: 'CAD' }
            }
        ],
        location_id: 'loc_1',
        closed_at: new Date().toISOString()
    };

    beforeEach(() => {
        jest.clearAllMocks();
        _recentlyProcessedVelocityOrders.clear();

        // Mock DB: variations exist
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            // Upsert velocity
            return { rows: [], rowCount: 1 };
        });
    });

    afterEach(() => {
        _recentlyProcessedVelocityOrders.clear();
    });

    it('should increment velocity on first call', async () => {
        const result = await updateSalesVelocityFromOrder(completedOrder, 1);

        expect(result.updated).toBeGreaterThan(0);
        expect(result.reason).toBeUndefined();
        // Should have logged the info-level update
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Updating sales velocity'),
            expect.objectContaining({ orderId: 'order_vel_1' })
        );
    });

    it('should skip second call for same orderId within 120s', async () => {
        // First call
        await updateSalesVelocityFromOrder(completedOrder, 1);

        jest.clearAllMocks();

        // Second call for same order
        const result = await updateSalesVelocityFromOrder(completedOrder, 1);

        expect(result.updated).toBe(0);
        expect(result.reason).toBe('Already processed (dedup)');
        // Should have logged debug with reason
        expect(logger.debug).toHaveBeenCalledWith(
            'Velocity already updated for order',
            expect.objectContaining({
                orderId: 'order_vel_1',
                merchantId: 1,
                reason: 'velocity_dedup_guard'
            })
        );
        // Should NOT have called db.query (skipped before DB operations)
        expect(db.query).not.toHaveBeenCalled();
    });

    it('should process different orderIds independently', async () => {
        await updateSalesVelocityFromOrder(completedOrder, 1);

        jest.clearAllMocks();

        const differentOrder = { ...completedOrder, id: 'order_vel_2' };
        const result = await updateSalesVelocityFromOrder(differentOrder, 1);

        expect(result.updated).toBeGreaterThan(0);
        expect(result.reason).toBeUndefined();
    });

    it('should process same orderId again after TTL expires', async () => {
        await updateSalesVelocityFromOrder(completedOrder, 1);

        // Manually expire the cache entry
        _recentlyProcessedVelocityOrders.cache.set('order_vel_1:1', {
            value: true,
            expires: Date.now() - 1000
        });

        jest.clearAllMocks();

        const result = await updateSalesVelocityFromOrder(completedOrder, 1);

        expect(result.updated).toBeGreaterThan(0);
        expect(result.reason).toBeUndefined();
    });

    it('should still validate order state before dedup check', async () => {
        const draftOrder = { ...completedOrder, state: 'DRAFT' };
        const result = await updateSalesVelocityFromOrder(draftOrder, 1);

        expect(result.reason).toBe('Order not completed');
        // Should NOT add to dedup cache (validation failed before dedup)
        expect(_recentlyProcessedVelocityOrders.has('order_vel_1:1')).toBe(false);
    });
});
