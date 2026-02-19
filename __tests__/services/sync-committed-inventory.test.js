/**
 * Tests for syncCommittedInventory() reconciliation logic
 *
 * Verifies that the reconciliation:
 * - Cleans up committed_inventory rows for paid/terminal invoices
 * - Upserts rows for open invoices from Square API
 * - Rebuilds RESERVED_FOR_SALE aggregates from committed_inventory
 * - Returns detailed metrics (rows_before, rows_deleted, etc.)
 * - Warns when no changes are made despite existing records
 * - Throws on Square API failures (no silent success)
 */

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
    pool: { end: jest.fn().mockResolvedValue() }
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../utils/token-encryption', () => ({
    decryptToken: jest.fn(token => token),
    isEncryptedToken: jest.fn(() => false),
    encryptToken: jest.fn(token => token)
}));

const fetch = require('node-fetch');
const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Helper: build a mock fetch response
function mockFetchResponse(data, ok = true, status = 200) {
    return Promise.resolve({
        ok,
        status,
        headers: { get: jest.fn() },
        json: () => Promise.resolve(data)
    });
}

// Must require after mocks are set up
let syncCommittedInventory;

beforeAll(() => {
    // Clear any module caching
    jest.isolateModules(() => {
        syncCommittedInventory = require('../../services/square/api').syncCommittedInventory;
    });
});

describe('syncCommittedInventory', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Default: merchant token query
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '0' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                return { rows: [] };
            }
            if (sql.includes('DELETE FROM committed_inventory')) {
                return { rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        });

        // Default: transaction mock
        db.transaction.mockImplementation(async (fn) => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
            };
            return fn(mockClient);
        });
    });

    it('should throw when merchantId is missing', async () => {
        await expect(syncCommittedInventory(null)).rejects.toThrow('merchantId is required');
    });

    it('should return empty metrics when no active locations', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        const result = await syncCommittedInventory(1);

        expect(result.invoices_fetched).toBe(0);
        expect(result.rows_deleted).toBe(0);
    });

    it('should delete committed_inventory rows for paid invoices not in open set', async () => {
        // Setup: 2 invoices in committed_inventory, but Square says one is PAID
        db.query.mockImplementation((sql, params) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)') && !params) {
                return { rows: [{ cnt: '4' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '2' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                return { rows: [
                    { square_invoice_id: 'inv-open-1' },
                    { square_invoice_id: 'inv-paid-1' }
                ] };
            }
            if (sql.includes('DELETE FROM committed_inventory') && sql.includes('ANY')) {
                return { rowCount: 2 };
            }
            return { rows: [], rowCount: 0 };
        });

        // Square API: returns 2 invoices - one UNPAID (open), one PAID (terminal)
        fetch.mockImplementation((url) => {
            if (url.includes('/invoices/search')) {
                return mockFetchResponse({
                    invoices: [
                        { id: 'inv-open-1', status: 'UNPAID', location_id: 'loc-1', order_id: 'ord-1' },
                        { id: 'inv-paid-1', status: 'PAID', location_id: 'loc-1', order_id: 'ord-2' }
                    ]
                });
            }
            if (url.includes('/invoices/inv-open-1')) {
                return mockFetchResponse({
                    invoice: { id: 'inv-open-1', order_id: 'ord-1', status: 'UNPAID' }
                });
            }
            if (url.includes('/orders/ord-1')) {
                return mockFetchResponse({
                    order: {
                        id: 'ord-1',
                        location_id: 'loc-1',
                        line_items: [
                            { catalog_object_id: 'var-1', quantity: '3' }
                        ]
                    }
                });
            }
            return mockFetchResponse({});
        });

        const result = await syncCommittedInventory(1);

        expect(result.rows_deleted).toBe(2);
        expect(result.deleted_invoice_ids).toEqual(['inv-paid-1']);
        expect(result.invoices_fetched).toBe(2);
        expect(result.open_invoices).toBe(1);

        // Verify the DELETE query was called with the paid invoice ID
        const deleteCall = db.query.mock.calls.find(
            call => call[0].includes('DELETE') && call[0].includes('ANY')
        );
        expect(deleteCall).toBeDefined();
        expect(deleteCall[1]).toEqual([1, ['inv-paid-1']]);
    });

    it('should upsert line items for open invoices into committed_inventory', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '0' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        fetch.mockImplementation((url) => {
            if (url.includes('/invoices/search')) {
                return mockFetchResponse({
                    invoices: [
                        { id: 'inv-1', status: 'UNPAID', location_id: 'loc-1', order_id: 'ord-1' }
                    ]
                });
            }
            if (url.includes('/invoices/inv-1')) {
                return mockFetchResponse({
                    invoice: { id: 'inv-1', order_id: 'ord-1', status: 'UNPAID' }
                });
            }
            if (url.includes('/orders/ord-1')) {
                return mockFetchResponse({
                    order: {
                        id: 'ord-1',
                        location_id: 'loc-1',
                        line_items: [
                            { catalog_object_id: 'var-1', quantity: '3' },
                            { catalog_object_id: 'var-2', quantity: '5' }
                        ]
                    }
                });
            }
            return mockFetchResponse({});
        });

        const result = await syncCommittedInventory(1);

        expect(result.invoices_processed).toBe(1);
        expect(result.line_items_upserted).toBe(2);
        // Transaction should have been called for upsert + aggregate rebuild
        expect(db.transaction).toHaveBeenCalled();
    });

    it('should rebuild RESERVED_FOR_SALE aggregate from committed_inventory', async () => {
        const transactionQueries = [];
        db.transaction.mockImplementation(async (fn) => {
            const mockClient = {
                query: jest.fn().mockImplementation((sql) => {
                    transactionQueries.push(sql);
                    return { rows: [], rowCount: 0 };
                })
            };
            return fn(mockClient);
        });

        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '0' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        // No invoices from Square
        fetch.mockImplementation(() => {
            return mockFetchResponse({ invoices: [] });
        });

        await syncCommittedInventory(1);

        // Should have a transaction that deletes RESERVED_FOR_SALE and rebuilds
        const deleteReservedQuery = transactionQueries.find(
            q => q.includes('DELETE FROM inventory_counts') && q.includes('RESERVED_FOR_SALE')
        );
        const insertAggregateQuery = transactionQueries.find(
            q => q.includes('INSERT INTO inventory_counts') && q.includes('committed_inventory')
        );

        expect(deleteReservedQuery).toBeDefined();
        expect(insertAggregateQuery).toBeDefined();
    });

    it('should throw on Square API failure instead of silent success', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '3' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        // All Square API calls fail with 500
        fetch.mockImplementation(() => {
            return mockFetchResponse(
                { errors: [{ code: 'INTERNAL_SERVER_ERROR', detail: 'Server error' }] },
                false,
                500
            );
        });

        await expect(syncCommittedInventory(1)).rejects.toThrow();
    });

    it('should warn when no changes made despite existing records', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '4' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                // All existing invoices are still open
                return { rows: [{ square_invoice_id: 'inv-1' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        fetch.mockImplementation((url) => {
            if (url.includes('/invoices/search')) {
                return mockFetchResponse({
                    invoices: [
                        { id: 'inv-1', status: 'UNPAID', location_id: 'loc-1', order_id: 'ord-1' }
                    ]
                });
            }
            if (url.includes('/invoices/inv-1')) {
                return mockFetchResponse({
                    invoice: { id: 'inv-1', order_id: 'ord-1', status: 'UNPAID' }
                });
            }
            if (url.includes('/orders/ord-1')) {
                return mockFetchResponse({
                    order: {
                        id: 'ord-1',
                        location_id: 'loc-1',
                        line_items: [
                            { catalog_object_id: 'var-1', quantity: '2' }
                        ]
                    }
                });
            }
            return mockFetchResponse({});
        });

        const result = await syncCommittedInventory(1);

        expect(result.rows_before).toBe(4);
        expect(result.rows_deleted).toBe(0);
        // Should log a warning
        expect(logger.warn).toHaveBeenCalledWith(
            'Committed inventory reconciliation made no changes despite existing records',
            expect.objectContaining({ merchantId: 1 })
        );
    });

    it('should handle INSUFFICIENT_SCOPES gracefully', async () => {
        // Use merchantId=99 to avoid polluting the scope cache for other tests
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '0' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        fetch.mockImplementation(() => {
            return mockFetchResponse(
                { errors: [{ code: 'INSUFFICIENT_SCOPES', detail: 'Missing INVOICES_READ' }] },
                false,
                403
            );
        });

        const result = await syncCommittedInventory(99);

        expect(result.skipped).toBe(true);
        expect(result.reason).toContain('INVOICES_READ');
    });

    it('should handle paginated invoice results', async () => {
        let callCount = 0;
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '0' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        fetch.mockImplementation((url, options) => {
            if (url.includes('/invoices/search')) {
                callCount++;
                if (callCount === 1) {
                    return mockFetchResponse({
                        invoices: [
                            { id: 'inv-1', status: 'UNPAID', location_id: 'loc-1', order_id: 'ord-1' }
                        ],
                        cursor: 'page2'
                    });
                }
                return mockFetchResponse({
                    invoices: [
                        { id: 'inv-2', status: 'PAID', location_id: 'loc-1', order_id: 'ord-2' }
                    ]
                });
            }
            if (url.includes('/invoices/inv-1')) {
                return mockFetchResponse({
                    invoice: { id: 'inv-1', order_id: 'ord-1', status: 'UNPAID' }
                });
            }
            if (url.includes('/orders/ord-1')) {
                return mockFetchResponse({
                    order: {
                        id: 'ord-1', location_id: 'loc-1',
                        line_items: [{ catalog_object_id: 'var-1', quantity: '1' }]
                    }
                });
            }
            return mockFetchResponse({});
        });

        const result = await syncCommittedInventory(1);

        // Should have found 2 invoices total, 1 open
        expect(result.invoices_fetched).toBe(2);
        expect(result.open_invoices).toBe(1);
    });

    it('should return correct result shape', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'test-token' }] };
            }
            if (sql.includes('FROM locations')) {
                return { rows: [{ id: 'loc-1' }] };
            }
            if (sql.includes('count(*)')) {
                return { rows: [{ cnt: '0' }] };
            }
            if (sql.includes('DISTINCT square_invoice_id')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        fetch.mockImplementation(() => {
            return mockFetchResponse({ invoices: [] });
        });

        const result = await syncCommittedInventory(1);

        expect(result).toEqual(expect.objectContaining({
            invoices_fetched: expect.any(Number),
            open_invoices: expect.any(Number),
            invoices_processed: expect.any(Number),
            line_items_upserted: expect.any(Number),
            rows_before: expect.any(Number),
            rows_deleted: expect.any(Number),
            rows_remaining: expect.any(Number),
            deleted_invoice_ids: expect.any(Array)
        }));
    });
});

describe('committed-inventory-reconciliation-job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should track consecutive zero-deletion days and warn at 3+', async () => {
        // This is tested by the job module logic
        // Mock squareApi to return results with rows_before > 0 and rows_deleted = 0
        jest.resetModules();

        jest.doMock('../../utils/database', () => ({
            query: jest.fn().mockResolvedValue({
                rows: [{ id: 1, business_name: 'TestStore' }]
            }),
            pool: { end: jest.fn() }
        }));

        jest.doMock('../../utils/square-api', () => ({
            syncCommittedInventory: jest.fn().mockResolvedValue({
                rows_before: 5,
                rows_deleted: 0,
                rows_remaining: 5,
                invoices_fetched: 3,
                open_invoices: 2
            })
        }));

        jest.doMock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        }));

        const job = require('../../jobs/committed-inventory-reconciliation-job');
        const jobLogger = require('../../utils/logger');

        // Run 3 times to trigger the warning
        await job.runCommittedInventoryReconciliation();
        await job.runCommittedInventoryReconciliation();
        await job.runCommittedInventoryReconciliation();

        const warnCalls = jobLogger.warn.mock.calls.filter(
            call => call[0].includes('3+ consecutive days')
        );
        expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    });
});
