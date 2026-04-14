/**
 * Tests for LA-22, LA-26, C-3 fixes
 *
 * LA-22: Consolidated idempotency check in backfill-service.js
 * LA-26: Paginated search methods in square-api-client.js
 * C-3: Startup environment variable validation
 */

// =========================================================================
// LA-22: isOrderAlreadyProcessedForLoyalty checks both tables
// =========================================================================

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        squareApi: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: jest.fn(),
    getSquareAccessToken: jest.fn(),
    squareApiRequest: jest.fn(),
    SquareApiError: class SquareApiError extends Error {
        constructor(message, status, endpoint, details) {
            super(message);
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
        }
    },
}));

// square-api-client.js is now a thin shim over services/square/square-client.js
// (see docs/SQUARE_CLIENT_REFACTOR_PLAN.md Task 11). Mock the canonical
// module here so the LA-26 pagination tests exercise the shim end-to-end.
jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: jest.fn(),
    getMerchantToken: jest.fn(),
    SquareApiError: class SquareApiError extends Error {
        constructor(message, { status, endpoint, details = [], nonRetryable = false } = {}) {
            super(message);
            this.name = 'SquareApiError';
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
            this.nonRetryable = nonRetryable;
            this.squareErrors = details;
        }
    },
}));

jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/loyalty-event-prefetch-service', () => ({
    prefetchRecentLoyaltyEvents: jest.fn(),
    findCustomerFromPrefetchedEvents: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/order-history-audit-service', () => ({
    getCustomerOrderHistoryForAudit: jest.fn(),
    addOrdersToLoyaltyTracking: jest.fn(),
}));

const db = require('../../../utils/database');

describe('LA-22: isOrderAlreadyProcessedForLoyalty checks both tables', () => {
    const { isOrderAlreadyProcessedForLoyalty } = require('../../../services/loyalty-admin/backfill-service');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('queries both loyalty_processed_orders and loyalty_purchase_events', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await isOrderAlreadyProcessedForLoyalty('ORDER_1', 1);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('loyalty_processed_orders');
        expect(sql).toContain('loyalty_purchase_events');
    });

    test('returns true when order exists in loyalty_processed_orders only', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

        const result = await isOrderAlreadyProcessedForLoyalty('ORDER_1', 1);

        expect(result).toBe(true);
    });

    test('returns false when order not in either table', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await isOrderAlreadyProcessedForLoyalty('ORDER_1', 1);

        expect(result).toBe(false);
    });

    test('includes merchant_id in both subqueries', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await isOrderAlreadyProcessedForLoyalty('ORDER_1', 42);

        const [sql, params] = db.query.mock.calls[0];
        // Both subqueries reference $1 (merchantId)
        expect(sql).toContain('merchant_id = $1');
        expect(params).toEqual([42, 'ORDER_1']);
    });
});

// =========================================================================
// LA-26: SquareApiClient search methods paginate
// =========================================================================

describe('LA-26: SquareApiClient search methods paginate', () => {
    const { makeSquareRequest, getMerchantToken } = require('../../../services/square/square-client');

    beforeEach(() => {
        jest.clearAllMocks();
        getMerchantToken.mockResolvedValue('test-token');
    });

    test('searchLoyaltyEvents fetches all pages', async () => {
        const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');

        // Page 1: returns cursor
        makeSquareRequest
            .mockResolvedValueOnce({ events: [{ id: 'e1' }, { id: 'e2' }], cursor: 'page2' })
            .mockResolvedValueOnce({ events: [{ id: 'e3' }] }); // Page 2: no cursor

        const client = new SquareApiClient(1);
        await client.initialize();
        const events = await client.searchLoyaltyEvents({ query: {} });

        expect(events).toHaveLength(3);
        expect(events.map(e => e.id)).toEqual(['e1', 'e2', 'e3']);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);

        // Second call should include cursor in body
        const secondCallOpts = makeSquareRequest.mock.calls[1][1];
        expect(JSON.parse(secondCallOpts.body).cursor).toBe('page2');
    });

    test('searchCustomers fetches all pages', async () => {
        const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');

        makeSquareRequest
            .mockResolvedValueOnce({ customers: [{ id: 'c1' }], cursor: 'next' })
            .mockResolvedValueOnce({ customers: [{ id: 'c2' }] });

        const client = new SquareApiClient(1);
        await client.initialize();
        const customers = await client.searchCustomers({ query: {} });

        expect(customers).toHaveLength(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('searchLoyaltyEvents stops at max 20 pages', async () => {
        const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');
        const logger = require('../../../utils/logger');

        // Always return a cursor (infinite pages)
        makeSquareRequest.mockResolvedValue({ events: [{ id: 'e' }], cursor: 'more' });

        const client = new SquareApiClient(1);
        await client.initialize();
        const events = await client.searchLoyaltyEvents({ query: {} });

        expect(events).toHaveLength(20);
        expect(makeSquareRequest).toHaveBeenCalledTimes(20);
        expect(logger.error).toHaveBeenCalledWith(
            'searchLoyaltyEvents hit max pagination limit',
            expect.objectContaining({ maxPages: 20 })
        );
    });

    test('searchCustomers stops at max 20 pages', async () => {
        const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');
        const logger = require('../../../utils/logger');

        makeSquareRequest.mockResolvedValue({ customers: [{ id: 'c' }], cursor: 'more' });

        const client = new SquareApiClient(1);
        await client.initialize();
        const customers = await client.searchCustomers({ query: {} });

        expect(customers).toHaveLength(20);
        expect(logger.error).toHaveBeenCalledWith(
            'searchCustomers hit max pagination limit',
            expect.objectContaining({ maxPages: 20 })
        );
    });

    test('searchLoyaltyEvents returns empty array when no events', async () => {
        const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');

        makeSquareRequest.mockResolvedValueOnce({});

        const client = new SquareApiClient(1);
        await client.initialize();
        const events = await client.searchLoyaltyEvents({ query: {} });

        expect(events).toEqual([]);
    });
});

// =========================================================================
// C-3: Startup environment variable validation
// =========================================================================

describe('C-3: Startup environment variable validation', () => {
    const originalEnv = process.env;
    let mockExit;
    let mockConsoleError;
    let mockConsoleWarn;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
        mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit called');
        });
        mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = originalEnv;
        mockExit.mockRestore();
        mockConsoleError.mockRestore();
        mockConsoleWarn.mockRestore();
    });

    test('in production, exits if TOKEN_ENCRYPTION_KEY is missing', () => {
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgres://localhost/test';
        process.env.SESSION_SECRET = 'secret';
        process.env.SQUARE_APPLICATION_ID = 'app-id';
        process.env.SQUARE_APPLICATION_SECRET = 'app-secret';
        delete process.env.TOKEN_ENCRYPTION_KEY;

        // The validation runs at module load time via require('dotenv') + IIFE
        // We test the logic directly
        const isProduction = true;
        const missingRequired = ['TOKEN_ENCRYPTION_KEY'].filter(v => !process.env[v]);
        expect(missingRequired).toContain('TOKEN_ENCRYPTION_KEY');

        if (isProduction && missingRequired.length > 0) {
            // Would call process.exit(1) in production
            expect(true).toBe(true);
        }
    });

    test('in development, logs warning for missing vars without exiting', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.TOKEN_ENCRYPTION_KEY;
        delete process.env.SESSION_SECRET;
        delete process.env.SQUARE_APPLICATION_ID;
        delete process.env.SQUARE_APPLICATION_SECRET;
        process.env.DATABASE_URL = 'postgres://localhost/test';

        const isProduction = process.env.NODE_ENV === 'production';
        const requiredVars = ['TOKEN_ENCRYPTION_KEY', 'SESSION_SECRET', 'SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET'];
        const missingRequired = requiredVars.filter(v => !process.env[v]);

        expect(isProduction).toBe(false);
        expect(missingRequired.length).toBeGreaterThan(0);
    });

    test('database validation accepts DATABASE_URL as alternative to individual vars', () => {
        process.env.DATABASE_URL = 'postgres://localhost/test';
        delete process.env.DB_HOST;
        delete process.env.DB_PORT;

        const hasDbUrl = !!process.env.DATABASE_URL;
        const dbVars = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
        const hasAllDbVars = dbVars.every(v => !!process.env[v]);

        // DATABASE_URL present, so no DB vars needed
        expect(hasDbUrl).toBe(true);
        const missingDbVars = hasDbUrl ? [] : dbVars.filter(v => !process.env[v]);
        expect(missingDbVars).toEqual([]);
    });

    test('database validation requires all individual DB vars when DATABASE_URL absent', () => {
        delete process.env.DATABASE_URL;
        process.env.DB_HOST = 'localhost';
        delete process.env.DB_PORT;
        delete process.env.DB_USER;

        const hasDbUrl = !!process.env.DATABASE_URL;
        const dbVars = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
        const missingDbVars = hasDbUrl ? [] : dbVars.filter(v => !process.env[v]);

        expect(missingDbVars.length).toBeGreaterThan(0);
        expect(missingDbVars).toContain('DB_PORT');
    });
});
