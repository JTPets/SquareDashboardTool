/**
 * Order Lifecycle Tests for services/delivery/delivery-service.js
 *
 * Tests status transitions documented in docs/DELIVERY-AUDIT.md Section 2
 * and bug behaviors from Section 5 (Bug Registry).
 *
 * All tests pass against CURRENT code — they snapshot existing behavior,
 * including documented bugs.
 */

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

// Mock token encryption
jest.mock('../../../utils/token-encryption', () => ({
    encryptToken: jest.fn(val => `encrypted:${val}`),
    decryptToken: jest.fn(val => val.replace('encrypted:', '')),
    isEncryptedToken: jest.fn(val => val?.startsWith('encrypted:'))
}));

// Mock customer details service
jest.mock('../../../services/loyalty-admin/customer-details-service', () => ({
    getCustomerDetails: jest.fn().mockResolvedValue(null)
}));

// Mock fs.promises
jest.mock('fs', () => ({
    promises: {
        mkdir: jest.fn().mockResolvedValue(),
        writeFile: jest.fn().mockResolvedValue(),
        unlink: jest.fn().mockResolvedValue()
    }
}));

// Mock global fetch
global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

const deliveryService = require('../../../services/delivery/delivery-service');

const MERCHANT_ID = 1;
const USER_ID = 10;
const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID_2 = '22222222-2222-2222-2222-222222222222';
const ORDER_ID_3 = '33333333-3333-3333-3333-333333333333';
const ROUTE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ROUTE_ID_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeOrder(overrides = {}) {
    return {
        id: ORDER_ID,
        merchant_id: MERCHANT_ID,
        customer_name: 'Test Customer',
        address: '123 Main St',
        status: 'pending',
        route_id: null,
        route_position: null,
        route_date: null,
        geocoded_at: new Date().toISOString(),
        address_lat: '43.65',
        address_lng: '-79.38',
        square_order_id: null,
        square_customer_id: null,
        phone: null,
        pod_id: null,
        pod_photo_path: null,
        ...overrides
    };
}

function makeSettings(overrides = {}) {
    return {
        merchant_id: MERCHANT_ID,
        start_address: '100 Queen St W, Toronto',
        start_address_lat: '43.6520',
        start_address_lng: '-79.3832',
        end_address: null,
        end_address_lat: null,
        end_address_lng: null,
        auto_ingest_ready_orders: true,
        openrouteservice_api_key: null,
        ors_api_key_encrypted: null,
        pod_retention_days: 180,
        ...overrides
    };
}

function makeMockClient(queryResults = []) {
    let callIndex = 0;
    return {
        query: jest.fn().mockImplementation(() => {
            if (callIndex < queryResults.length) {
                return Promise.resolve(queryResults[callIndex++]);
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        }),
        release: jest.fn()
    };
}

beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.OPENROUTESERVICE_API_KEY;
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    db.getClient.mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
    });
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
});

// ============================================================================
// 1. ORDER CREATION — Initial Status
// ============================================================================

describe('Order Creation — Initial Status', () => {
    it('creates manual order with status = pending', async () => {
        const created = makeOrder({ _inserted: true });
        db.query.mockResolvedValueOnce({ rows: [created] });

        const order = await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Test Customer',
            address: '123 Main St'
        });

        expect(order.status).toBe('pending');
        const sql = db.query.mock.calls[0][0];
        expect(sql).not.toContain('ON CONFLICT');
    });

    it('creates Square-linked order with ON CONFLICT upsert', async () => {
        const created = makeOrder({
            square_order_id: 'SQ_ORDER_1',
            _inserted: true
        });
        db.query.mockResolvedValueOnce({ rows: [created] });

        const order = await deliveryService.createOrder(MERCHANT_ID, {
            squareOrderId: 'SQ_ORDER_1',
            customerName: 'Test',
            address: '456 Elm St'
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('ON CONFLICT (square_order_id, merchant_id)');
    });

    it('returns existing order on upsert conflict (xmax != 0)', async () => {
        const existing = makeOrder({
            square_order_id: 'SQ_ORDER_1',
            customer_name: 'Original Name',
            _inserted: false
        });
        db.query.mockResolvedValueOnce({ rows: [existing] });

        const order = await deliveryService.createOrder(MERCHANT_ID, {
            squareOrderId: 'SQ_ORDER_1',
            customerName: 'New Name',
            address: '456 Elm St'
        });

        expect(order.customer_name).toBe('Original Name');
    });

    it('sets geocoded_at when coordinates provided', async () => {
        const created = makeOrder({ _inserted: true });
        db.query.mockResolvedValueOnce({ rows: [created] });

        await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Test',
            address: '123 Main St',
            addressLat: 43.65,
            addressLng: -79.38
        });

        const params = db.query.mock.calls[0][1];
        // geocodedAt is param index 11 (0-based)
        expect(params[11]).toBeInstanceOf(Date);
    });

    it('sets geocoded_at to null when no coordinates', async () => {
        const created = makeOrder({ _inserted: true });
        db.query.mockResolvedValueOnce({ rows: [created] });

        await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Test',
            address: '123 Main St'
        });

        const params = db.query.mock.calls[0][1];
        expect(params[11]).toBeNull();
    });
});

// ============================================================================
// 2. ORDER ASSIGNMENT TO ROUTE (pending → active)
// ============================================================================

describe('Route Generation — Order Assignment', () => {
    it('assigns pending orders to route with status = active', async () => {
        const pendingOrder = makeOrder({
            id: ORDER_ID,
            status: 'pending',
            address_lat: '43.65',
            address_lng: '-79.38'
        });

        // getActiveRoute → none
        db.query.mockResolvedValueOnce({ rows: [] });
        // getSettings
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        // pending orders query
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },                              // BEGIN
            { rows: [{ id: ROUTE_ID }] },              // INSERT route
            { rows: [] },                              // UPDATE order status
            { rows: [] },                              // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);

        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });
        // getOrders for return
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'active', route_id: ROUTE_ID })]
        });

        const route = await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {});

        // Verify UPDATE set status = 'active'
        const updateCall = mockClient.query.mock.calls[2];
        expect(updateCall[0]).toContain("status = 'active'");
        expect(updateCall[0]).toContain('route_id = $1');
    });

    it('only selects pending + geocoded orders', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });              // getActiveRoute
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] }); // getSettings
        db.query.mockResolvedValueOnce({ rows: [] });              // no orders

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, {})
        ).rejects.toThrow('No geocoded pending orders');

        const orderQuery = db.query.mock.calls[2][0];
        expect(orderQuery).toContain("status = 'pending'");
        expect(orderQuery).toContain('geocoded_at IS NOT NULL');
    });

    it('filters by orderIds when provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
                orderIds: [ORDER_ID, ORDER_ID_2]
            })
        ).rejects.toThrow('No geocoded pending orders');

        const orderQuery = db.query.mock.calls[2][0];
        expect(orderQuery).toContain('id = ANY($2)');
        expect(db.query.mock.calls[2][1]).toEqual([MERCHANT_ID, [ORDER_ID, ORDER_ID_2]]);
    });

    it('excludes orders when excludeOrderIds provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
                excludeOrderIds: [ORDER_ID]
            })
        ).rejects.toThrow('No geocoded pending orders');

        const orderQuery = db.query.mock.calls[2][0];
        expect(orderQuery).toContain('id != ANY($2)');
        expect(db.query.mock.calls[2][1]).toEqual([MERCHANT_ID, [ORDER_ID]]);
    });

    it('supports both orderIds and excludeOrderIds together', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
                orderIds: [ORDER_ID, ORDER_ID_2, ORDER_ID_3],
                excludeOrderIds: [ORDER_ID_3]
            })
        ).rejects.toThrow('No geocoded pending orders');

        const orderQuery = db.query.mock.calls[2][0];
        expect(orderQuery).toContain('id = ANY($2)');
        expect(orderQuery).toContain('id != ANY($3)');
        expect(db.query.mock.calls[2][1]).toEqual([
            MERCHANT_ID,
            [ORDER_ID, ORDER_ID_2, ORDER_ID_3],
            [ORDER_ID_3]
        ]);
    });

    it('ignores empty excludeOrderIds array', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
                excludeOrderIds: []
            })
        ).rejects.toThrow('No geocoded pending orders');

        const orderQuery = db.query.mock.calls[2][0];
        expect(orderQuery).not.toContain('id != ANY');
    });

    it('uses override coords instead of settings when provided', async () => {
        const pendingOrder = makeOrder({ status: 'pending' });

        db.query.mockResolvedValueOnce({ rows: [] });              // getActiveRoute
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] }); // getSettings
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });  // pending orders

        const mockClient = makeMockClient([
            { rows: [] },                              // BEGIN
            { rows: [{ id: ROUTE_ID }] },              // INSERT route
            { rows: [] },                              // UPDATE order
            { rows: [] },                              // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);

        db.query.mockResolvedValueOnce({ rows: [] }); // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active', route_id: ROUTE_ID })] });

        await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
            startLat: 44.0, startLng: -80.0, endLat: 44.5, endLng: -80.5
        });

        // Verify INSERT includes override coords
        const insertCall = mockClient.query.mock.calls[1];
        const insertParams = insertCall[1];
        expect(insertParams[7]).toBe(44.0);   // start_lat
        expect(insertParams[8]).toBe(-80.0);  // start_lng
        expect(insertParams[9]).toBe(44.5);   // end_lat
        expect(insertParams[10]).toBe(-80.5); // end_lng
    });

    it('falls back to settings coords when no override provided', async () => {
        const pendingOrder = makeOrder({ status: 'pending' });

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },
            { rows: [{ id: ROUTE_ID }] },
            { rows: [] },
            { rows: [] },
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active', route_id: ROUTE_ID })] });

        await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {});

        const insertParams = mockClient.query.mock.calls[1][1];
        expect(insertParams[7]).toBe(43.6520);  // settings start_lat
        expect(insertParams[8]).toBe(-79.3832); // settings start_lng
        // end falls back to start since settings end is null
        expect(insertParams[9]).toBe(43.6520);
        expect(insertParams[10]).toBe(-79.3832);
    });

    it('falls back to settings when only partial override (lat without lng)', async () => {
        const pendingOrder = makeOrder({ status: 'pending' });

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },
            { rows: [{ id: ROUTE_ID }] },
            { rows: [] },
            { rows: [] },
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active', route_id: ROUTE_ID })] });

        // Only startLat provided, no startLng — should fall back to settings
        await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
            startLat: 44.0
        });

        const insertParams = mockClient.query.mock.calls[1][1];
        expect(insertParams[7]).toBe(43.6520);  // settings start_lat (fallback)
        expect(insertParams[8]).toBe(-79.3832); // settings start_lng (fallback)
    });

    it('stores override coords in delivery_routes INSERT', async () => {
        const pendingOrder = makeOrder({ status: 'pending' });

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },
            { rows: [{ id: ROUTE_ID }] },
            { rows: [] },
            { rows: [] },
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active', route_id: ROUTE_ID })] });

        await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {
            startLat: 45.0, startLng: -75.0, endLat: 45.5, endLng: -75.5
        });

        const insertSQL = mockClient.query.mock.calls[1][0];
        expect(insertSQL).toContain('start_lat');
        expect(insertSQL).toContain('start_lng');
        expect(insertSQL).toContain('end_lat');
        expect(insertSQL).toContain('end_lng');
    });
});

// ============================================================================
// 3. ROUTE PLANNING QUERY — Status Inclusion/Exclusion
// ============================================================================

describe('Route Planning Query — Status Filtering', () => {
    it('includes pending orders', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        try {
            await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {});
        } catch (e) { /* expected — no orders */ }

        const sql = db.query.mock.calls[2][0];
        expect(sql).toContain("status = 'pending'");
    });

    it('excludes active orders (already on a route)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        try {
            await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {});
        } catch (e) { /* expected */ }

        const sql = db.query.mock.calls[2][0];
        // Only pending is selected — active, skipped, delivered, completed are all excluded
        expect(sql).toContain("status = 'pending'");
        expect(sql).not.toContain("status IN");
    });

    it('excludes non-geocoded orders', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [] });

        try {
            await deliveryService.generateRoute(MERCHANT_ID, USER_ID, {});
        } catch (e) { /* expected */ }

        const sql = db.query.mock.calls[2][0];
        expect(sql).toContain('geocoded_at IS NOT NULL');
    });
});

// ============================================================================
// 4. finishRoute() — Behavior by Order Status
// ============================================================================

describe('finishRoute() — Status-Specific Behavior', () => {
    // Setup helper accounts for the new auto-complete-delivered query (BUG-002 fix)
    // Transaction call order: BEGIN, Get route, Stats, Auto-complete delivered,
    // Roll back skipped/active, Mark finished, COMMIT
    function setupFinishRoute(statsRow) {
        const mockClient = makeMockClient([
            { rows: [] },                                         // BEGIN
            { rows: [{ id: ROUTE_ID, status: 'active' }] },      // Get route
            { rows: [statsRow] },                                 // Stats
            { rows: [] },                                         // Auto-complete delivered (BUG-002 fix)
            { rows: [] },                                         // Roll back skipped/active
            { rows: [] },                                         // Mark finished
            { rows: [] },                                         // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);
        db.query.mockResolvedValueOnce({ rows: [] }); // logAuditEvent
        return mockClient;
    }

    it('rolls skipped orders back to pending', async () => {
        const mockClient = setupFinishRoute({
            completed: '0', skipped: '3', delivered: '0', still_active: '0'
        });

        const result = await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        expect(result.skipped).toBe(3);
        expect(result.rolledBack).toBe(3);

        // Index 4 = rollback query (after auto-complete delivered at index 3)
        const rollbackSql = mockClient.query.mock.calls[4][0];
        expect(rollbackSql).toContain("status = 'pending'");
        expect(rollbackSql).toContain("status IN ('skipped', 'active')");
    });

    it('rolls active orders back to pending', async () => {
        const mockClient = setupFinishRoute({
            completed: '0', skipped: '0', delivered: '0', still_active: '2'
        });

        const result = await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        expect(result.rolledBack).toBe(2);

        const rollbackSql = mockClient.query.mock.calls[4][0];
        expect(rollbackSql).toContain("'active'");
    });

    it('does not touch completed orders', async () => {
        const mockClient = setupFinishRoute({
            completed: '5', skipped: '0', delivered: '0', still_active: '0'
        });

        const result = await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        expect(result.completed).toBe(5);
        expect(result.rolledBack).toBe(0);

        const rollbackSql = mockClient.query.mock.calls[4][0];
        expect(rollbackSql).not.toContain("'completed'");
    });

    // Fixed: DELIVERY-BUG-002 — finishRoute() now auto-completes delivered orders.
    // Previously they were ignored and left stranded with stale route_id.
    it('auto-completes delivered orders instead of ignoring them', async () => {
        const mockClient = setupFinishRoute({
            completed: '2', skipped: '1', delivered: '3', still_active: '0'
        });

        const result = await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        expect(result.delivered).toBe(3);
        expect(result.rolledBack).toBe(1); // only skipped

        // Index 3 = auto-complete delivered query (new BUG-002 fix)
        const autoCompleteSql = mockClient.query.mock.calls[3][0];
        expect(autoCompleteSql).toContain("status = 'completed'");
        expect(autoCompleteSql).toContain("status = 'delivered'");
        expect(autoCompleteSql).toContain('route_id = $1');

        // Index 4 = rollback skipped/active (unchanged)
        const rollbackSql = mockClient.query.mock.calls[4][0];
        expect(rollbackSql).toContain("status IN ('skipped', 'active')");
    });

    it('clears route_id, route_position, route_date on rollback', async () => {
        const mockClient = setupFinishRoute({
            completed: '0', skipped: '2', delivered: '0', still_active: '1'
        });

        await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        const rollbackSql = mockClient.query.mock.calls[4][0];
        expect(rollbackSql).toContain('route_id = NULL');
        expect(rollbackSql).toContain('route_position = NULL');
        expect(rollbackSql).toContain('route_date = NULL');
    });

    it('marks route status as finished', async () => {
        const mockClient = setupFinishRoute({
            completed: '1', skipped: '0', delivered: '0', still_active: '0'
        });

        await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        // Index 5 = mark route finished (shifted by one due to new query)
        const finishSql = mockClient.query.mock.calls[5][0];
        expect(finishSql).toContain("status = 'finished'");
        expect(finishSql).toContain('finished_at = NOW()');
    });

    it('logs audit event with correct stats', async () => {
        setupFinishRoute({
            completed: '4', skipped: '2', delivered: '1', still_active: '1'
        });

        await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('delivery_audit_log'),
            expect.arrayContaining([MERCHANT_ID, USER_ID, 'route_finished'])
        );
    });

    it('uses transaction (BEGIN/COMMIT)', async () => {
        const mockClient = setupFinishRoute({
            completed: '1', skipped: '0', delivered: '0', still_active: '0'
        });

        await deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID);

        expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
        // Index 6 = COMMIT (shifted by one due to new query)
        expect(mockClient.query.mock.calls[6][0]).toBe('COMMIT');
    });

    it('rolls back transaction on error', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] })       // BEGIN
                .mockRejectedValueOnce(new Error('DB fail')), // route query fails
            release: jest.fn()
        };
        db.getClient.mockResolvedValueOnce(mockClient);

        await expect(
            deliveryService.finishRoute(MERCHANT_ID, ROUTE_ID, USER_ID)
        ).rejects.toThrow('DB fail');

        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });
});

// ============================================================================
// 5. FORCE-REGENERATE — Orders on Cancelled Route
// ============================================================================

describe('Force-Regenerate Route — Cancelled Route Orders', () => {
    // Fixed: DELIVERY-BUG-001 — generateRoute(force=true) now resets orders
    // on the old route before cancelling it. Delivered orders are auto-completed,
    // active/skipped are rolled back to pending.
    it('auto-completes delivered and resets active/skipped on old route', async () => {
        const existingRoute = { id: ROUTE_ID, status: 'active', order_count: 3 };
        const pendingOrder = makeOrder({ id: ORDER_ID_3 });

        // getActiveRoute returns existing
        db.query.mockResolvedValueOnce({ rows: [existingRoute] });
        // getSettings
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        // pending orders for new route
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },                                         // BEGIN
            { rows: [] },                                         // Auto-complete delivered on old route
            { rows: [] },                                         // Reset active/skipped on old route
            { rows: [] },                                         // Cancel old route
            { rows: [{ id: ROUTE_ID_2 }] },                      // INSERT new route
            { rows: [] },                                         // UPDATE order active
            { rows: [] },                                         // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);

        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });
        // getOrders for return
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'active', route_id: ROUTE_ID_2 })]
        });

        await deliveryService.generateRoute(MERCHANT_ID, USER_ID, { force: true });

        // Index 1: Auto-complete delivered orders on old route
        const autoCompleteSql = mockClient.query.mock.calls[1][0];
        expect(autoCompleteSql).toContain("status = 'completed'");
        expect(autoCompleteSql).toContain("status = 'delivered'");
        expect(mockClient.query.mock.calls[1][1]).toEqual([ROUTE_ID]);

        // Index 2: Reset active/skipped orders to pending on old route
        const resetSql = mockClient.query.mock.calls[2][0];
        expect(resetSql).toContain("status = 'pending'");
        expect(resetSql).toContain("route_id = NULL");
        expect(resetSql).toContain("status IN ('active', 'skipped')");
        expect(mockClient.query.mock.calls[2][1]).toEqual([ROUTE_ID]);

        // Index 3: Cancel old route
        const cancelSql = mockClient.query.mock.calls[3][0];
        expect(cancelSql).toContain("status = 'cancelled'");
        expect(mockClient.query.mock.calls[3][1]).toEqual([ROUTE_ID]);
    });

    it('resets old route orders so they can re-enter the queue', async () => {
        const existingRoute = { id: ROUTE_ID, status: 'active' };
        const newPendingOrder = makeOrder({ id: ORDER_ID_3 });

        db.query.mockResolvedValueOnce({ rows: [existingRoute] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [newPendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },                    // BEGIN
            { rows: [] },                    // Auto-complete delivered
            { rows: [] },                    // Reset active/skipped
            { rows: [] },                    // Cancel old route
            { rows: [{ id: ROUTE_ID_2 }] }, // INSERT new route
            { rows: [] },                    // UPDATE order active
            { rows: [] },                    // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [newPendingOrder] });

        await deliveryService.generateRoute(MERCHANT_ID, USER_ID, { force: true });

        // The order selection query only picks pending orders — but now old route's
        // active/skipped orders have been reset to pending so they'll be eligible next time
        const orderSelectSql = db.query.mock.calls[2][0];
        expect(orderSelectSql).toContain("status = 'pending'");
    });

    it('allows force=true when active route exists', async () => {
        const existingRoute = { id: ROUTE_ID, status: 'active' };
        const pendingOrder = makeOrder();

        db.query.mockResolvedValueOnce({ rows: [existingRoute] });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        const mockClient = makeMockClient([
            { rows: [] },                    // BEGIN
            { rows: [] },                    // Auto-complete delivered
            { rows: [] },                    // Reset active/skipped
            { rows: [] },                    // Cancel old route
            { rows: [{ id: ROUTE_ID_2 }] }, // INSERT new route
            { rows: [] },                    // UPDATE order active
            { rows: [] },                    // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(mockClient);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [pendingOrder] });

        // Should NOT throw
        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, { force: true })
        ).resolves.toBeDefined();
    });

    it('throws without force when active route exists', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: ROUTE_ID, status: 'active' }]
        });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, USER_ID, {})
        ).rejects.toThrow('An active route already exists');
    });
});

// ============================================================================
// 6. skipOrder — Status Guard Behavior
// ============================================================================

describe('skipOrder — Status Guard', () => {
    it('sets order status to skipped', async () => {
        // getOrderById returns active order
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active' })] });
        // updateOrder
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'skipped' })] });
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });

        const order = await deliveryService.skipOrder(MERCHANT_ID, ORDER_ID, USER_ID);
        expect(order.status).toBe('skipped');
    });

    // Fixed: DELIVERY-BUG-006 — skipOrder() now rejects non-active orders.
    it('rejects skipping a pending order (BUG-006 fixed)', async () => {
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'pending' })] });

        await expect(
            deliveryService.skipOrder(MERCHANT_ID, ORDER_ID, USER_ID)
        ).rejects.toThrow("Cannot skip order in 'pending' status");
    });

    it('rejects skipping a completed order (BUG-006 fixed)', async () => {
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'completed' })] });

        await expect(
            deliveryService.skipOrder(MERCHANT_ID, ORDER_ID, USER_ID)
        ).rejects.toThrow("Cannot skip order in 'completed' status");
    });

    // Fixed: DELIVERY-BUG-013 — Audit log now records actual previous status.
    it('records actual previous status in audit log (BUG-013 fixed)', async () => {
        // getOrderById returns active order
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active' })] });
        // updateOrder
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'skipped' })] });
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.skipOrder(MERCHANT_ID, ORDER_ID, USER_ID);

        const auditCall = db.query.mock.calls[2];
        const details = JSON.parse(auditCall[1][5]);
        expect(details.previousStatus).toBe('active');
    });
});

// ============================================================================
// 7. completeOrder — Status Guard Behavior
// ============================================================================

describe('completeOrder — Status Guard', () => {
    it('sets order status to completed', async () => {
        // getOrderById returns active order (allowed status)
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'active' })] });
        // updateOrder
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'completed', square_order_id: 'SQ1' })]
        });
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });

        const order = await deliveryService.completeOrder(MERCHANT_ID, ORDER_ID, USER_ID);
        expect(order.status).toBe('completed');
    });

    // Fixed: DELIVERY-BUG-005 — completeOrder now rejects pending and already-completed orders.
    it('rejects completing a pending order (BUG-005 fixed)', async () => {
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'pending' })] });

        await expect(
            deliveryService.completeOrder(MERCHANT_ID, ORDER_ID, USER_ID)
        ).rejects.toThrow("Cannot complete order in 'pending' status");
    });

    it('rejects completing an already-completed order (BUG-005 fixed)', async () => {
        db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'completed' })] });

        await expect(
            deliveryService.completeOrder(MERCHANT_ID, ORDER_ID, USER_ID)
        ).rejects.toThrow("Cannot complete order in 'completed' status");
    });

    it('accepts completing active, delivered, and skipped orders (BUG-005 fixed)', async () => {
        for (const status of ['active', 'delivered', 'skipped']) {
            jest.resetAllMocks();
            db.query.mockResolvedValue({ rows: [], rowCount: 0 });
            // getOrderById
            db.query.mockResolvedValueOnce({ rows: [makeOrder({ status })] });
            // updateOrder
            db.query.mockResolvedValueOnce({ rows: [makeOrder({ status: 'completed', square_order_id: 'SQ1' })] });
            // logAuditEvent
            db.query.mockResolvedValueOnce({ rows: [] });

            const order = await deliveryService.completeOrder(MERCHANT_ID, ORDER_ID, USER_ID);
            expect(order.status).toBe('completed');
        }
    });

    it('logs audit with squareOrderId and hasPod', async () => {
        // getOrderById returns delivered order (allowed status)
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({
                status: 'delivered',
                square_order_id: 'SQ_123',
                pod_id: 'pod-uuid'
            })]
        });
        // updateOrder
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({
                status: 'completed',
                square_order_id: 'SQ_123',
                pod_id: 'pod-uuid'
            })]
        });
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.completeOrder(MERCHANT_ID, ORDER_ID, USER_ID);

        const auditCall = db.query.mock.calls[2];
        const details = JSON.parse(auditCall[1][5]);
        expect(details.squareOrderId).toBe('SQ_123');
        expect(details.hasPod).toBe(true);
    });
});

// ============================================================================
// 8. savePodPhoto — Status Transition
// ============================================================================

describe('savePodPhoto — Status Transition', () => {
    const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('sets order status to delivered after saving POD', async () => {
        // getOrderById
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'active' })]
        });
        // getSettings
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        // INSERT pod
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'pod-1', captured_at: new Date() }]
        });
        // updateOrder (status → delivered)
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'delivered' })]
        });

        await deliveryService.savePodPhoto(MERCHANT_ID, ORDER_ID, JPEG_HEADER, {});

        // The updateOrder call should set status to delivered
        const updateCall = db.query.mock.calls[3];
        expect(updateCall[0]).toContain('delivery_orders');
        const updateParams = updateCall[1];
        expect(updateParams).toContain('delivered');
    });

    // Fixed: DELIVERY-BUG-004 — savePodPhoto now only sets status to 'delivered'
    // if current status is 'active'. Completed orders save the POD but skip status change.
    it('saves POD on completed order without changing status (BUG-004 fixed)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'completed' })]
        });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'pod-1', captured_at: new Date() }]
        });

        const pod = await deliveryService.savePodPhoto(MERCHANT_ID, ORDER_ID, JPEG_HEADER, {});
        expect(pod).toBeDefined();

        // updateOrder should NOT be called — only 3 db.query calls (getOrder, getSettings, insertPod)
        expect(db.query).toHaveBeenCalledTimes(3);
    });

    it('sets status to delivered for active order (BUG-004 preserved behavior)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'active' })]
        });
        db.query.mockResolvedValueOnce({ rows: [makeSettings()] });
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'pod-1', captured_at: new Date() }]
        });
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'delivered' })]
        });

        await deliveryService.savePodPhoto(MERCHANT_ID, ORDER_ID, JPEG_HEADER, {});

        // 4 calls: getOrder, getSettings, insertPod, updateOrder
        expect(db.query).toHaveBeenCalledTimes(4);
        const updateParams = db.query.mock.calls[3][1];
        expect(updateParams).toContain('delivered');
    });
});

// ============================================================================
// 9. handleSquareOrderUpdate — Cancellation Status Filtering
// ============================================================================

describe('handleSquareOrderUpdate — Cancellation Behavior', () => {
    it('deletes pending order on CANCELED', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder({ status: 'pending' })] })
            .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        const deleteSql = db.query.mock.calls[1][0];
        expect(deleteSql).toContain('DELETE FROM delivery_orders');
    });

    it('deletes active order on CANCELED', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder({ status: 'active' })] })
            .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        expect(db.query).toHaveBeenCalledTimes(2);
        const deleteSql = db.query.mock.calls[1][0];
        expect(deleteSql).toContain('DELETE');
    });

    // Fixed: DELIVERY-BUG-003 — Cancellation now includes skipped and delivered orders.
    // Previously only pending/active were deleted, leaving zombie records.
    it('deletes skipped order on CANCELED', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder({ status: 'skipped' })] })
            .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        expect(db.query).toHaveBeenCalledTimes(2);
        const deleteSql = db.query.mock.calls[1][0];
        expect(deleteSql).toContain('DELETE FROM delivery_orders');
    });

    it('deletes delivered order on CANCELED', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder({ status: 'delivered' })] })
            .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        expect(db.query).toHaveBeenCalledTimes(2);
        const deleteSql = db.query.mock.calls[1][0];
        expect(deleteSql).toContain('DELETE FROM delivery_orders');
    });

    it('does not delete completed order on CANCELED', async () => {
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'completed' })]
        });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('marks non-completed order as completed on COMPLETED', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder({ status: 'active' })] })
            .mockResolvedValueOnce({ rows: [makeOrder({ status: 'completed' })] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'COMPLETED');

        const updateSql = db.query.mock.calls[1][0];
        expect(updateSql).toContain('delivery_orders');
    });

    it('does not re-update already completed order', async () => {
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'completed' })]
        });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'COMPLETED');

        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('does nothing for unknown square order', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_UNKNOWN', 'COMPLETED');

        expect(db.query).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// 10. deleteOrder — Guard Conditions
// ============================================================================

describe('deleteOrder — Guard Conditions', () => {
    it('deletes manual pending order', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] });

        const deleted = await deliveryService.deleteOrder(MERCHANT_ID, ORDER_ID);

        expect(deleted).toBe(true);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('square_order_id IS NULL');
        expect(sql).toContain("status NOT IN ('completed', 'delivered')");
    });

    it('prevents deletion of Square-linked orders (via SQL guard)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no match

        const deleted = await deliveryService.deleteOrder(MERCHANT_ID, ORDER_ID);

        expect(deleted).toBe(false);
    });

    it('prevents deletion of completed orders (via SQL guard)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const deleted = await deliveryService.deleteOrder(MERCHANT_ID, ORDER_ID);

        expect(deleted).toBe(false);
    });

    it('uses merchant_id in WHERE clause', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.deleteOrder(MERCHANT_ID, ORDER_ID);

        const params = db.query.mock.calls[0][1];
        expect(params).toEqual([ORDER_ID, MERCHANT_ID]);
    });
});

// ============================================================================
// 11. markDelivered
// ============================================================================

describe('markDelivered', () => {
    it('sets status to delivered via updateOrder', async () => {
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'delivered' })]
        });

        const order = await deliveryService.markDelivered(MERCHANT_ID, ORDER_ID);

        expect(order.status).toBe('delivered');
        const updateSql = db.query.mock.calls[0][0];
        expect(updateSql).toContain('delivery_orders');
    });
});

// ============================================================================
// 12. Full Lifecycle Sequence
// ============================================================================

describe('Full Lifecycle — pending → active → delivered → completed', () => {
    it('transitions through the full happy path', async () => {
        // Step 1: Create order → pending
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'pending', _inserted: true })]
        });
        const created = await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Lifecycle Test',
            address: '100 Main St'
        });
        expect(created.status).toBe('pending');

        // Step 2: markDelivered → delivered (simulating POD)
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'delivered' })]
        });
        const delivered = await deliveryService.markDelivered(MERCHANT_ID, ORDER_ID);
        expect(delivered.status).toBe('delivered');

        // Step 3: completeOrder → completed (requires getOrderById first for status guard)
        // getOrderById returns delivered order
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'delivered' })]
        });
        // updateOrder
        db.query.mockResolvedValueOnce({
            rows: [makeOrder({ status: 'completed', square_order_id: 'SQ1' })]
        });
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });
        const completed = await deliveryService.completeOrder(MERCHANT_ID, ORDER_ID, USER_ID);
        expect(completed.status).toBe('completed');
    });
});

// ============================================================================
// 13. SEC-1: geocodePendingOrders UPDATE includes merchant_id
// ============================================================================

describe('geocodePendingOrders — merchant_id guard (SEC-1)', () => {
    it('UPDATE includes merchant_id in WHERE clause', () => {
        // Verify the SQL in the source code contains the merchant_id guard.
        // This is a static check — the UPDATE in geocodePendingOrders must
        // include AND merchant_id = $4 for defense in depth.
        const fs = jest.requireActual('fs');
        const src = fs.readFileSync(
            require.resolve('../../../services/delivery/delivery-geocoding.js'), 'utf8'
        );
        // SEC-1 fix: UPDATE must filter by merchant_id
        expect(src).toContain('AND merchant_id = $4');
        expect(src).toContain('[coords.lat, coords.lng, order.id, merchantId]');
    });
});
