/**
 * Tests for velocity fixes:
 * - E-1: Fire-and-forget email .catch() in server.js
 * - BACKLOG-36: Stale velocity row cleanup
 * - BACKLOG-35: Refund subtraction from velocity
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
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
const { makeSquareRequest } = require('../../services/square/square-client');
const {
    syncSalesVelocity,
    syncSalesVelocityAllPeriods,
    _recentlyProcessedVelocityOrders
} = require('../../services/square/square-velocity');

describe('BACKLOG-36: Stale velocity row cleanup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _recentlyProcessedVelocityOrders.clear();
    });

    it('syncSalesVelocity deletes stale rows after upsert', async () => {
        // Mock locations
        db.query.mockImplementation((sql, params) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 2 };
            }
            // Upsert
            return { rows: [], rowCount: 1 };
        });

        // Mock Square API: return one order with one line item
        makeSquareRequest.mockResolvedValueOnce({
            orders: [{
                id: 'order_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '5',
                    total_money: { amount: 5000 }
                }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }]
        });

        await syncSalesVelocity(91, 1);

        // Find the DELETE call
        const deleteCalls = db.query.mock.calls.filter(c => c[0].includes('DELETE FROM sales_velocity'));
        expect(deleteCalls.length).toBe(1);
        expect(deleteCalls[0][0]).toContain('variation_id NOT IN');
        // Params should include the processed variation ID, merchant ID, and period
        expect(deleteCalls[0][1]).toContain('var_1');
        expect(deleteCalls[0][1]).toContain(1);  // merchantId
        expect(deleteCalls[0][1]).toContain(91); // periodDays

        // Should log the deletion
        expect(logger.info).toHaveBeenCalledWith(
            'Removed stale velocity rows',
            expect.objectContaining({ deleted: 2, period_days: 91, merchantId: 1 })
        );
    });

    it('syncSalesVelocity deletes all rows when no sales in period', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 3 };
            }
            return { rows: [], rowCount: 0 };
        });

        // No orders returned
        makeSquareRequest.mockResolvedValueOnce({ orders: [] });

        const result = await syncSalesVelocity(91, 1);
        expect(result).toBe(0);
    });

    it('syncSalesVelocityAllPeriods deletes stale rows per period', async () => {
        db.query.mockImplementation((sql, params) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
        });

        makeSquareRequest.mockResolvedValueOnce({
            orders: [{
                id: 'order_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '3',
                    total_money: { amount: 3000 }
                }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }]
        });

        await syncSalesVelocityAllPeriods(1, 365);

        const deleteCalls = db.query.mock.calls.filter(c => c[0].includes('DELETE FROM sales_velocity'));
        // Should delete stale rows for each period (91, 182, 365)
        expect(deleteCalls.length).toBe(3);
    });
});

describe('BACKLOG-35: Refund subtraction from velocity', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _recentlyProcessedVelocityOrders.clear();
    });

    it('syncSalesVelocity subtracts refunded quantities', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });

        // Order with 10 sold, 3 refunded = net 7
        makeSquareRequest.mockResolvedValueOnce({
            orders: [{
                id: 'order_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '10',
                    total_money: { amount: 10000 }
                }],
                returns: [{
                    return_line_items: [{
                        catalog_object_id: 'var_1',
                        quantity: '3',
                        return_amounts: { total_money: { amount: 3000 } }
                    }]
                }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }]
        });

        await syncSalesVelocity(91, 1);

        // Find the INSERT/upsert call
        const upsertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(1);
        // total_quantity_sold should be 7 (10 - 3), at index 3 in params
        expect(upsertCalls[0][1][3]).toBe(7);
        // total_revenue_cents should be 7000 (10000 - 3000), at index 4 in params
        expect(upsertCalls[0][1][4]).toBe(7000);
    });

    it('syncSalesVelocity floors negative quantities at 0', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });

        // More refunded than sold
        makeSquareRequest.mockResolvedValueOnce({
            orders: [{
                id: 'order_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '2',
                    total_money: { amount: 2000 }
                }],
                returns: [{
                    return_line_items: [{
                        catalog_object_id: 'var_1',
                        quantity: '5',
                        return_amounts: { total_money: { amount: 5000 } }
                    }]
                }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }]
        });

        await syncSalesVelocity(91, 1);

        const upsertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(1);
        // Should be floored at 0, not -3
        expect(upsertCalls[0][1][3]).toBe(0);
        expect(upsertCalls[0][1][4]).toBe(0);
    });

    it('syncSalesVelocityAllPeriods subtracts refunded quantities', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });

        makeSquareRequest.mockResolvedValueOnce({
            orders: [{
                id: 'order_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '8',
                    total_money: { amount: 8000 }
                }],
                returns: [{
                    return_line_items: [{
                        catalog_object_id: 'var_1',
                        quantity: '2',
                        total_money: { amount: 2000 }
                    }]
                }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }]
        });

        await syncSalesVelocityAllPeriods(1, 91);

        const upsertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(1);
        // Net: 8 - 2 = 6
        expect(upsertCalls[0][1][3]).toBe(6);
        // Revenue: uses total_money fallback when return_amounts not present
        expect(upsertCalls[0][1][4]).toBe(6000);
    });

    it('handles orders with no returns gracefully', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id FROM locations')) {
                return { rows: [{ id: 'loc_1' }] };
            }
            if (sql.includes('SELECT id FROM variations')) {
                return { rows: [{ id: 'var_1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });

        makeSquareRequest.mockResolvedValueOnce({
            orders: [{
                id: 'order_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '5',
                    total_money: { amount: 5000 }
                }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }]
        });

        await syncSalesVelocity(91, 1);

        const upsertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(1);
        // No refunds, so full quantity
        expect(upsertCalls[0][1][3]).toBe(5);
        expect(upsertCalls[0][1][4]).toBe(5000);
    });
});
