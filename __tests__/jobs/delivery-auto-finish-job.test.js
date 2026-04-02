/**
 * Tests for delivery-auto-finish-job
 *
 * Covers BACKLOG-116: auto-finish stale routes and delivery retention cleanup.
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger');

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const {
    runDeliveryAutoFinish,
    runDeliveryRetentionCleanup
} = require('../../jobs/delivery-auto-finish-job');

// Silent logger
beforeAll(() => {
    logger.info = jest.fn();
    logger.error = jest.fn();
    logger.warn = jest.fn();
});

// Helper: build a mock db client
function makeMockClient(queryResults = []) {
    let callIndex = 0;
    const client = {
        query: jest.fn(async () => {
            const result = queryResults[callIndex] ?? { rows: [], rowCount: 0 };
            callIndex++;
            return result;
        }),
        release: jest.fn()
    };
    return client;
}

describe('runDeliveryAutoFinish', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('returns zero counts and logs when no stale routes exist', async () => {
        db.query = jest.fn().mockResolvedValue({ rows: [] });

        const result = await runDeliveryAutoFinish();

        expect(result).toEqual({ routesFinished: 0, ordersReset: 0 });
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("status = 'active'")
        );
    });

    it('finishes stale routes and resets skipped/active orders', async () => {
        const staleRoutes = [
            { id: 'route-1', merchant_id: 1 },
            { id: 'route-2', merchant_id: 2 }
        ];
        db.query = jest.fn().mockResolvedValue({ rows: staleRoutes });

        // Each route: BEGIN, complete delivered, reset skipped/active (rowCount=2), finish route, COMMIT
        const client1 = makeMockClient([
            { rows: [] },           // BEGIN
            { rows: [], rowCount: 0 }, // UPDATE delivered → completed
            { rows: [], rowCount: 2 }, // UPDATE skipped/active → pending
            { rows: [] },           // UPDATE route → finished
            { rows: [] }            // COMMIT
        ]);
        const client2 = makeMockClient([
            { rows: [] },
            { rows: [], rowCount: 1 },
            { rows: [], rowCount: 3 },
            { rows: [] },
            { rows: [] }
        ]);
        db.getClient = jest.fn()
            .mockResolvedValueOnce(client1)
            .mockResolvedValueOnce(client2);

        const result = await runDeliveryAutoFinish();

        expect(result.routesFinished).toBe(2);
        expect(result.ordersReset).toBe(5); // 2 + 3
        expect(client1.query).toHaveBeenCalledWith('BEGIN');
        expect(client1.query).toHaveBeenCalledWith('COMMIT');
        expect(client1.release).toHaveBeenCalled();
        expect(client2.release).toHaveBeenCalled();
    });

    it('rolls back and continues when one route fails', async () => {
        const staleRoutes = [{ id: 'route-bad', merchant_id: 1 }];
        db.query = jest.fn().mockResolvedValue({ rows: staleRoutes });

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] })   // BEGIN
                .mockRejectedValueOnce(new Error('DB error')), // UPDATE delivered fails
            release: jest.fn()
        };
        db.getClient = jest.fn().mockResolvedValue(client);

        const result = await runDeliveryAutoFinish();

        expect(result.routesFinished).toBe(0);
        expect(result.ordersReset).toBe(0);
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.release).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to auto-finish route',
            expect.objectContaining({ routeId: 'route-bad' })
        );
    });

    it('returns error object on unexpected top-level failure', async () => {
        db.query = jest.fn().mockRejectedValue(new Error('connection refused'));

        const result = await runDeliveryAutoFinish();

        expect(result).toEqual({ routesFinished: 0, ordersReset: 0, errors: 1 });
        expect(logger.error).toHaveBeenCalledWith(
            'Delivery auto-finish job failed',
            expect.any(Object)
        );
    });

    it('only targets routes with status=active created before today', async () => {
        db.query = jest.fn().mockResolvedValue({ rows: [] });

        await runDeliveryAutoFinish();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toMatch(/status = 'active'/);
        expect(sql).toMatch(/created_at::date < CURRENT_DATE/);
    });

    it('does not touch delivered orders — promotes them to completed', async () => {
        const staleRoutes = [{ id: 'route-1', merchant_id: 1 }];
        db.query = jest.fn().mockResolvedValue({ rows: staleRoutes });

        const client = makeMockClient([
            { rows: [] },
            { rows: [], rowCount: 0 },
            { rows: [], rowCount: 0 },
            { rows: [] },
            { rows: [] }
        ]);
        db.getClient = jest.fn().mockResolvedValue(client);

        await runDeliveryAutoFinish();

        const calls = client.query.mock.calls.map(c => c[0]);
        const deliveredUpdate = calls.find(s => typeof s === 'string' && s.includes("'delivered'") && s.includes("'completed'"));
        expect(deliveredUpdate).toBeDefined();
    });
});

describe('runDeliveryRetentionCleanup', () => {
    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.DELIVERY_RETENTION_DAYS;
    });

    it('returns zero counts when no old routes exist', async () => {
        db.query = jest.fn().mockResolvedValue({ rows: [] });

        const result = await runDeliveryRetentionCleanup();

        expect(result).toEqual({ routesDeleted: 0, ordersDeleted: 0 });
    });

    it('deletes old routes and their orders in a transaction', async () => {
        const oldRoutes = [{ id: 'route-old-1' }, { id: 'route-old-2' }];
        db.query = jest.fn().mockResolvedValue({ rows: oldRoutes });

        const client = makeMockClient([
            { rows: [] },                      // BEGIN
            { rows: [], rowCount: 5 },         // DELETE orders
            { rows: [], rowCount: 2 },         // DELETE routes
            { rows: [] }                       // COMMIT
        ]);
        db.getClient = jest.fn().mockResolvedValue(client);

        const result = await runDeliveryRetentionCleanup();

        expect(result).toEqual({ routesDeleted: 2, ordersDeleted: 5 });
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(client.release).toHaveBeenCalled();
    });

    it('uses DELIVERY_RETENTION_DAYS env var when set', async () => {
        process.env.DELIVERY_RETENTION_DAYS = '30';
        db.query = jest.fn().mockResolvedValue({ rows: [] });

        await runDeliveryRetentionCleanup();

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/INTERVAL/);
        expect(params).toContain(30);
    });

    it('defaults to 90 days when DELIVERY_RETENTION_DAYS is not set', async () => {
        db.query = jest.fn().mockResolvedValue({ rows: [] });

        await runDeliveryRetentionCleanup();

        const [, params] = db.query.mock.calls[0];
        expect(params).toContain(90);
    });

    it('only targets finished and cancelled routes', async () => {
        db.query = jest.fn().mockResolvedValue({ rows: [] });

        await runDeliveryRetentionCleanup();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toMatch(/'finished'/);
        expect(sql).toMatch(/'cancelled'/);
        expect(sql).not.toMatch(/'active'/);
        expect(sql).not.toMatch(/'pending'/);
    });

    it('only deletes non-active order statuses', async () => {
        const oldRoutes = [{ id: 'route-1' }];
        db.query = jest.fn().mockResolvedValue({ rows: oldRoutes });

        const client = makeMockClient([
            { rows: [] },
            { rows: [], rowCount: 3 },
            { rows: [], rowCount: 1 },
            { rows: [] }
        ]);
        db.getClient = jest.fn().mockResolvedValue(client);

        await runDeliveryRetentionCleanup();

        const deleteSql = client.query.mock.calls
            .map(c => c[0])
            .find(s => typeof s === 'string' && s.includes('DELETE FROM delivery_orders'));

        expect(deleteSql).toMatch(/'completed'/);
        expect(deleteSql).toMatch(/'delivered'/);
        expect(deleteSql).toMatch(/'skipped'/);
        expect(deleteSql).not.toMatch(/'pending'/);
        expect(deleteSql).not.toMatch(/'active'/);
    });

    it('rolls back and throws on DB error during cleanup', async () => {
        const oldRoutes = [{ id: 'route-1' }];
        db.query = jest.fn().mockResolvedValue({ rows: oldRoutes });

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] })   // BEGIN
                .mockRejectedValueOnce(new Error('delete failed')),
            release: jest.fn()
        };
        db.getClient = jest.fn().mockResolvedValue(client);

        const result = await runDeliveryRetentionCleanup();

        expect(result).toEqual({ routesDeleted: 0, ordersDeleted: 0, errors: 1 });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(logger.error).toHaveBeenCalledWith(
            'Delivery retention cleanup job failed',
            expect.any(Object)
        );
    });
});
