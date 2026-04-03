/**
 * Tests for services/delivery/delivery-routes.js
 *
 * Covers:
 *   - getActiveRouteWithOrders — extracted from GET /route/active handler
 *   - finishRoute(merchantId, null, userId) — absorbs active-route resolution from route handler
 */

const db = require('../../../utils/database');

jest.mock('../../../utils/token-encryption', () => ({
    encryptToken: jest.fn(val => `encrypted:${val}`),
    decryptToken: jest.fn(val => val.replace('encrypted:', '')),
    isEncryptedToken: jest.fn(val => val?.startsWith('encrypted:'))
}));
jest.mock('../../../services/loyalty-admin/customer-details-service', () => ({
    getCustomerDetails: jest.fn().mockResolvedValue(null)
}));
jest.mock('fs', () => ({ promises: { mkdir: jest.fn(), writeFile: jest.fn(), unlink: jest.fn() } }));
global.fetch = jest.fn();

const { getActiveRouteWithOrders, finishRoute } = require('../../../services/delivery/delivery-routes');

const MERCHANT_ID = 1;
const USER_ID = 10;
const ROUTE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TODAY = new Date().toISOString().split('T')[0];

function makeRoute(overrides = {}) {
    return { id: ROUTE_ID, merchant_id: MERCHANT_ID, status: 'active', route_date: TODAY, ...overrides };
}

function makeMockClient(queryResults = []) {
    let i = 0;
    return {
        query: jest.fn().mockImplementation(() =>
            Promise.resolve(queryResults[i] ? queryResults[i++] : { rows: [], rowCount: 0 })
        ),
        release: jest.fn()
    };
}

beforeEach(() => {
    jest.resetAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    db.getClient.mockResolvedValue(makeMockClient());
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
});

// ---------------------------------------------------------------------------
// getActiveRouteWithOrders
// ---------------------------------------------------------------------------
describe('getActiveRouteWithOrders', () => {
    it('returns { route: null, orders: [] } when no active route exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getActiveRoute finds nothing
        const result = await getActiveRouteWithOrders(MERCHANT_ID);
        expect(result).toEqual({ route: null, orders: [] });
    });

    it('returns route and orders when active route exists', async () => {
        const route = makeRoute();
        db.query
            .mockResolvedValueOnce({ rows: [route] })   // getActiveRoute
            .mockResolvedValueOnce({ rows: [route] })   // getRouteWithOrders — route lookup
            .mockResolvedValueOnce({ rows: [] });        // getOrders inside getRouteWithOrders
        const result = await getActiveRouteWithOrders(MERCHANT_ID);
        expect(result.route).toMatchObject({ id: ROUTE_ID });
        expect(Array.isArray(result.orders)).toBe(true);
    });

    it('returns empty orders array when route has no orders', async () => {
        const route = makeRoute();
        db.query
            .mockResolvedValueOnce({ rows: [route] })
            .mockResolvedValueOnce({ rows: [route] })
            .mockResolvedValueOnce({ rows: [] });
        const { orders } = await getActiveRouteWithOrders(MERCHANT_ID);
        expect(orders).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// finishRoute — null routeId resolution (absorbed from route handler)
// ---------------------------------------------------------------------------
describe('finishRoute with null routeId', () => {
    it('throws 400 error when no routeId and no active route exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getActiveRoute finds nothing
        await expect(finishRoute(MERCHANT_ID, null, USER_ID)).rejects.toMatchObject({
            message: 'No active route found',
            status: 400
        });
    });

    it('resolves to active route ID when routeId is null', async () => {
        const route = makeRoute();
        db.query.mockResolvedValueOnce({ rows: [route] }); // getActiveRoute

        const client = makeMockClient([
            { rows: [] },                           // BEGIN
            { rows: [route] },                      // SELECT delivery_routes
            { rows: [{ completed: '2', skipped: '1', delivered: '0', still_active: '0' }] }, // stats
            { rows: [], rowCount: 0 },              // UPDATE delivered → completed
            { rows: [], rowCount: 0 },              // UPDATE skipped/active → pending
            { rows: [], rowCount: 0 },              // UPDATE route status
            { rows: [] }                            // COMMIT
        ]);
        db.getClient.mockResolvedValueOnce(client);
        // logAuditEvent uses db.query
        db.query.mockResolvedValue({ rows: [] });

        const result = await finishRoute(MERCHANT_ID, null, USER_ID);
        expect(result.routeId).toBe(ROUTE_ID);
    });
});
