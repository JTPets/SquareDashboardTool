/**
 * Tests for square-velocity.js
 *
 * Covers:
 *   syncSalesVelocity       — single-period velocity sync
 *   syncSalesVelocityAllPeriods — optimized multi-period sync
 *   updateSalesVelocityFromOrder — incremental update from webhook
 */

jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue()
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
    SYNC: { BATCH_DELAY_MS: 0 }
}));

const {
    syncSalesVelocity,
    syncSalesVelocityAllPeriods,
    updateSalesVelocityFromOrder,
    _recentlyProcessedVelocityOrders
} = require('../../../services/square/square-velocity');

const db = require('../../../utils/database');
const { makeSquareRequest, sleep } = require('../../../services/square/square-client');

const merchantId = 1;

beforeEach(() => {
    jest.clearAllMocks();
    _recentlyProcessedVelocityOrders.clear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrder(overrides = {}) {
    const now = new Date();
    return {
        id: overrides.id || 'ORDER-1',
        state: 'COMPLETED',
        location_id: 'LOC-1',
        closed_at: overrides.closed_at || now.toISOString(),
        line_items: overrides.line_items || [
            {
                catalog_object_id: 'VAR-1',
                quantity: '3',
                total_money: { amount: 1500 }
            }
        ],
        returns: overrides.returns || [],
        ...overrides
    };
}

function mockLocations(ids = ['LOC-1']) {
    db.query.mockImplementation((sql) => {
        if (sql.includes('FROM locations')) {
            return { rows: ids.map(id => ({ id })) };
        }
        if (sql.includes('FROM variations')) {
            return { rows: [{ id: 'VAR-1' }, { id: 'VAR-2' }] };
        }
        if (sql.includes('DELETE FROM sales_velocity')) {
            return { rowCount: 0 };
        }
        // INSERT / upsert
        return { rows: [], rowCount: 1 };
    });
}

// ---------------------------------------------------------------------------
// syncSalesVelocity
// ---------------------------------------------------------------------------

describe('syncSalesVelocity', () => {
    test('fetches completed orders and aggregates quantities by variation:location', async () => {
        mockLocations();

        const order1 = makeOrder({
            id: 'O1',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '2', total_money: { amount: 1000 } },
                { catalog_object_id: 'VAR-2', quantity: '5', total_money: { amount: 2500 } }
            ]
        });
        const order2 = makeOrder({
            id: 'O2',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '1', total_money: { amount: 500 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order1, order2], cursor: null });

        const result = await syncSalesVelocity(91, merchantId);

        // VAR-1 (2+1=3) and VAR-2 (5) both exist
        expect(result).toBe(2);

        // Verify upsert was called for each variation:location combo
        const upsertCalls = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(2);
    });

    test('subtracts refunded quantities (BACKLOG-35)', async () => {
        mockLocations();

        const order = makeOrder({
            id: 'O-REFUND',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '10', total_money: { amount: 5000 } }
            ],
            returns: [{
                return_line_items: [
                    {
                        catalog_object_id: 'VAR-1',
                        quantity: '3',
                        total_money: { amount: 1500 },
                        source_line_item_uid: 'uid-1'
                    }
                ]
            }]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        await syncSalesVelocity(91, merchantId);

        // Net quantity should be 10 - 3 = 7
        const upsertCalls = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(1);

        // 4th parameter is netQuantity
        const netQuantity = upsertCalls[0][1][3];
        expect(netQuantity).toBe(7);
    });

    test('floors net quantities at 0 when refunds exceed sales', async () => {
        mockLocations();

        const order = makeOrder({
            id: 'O-OVERREFUND',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '2', total_money: { amount: 1000 } }
            ],
            returns: [{
                return_line_items: [
                    {
                        catalog_object_id: 'VAR-1',
                        quantity: '5',
                        total_money: { amount: 2500 },
                        source_line_item_uid: 'uid-1'
                    }
                ]
            }]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        await syncSalesVelocity(91, merchantId);

        const upsertCalls = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sales_velocity'));
        expect(upsertCalls.length).toBe(1);

        // Net floored to 0
        const netQuantity = upsertCalls[0][1][3];
        expect(netQuantity).toBe(0);
    });

    test('calculates daily/weekly/monthly averages correctly', async () => {
        mockLocations();

        const order = makeOrder({
            id: 'O-AVG',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '91', total_money: { amount: 9100 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        await syncSalesVelocity(91, merchantId);

        const upsertCalls = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sales_velocity'));
        const params = upsertCalls[0][1];

        const netQuantity = params[3]; // 91
        const dailyAvg = params[7];    // dailyAvg
        const weeklyAvg = params[9];   // weeklyAvg
        const monthlyAvg = params[10]; // monthlyAvg

        expect(netQuantity).toBe(91);
        expect(dailyAvg).toBeCloseTo(1.0, 5);          // 91 / 91
        expect(weeklyAvg).toBeCloseTo(7.0, 5);          // 91 / (91/7)
        expect(monthlyAvg).toBeCloseTo(30.0, 5);        // 91 / (91/30)
    });

    test('validates which variations exist before inserting', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            if (sql.includes('FROM variations')) {
                // Only VAR-1 exists, VAR-2 does not
                return { rows: [{ id: 'VAR-1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });

        const order = makeOrder({
            id: 'O-VALIDATE',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '5', total_money: { amount: 2500 } },
                { catalog_object_id: 'VAR-2', quantity: '3', total_money: { amount: 1500 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        const result = await syncSalesVelocity(91, merchantId);

        // Only VAR-1 should be saved
        expect(result).toBe(1);
    });

    test('deletes stale velocity rows (BACKLOG-36)', async () => {
        mockLocations();

        const order = makeOrder({
            id: 'O-STALE',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '1', total_money: { amount: 500 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        await syncSalesVelocity(91, merchantId);

        // Verify DELETE query was issued with NOT IN clause
        const deleteCalls = db.query.mock.calls.filter(([sql]) =>
            sql.includes('DELETE FROM sales_velocity') && sql.includes('NOT IN')
        );
        expect(deleteCalls.length).toBe(1);

        // Should pass merchantId and periodDays
        const deleteParams = deleteCalls[0][1];
        expect(deleteParams).toContain(merchantId);
        expect(deleteParams).toContain(91);
    });

    test('returns 0 when no active locations', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const result = await syncSalesVelocity(91, merchantId);
        expect(result).toBe(0);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('returns 0 when no variations in orders', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            return { rows: [] };
        });

        // Orders with no catalog_object_id
        const order = makeOrder({
            id: 'O-NOVAR',
            line_items: [
                { quantity: '1', total_money: { amount: 500 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        const result = await syncSalesVelocity(91, merchantId);
        expect(result).toBe(0);
    });

    test('handles API errors by throwing', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            return { rows: [] };
        });

        makeSquareRequest.mockRejectedValueOnce(new Error('Square API unavailable'));

        await expect(syncSalesVelocity(91, merchantId)).rejects.toThrow('Square API unavailable');
    });

    test('handles pagination with cursor', async () => {
        mockLocations();

        makeSquareRequest
            .mockResolvedValueOnce({
                orders: [makeOrder({ id: 'O-PAGE1' })],
                cursor: 'next-page'
            })
            .mockResolvedValueOnce({
                orders: [makeOrder({ id: 'O-PAGE2' })],
                cursor: null
            });

        await syncSalesVelocity(91, merchantId);

        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    test('skips line items without catalog_object_id or location_id', async () => {
        mockLocations();

        const order = makeOrder({
            id: 'O-SKIP',
            line_items: [
                { catalog_object_id: null, quantity: '1', total_money: { amount: 500 } },
                { catalog_object_id: 'VAR-1', quantity: '2', total_money: { amount: 1000 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        const result = await syncSalesVelocity(91, merchantId);
        expect(result).toBe(1);
    });

    test('handles refund with return_amounts.total_money', async () => {
        mockLocations();

        const order = makeOrder({
            id: 'O-RETAMT',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '10', total_money: { amount: 5000 } }
            ],
            returns: [{
                return_line_items: [
                    {
                        catalog_object_id: 'VAR-1',
                        quantity: '2',
                        return_amounts: { total_money: { amount: 1000 } },
                        source_line_item_uid: 'uid-1'
                    }
                ]
            }]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        await syncSalesVelocity(91, merchantId);

        const upsertCalls = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sales_velocity'));
        const netQuantity = upsertCalls[0][1][3];
        const netRevenue = upsertCalls[0][1][4];
        expect(netQuantity).toBe(8);
        expect(netRevenue).toBe(4000);
    });

    test('deletes all stale rows when no variations have sales', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            if (sql.includes('FROM variations')) {
                return { rows: [] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [] };
        });

        // Return orders with no valid line items
        makeSquareRequest.mockResolvedValueOnce({ orders: [], cursor: null });

        const result = await syncSalesVelocity(91, merchantId);
        expect(result).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// syncSalesVelocityAllPeriods
// ---------------------------------------------------------------------------

describe('syncSalesVelocityAllPeriods', () => {
    function mockAllPeriodsLocations() {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            if (sql.includes('FROM variations')) {
                return { rows: [{ id: 'VAR-1' }, { id: 'VAR-2' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });
    }

    test('fetches orders once for max period and calculates all periods', async () => {
        mockAllPeriodsLocations();

        const recentOrder = makeOrder({
            id: 'O-RECENT',
            closed_at: new Date().toISOString(),
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '5', total_money: { amount: 2500 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [recentOrder], cursor: null });

        const summary = await syncSalesVelocityAllPeriods(merchantId, 365);

        // Single API call
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);

        // Should sync all 3 periods
        expect(summary.periodssynced).toEqual([91, 182, 365]);
        expect(summary['91d']).toBe(1);
        expect(summary['182d']).toBe(1);
        expect(summary['365d']).toBe(1);
    });

    test('assigns orders to appropriate periods based on closed_at date', async () => {
        mockAllPeriodsLocations();

        // Order from 100 days ago — should appear in 182d and 365d but NOT 91d
        const olderDate = new Date();
        olderDate.setDate(olderDate.getDate() - 100);

        const olderOrder = makeOrder({
            id: 'O-OLD',
            closed_at: olderDate.toISOString(),
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '3', total_money: { amount: 1500 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [olderOrder], cursor: null });

        const summary = await syncSalesVelocityAllPeriods(merchantId, 365);

        expect(summary['91d']).toBe(0);
        expect(summary['182d']).toBe(1);
        expect(summary['365d']).toBe(1);
    });

    test('filters periods by maxPeriod parameter', async () => {
        mockAllPeriodsLocations();

        const recentOrder = makeOrder({
            id: 'O-MAXPERIOD',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '2', total_money: { amount: 1000 } }
            ]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [recentOrder], cursor: null });

        const summary = await syncSalesVelocityAllPeriods(merchantId, 182);

        // Only 91d and 182d should be synced
        expect(summary.periodssynced).toEqual([91, 182]);
        expect(summary['91d']).toBe(1);
        expect(summary['182d']).toBe(1);
        expect(summary['365d']).toBeUndefined();
    });

    test('returns summary with counts per period', async () => {
        mockAllPeriodsLocations();

        makeSquareRequest.mockResolvedValueOnce({
            orders: [
                makeOrder({ id: 'O-S1', line_items: [{ catalog_object_id: 'VAR-1', quantity: '1', total_money: { amount: 500 } }] }),
                makeOrder({ id: 'O-S2', line_items: [{ catalog_object_id: 'VAR-2', quantity: '2', total_money: { amount: 1000 } }] })
            ],
            cursor: null
        });

        const summary = await syncSalesVelocityAllPeriods(merchantId);

        expect(summary.ordersProcessed).toBe(2);
        expect(typeof summary.apiCallsSaved).toBe('number');
        expect(summary['91d']).toBe(2);
        expect(summary['182d']).toBe(2);
        expect(summary['365d']).toBe(2);
    });

    test('returns empty summary when no active locations', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const summary = await syncSalesVelocityAllPeriods(merchantId);

        expect(makeSquareRequest).not.toHaveBeenCalled();
        expect(summary.ordersProcessed).toBe(0);
    });

    test('returns summary when no sales data across any period', async () => {
        mockAllPeriodsLocations();

        makeSquareRequest.mockResolvedValueOnce({ orders: [], cursor: null });

        const summary = await syncSalesVelocityAllPeriods(merchantId);

        expect(summary.ordersProcessed).toBe(0);
        expect(summary['91d']).toBe(0);
        expect(summary['182d']).toBe(0);
        expect(summary['365d']).toBe(0);
    });

    test('subtracts refunds in multi-period sync', async () => {
        mockAllPeriodsLocations();

        const order = makeOrder({
            id: 'O-REFUND-MP',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '10', total_money: { amount: 5000 } }
            ],
            returns: [{
                return_line_items: [{
                    catalog_object_id: 'VAR-1',
                    quantity: '4',
                    total_money: { amount: 2000 },
                    source_line_item_uid: 'uid-1'
                }]
            }]
        });

        makeSquareRequest.mockResolvedValueOnce({ orders: [order], cursor: null });

        await syncSalesVelocityAllPeriods(merchantId);

        // Should have upsert calls — check netQuantity = 6 for each period
        const upsertCalls = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sales_velocity'));
        // 3 periods x 1 variation = 3 upserts
        expect(upsertCalls.length).toBe(3);

        for (const call of upsertCalls) {
            const netQuantity = call[1][3];
            expect(netQuantity).toBe(6);
        }
    });

    test('handles API errors by throwing', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            return { rows: [] };
        });

        makeSquareRequest.mockRejectedValueOnce(new Error('Rate limited'));

        await expect(syncSalesVelocityAllPeriods(merchantId)).rejects.toThrow('Rate limited');
    });

    test('deletes stale velocity rows for each period (BACKLOG-36)', async () => {
        mockAllPeriodsLocations();

        makeSquareRequest.mockResolvedValueOnce({
            orders: [makeOrder({ id: 'O-STALE-MP' })],
            cursor: null
        });

        await syncSalesVelocityAllPeriods(merchantId);

        const deleteCalls = db.query.mock.calls.filter(([sql]) =>
            sql.includes('DELETE FROM sales_velocity') && sql.includes('NOT IN')
        );
        // One delete per period (91, 182, 365)
        expect(deleteCalls.length).toBe(3);
    });

    test('handles pagination across pages', async () => {
        mockAllPeriodsLocations();

        makeSquareRequest
            .mockResolvedValueOnce({
                orders: [makeOrder({ id: 'O-PG1' })],
                cursor: 'page2'
            })
            .mockResolvedValueOnce({
                orders: [makeOrder({ id: 'O-PG2' })],
                cursor: null
            });

        const summary = await syncSalesVelocityAllPeriods(merchantId);

        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        expect(summary.ordersProcessed).toBe(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    test('skips missing variations across all periods', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'LOC-1' }] };
            }
            if (sql.includes('FROM variations')) {
                // Only VAR-1 exists
                return { rows: [{ id: 'VAR-1' }] };
            }
            if (sql.includes('DELETE FROM sales_velocity')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        });

        makeSquareRequest.mockResolvedValueOnce({
            orders: [
                makeOrder({
                    id: 'O-MISS',
                    line_items: [
                        { catalog_object_id: 'VAR-1', quantity: '1', total_money: { amount: 500 } },
                        { catalog_object_id: 'VAR-DELETED', quantity: '3', total_money: { amount: 1500 } }
                    ]
                })
            ],
            cursor: null
        });

        const summary = await syncSalesVelocityAllPeriods(merchantId);

        // Only VAR-1 saved per period
        expect(summary['91d']).toBe(1);
        expect(summary['182d']).toBe(1);
        expect(summary['365d']).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// updateSalesVelocityFromOrder
// ---------------------------------------------------------------------------

describe('updateSalesVelocityFromOrder', () => {
    function mockVariationsExist(ids = ['VAR-1']) {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM variations')) {
                return { rows: ids.map(id => ({ id })) };
            }
            return { rows: [], rowCount: 1 };
        });
    }

    test('validates order is COMPLETED', async () => {
        const result = await updateSalesVelocityFromOrder(
            { ...makeOrder(), state: 'OPEN' },
            merchantId
        );
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('Order not completed');
    });

    test('validates order has line_items', async () => {
        const result = await updateSalesVelocityFromOrder(
            { ...makeOrder(), line_items: [] },
            merchantId
        );
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('No line items');
    });

    test('validates order has line_items (null)', async () => {
        const result = await updateSalesVelocityFromOrder(
            { ...makeOrder(), line_items: null },
            merchantId
        );
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('No line items');
    });

    test('requires merchantId', async () => {
        const result = await updateSalesVelocityFromOrder(makeOrder(), null);
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('No merchantId');
    });

    test('returns early when no order provided', async () => {
        const result = await updateSalesVelocityFromOrder(null, merchantId);
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('No order provided');
    });

    test('checks dedup cache and skips already processed orders', async () => {
        mockVariationsExist();

        const order = makeOrder({ id: 'O-DEDUP' });

        // First call succeeds
        const result1 = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result1.updated).toBeGreaterThan(0);

        // Second call with same order ID deduped
        const result2 = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result2.updated).toBe(0);
        expect(result2.reason).toBe('Already processed (dedup)');
    });

    test('dedup is per-merchant (same order, different merchant)', async () => {
        mockVariationsExist();

        const order = makeOrder({ id: 'O-MULTI-MERCHANT' });

        const result1 = await updateSalesVelocityFromOrder(order, 1);
        expect(result1.updated).toBeGreaterThan(0);

        const result2 = await updateSalesVelocityFromOrder(order, 2);
        expect(result2.updated).toBeGreaterThan(0);
    });

    test('calculates order age and determines applicable periods', async () => {
        mockVariationsExist();

        // Order from today — should apply to all periods (91, 182, 365)
        const order = makeOrder({ id: 'O-TODAY' });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.periods).toEqual([91, 182, 365]);
    });

    test('order within 91 days applies to all periods', async () => {
        mockVariationsExist();

        const fiftyDaysAgo = new Date();
        fiftyDaysAgo.setDate(fiftyDaysAgo.getDate() - 50);

        const order = makeOrder({ id: 'O-50D', closed_at: fiftyDaysAgo.toISOString() });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.periods).toEqual([91, 182, 365]);
    });

    test('order older than 91 days only applies to 182d and 365d', async () => {
        mockVariationsExist();

        const hundredDaysAgo = new Date();
        hundredDaysAgo.setDate(hundredDaysAgo.getDate() - 100);

        const order = makeOrder({ id: 'O-100D', closed_at: hundredDaysAgo.toISOString() });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.periods).toEqual([182, 365]);
    });

    test('order older than 182 days only applies to 365d', async () => {
        mockVariationsExist();

        const twoHundredDaysAgo = new Date();
        twoHundredDaysAgo.setDate(twoHundredDaysAgo.getDate() - 200);

        const order = makeOrder({ id: 'O-200D', closed_at: twoHundredDaysAgo.toISOString() });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.periods).toEqual([365]);
    });

    test('order older than 365 days skips all periods', async () => {
        const fourHundredDaysAgo = new Date();
        fourHundredDaysAgo.setDate(fourHundredDaysAgo.getDate() - 400);

        const order = makeOrder({ id: 'O-400D', closed_at: fourHundredDaysAgo.toISOString() });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('Order too old for all periods');
    });

    test('validates which variations exist in DB', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM variations')) {
                return { rows: [{ id: 'VAR-1' }] };
            }
            return { rows: [], rowCount: 1 };
        });

        const order = makeOrder({
            id: 'O-VALIDATE-INC',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '2', total_money: { amount: 1000 } },
                { catalog_object_id: 'VAR-GONE', quantity: '1', total_money: { amount: 500 } }
            ]
        });

        const result = await updateSalesVelocityFromOrder(order, merchantId);

        // VAR-1 updated for 3 periods, VAR-GONE skipped
        expect(result.updated).toBe(3);
        expect(result.skipped).toBe(1);
    });

    test('uses atomic upsert (increment existing record)', async () => {
        mockVariationsExist();

        const order = makeOrder({ id: 'O-UPSERT' });

        await updateSalesVelocityFromOrder(order, merchantId);

        const upsertCalls = db.query.mock.calls.filter(([sql]) =>
            sql.includes('INSERT INTO sales_velocity') &&
            sql.includes('ON CONFLICT') &&
            sql.includes('sales_velocity.total_quantity_sold +')
        );

        // 1 variation x 3 periods = 3 upserts
        expect(upsertCalls.length).toBe(3);
    });

    test('skips variations not in catalog', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM variations')) {
                return { rows: [] }; // No variations exist
            }
            return { rows: [], rowCount: 1 };
        });

        const order = makeOrder({ id: 'O-NOCATALOG' });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(1);
    });

    test('skips line items with quantity <= 0', async () => {
        mockVariationsExist();

        const order = makeOrder({
            id: 'O-ZEROQTY',
            line_items: [
                { catalog_object_id: 'VAR-1', quantity: '0', total_money: { amount: 0 } },
                { catalog_object_id: 'VAR-1', quantity: '-1', total_money: { amount: 0 } }
            ]
        });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(2);
    });

    test('returns correct shape { updated, skipped, periods }', async () => {
        mockVariationsExist();

        const order = makeOrder({ id: 'O-SHAPE' });

        const result = await updateSalesVelocityFromOrder(order, merchantId);

        expect(result).toHaveProperty('updated');
        expect(result).toHaveProperty('skipped');
        expect(result).toHaveProperty('periods');
        expect(Array.isArray(result.periods)).toBe(true);
    });

    test('skips line items without catalog_object_id', async () => {
        mockVariationsExist();

        const order = makeOrder({
            id: 'O-NOID',
            line_items: [
                { quantity: '1', total_money: { amount: 500 } }
            ]
        });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('No catalog variations in order');
    });

    test('returns early when order has no location_id', async () => {
        const order = makeOrder({ id: 'O-NOLOC', location_id: null });

        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.updated).toBe(0);
        expect(result.reason).toBe('No location_id');
    });

    test('handles db error on individual upsert gracefully', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM variations')) {
                return { rows: [{ id: 'VAR-1' }] };
            }
            if (sql.includes('INSERT INTO sales_velocity')) {
                throw new Error('DB constraint violation');
            }
            return { rows: [], rowCount: 1 };
        });

        const order = makeOrder({ id: 'O-DBERR' });

        // Should not throw — individual failures are caught and counted as skipped
        const result = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result.skipped).toBeGreaterThan(0);
    });

    test('uses closed_at for age calculation, defaults to now if missing', async () => {
        mockVariationsExist();

        const order = makeOrder({ id: 'O-NOCLOSE', closed_at: undefined });
        delete order.closed_at;

        const result = await updateSalesVelocityFromOrder(order, merchantId);

        // Should apply to all periods since effective age is 0
        expect(result.periods).toEqual([91, 182, 365]);
    });

    test('dedup cache can be cleared between tests', async () => {
        mockVariationsExist();

        const order = makeOrder({ id: 'O-CLEARTEST' });

        const result1 = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result1.updated).toBeGreaterThan(0);

        // Clear and retry
        _recentlyProcessedVelocityOrders.clear();

        const result2 = await updateSalesVelocityFromOrder(order, merchantId);
        expect(result2.updated).toBeGreaterThan(0);
    });
});
