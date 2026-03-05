/**
 * Tests for vendor INSERT race condition in catalog-handler.js
 *
 * Verifies that when a concurrent sync inserts a vendor with the same name
 * between our SELECT and INSERT, the idx_vendors_merchant_name_unique constraint
 * error is caught and reconciliation succeeds.
 */

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

jest.mock('../../utils/subscription-handler', () => ({
    handleSubscriptionWebhook: jest.fn().mockResolvedValue({ processed: true }),
    getSubscriberBySquareSubscriptionId: jest.fn().mockResolvedValue(null),
    getSubscriberBySquareCustomerId: jest.fn().mockResolvedValue(null),
    logEvent: jest.fn().mockResolvedValue()
}));

jest.mock('../../utils/square-api', () => ({
    deltaSyncCatalog: jest.fn().mockResolvedValue({ items: 0, variations: 0, deltaSync: true }),
    syncInventory: jest.fn().mockResolvedValue({ counts: 0 }),
    syncCommittedInventory: jest.fn().mockResolvedValue({ synced: true }),
    syncSalesVelocity: jest.fn().mockResolvedValue({ updated: true }),
}));

jest.mock('../../utils/loyalty-service', () => ({
    runLoyaltyCatchup: jest.fn().mockResolvedValue()
}));

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue({
        orders: { get: jest.fn().mockResolvedValue({ order: null }) },
        invoices: { get: jest.fn().mockResolvedValue({ invoice: null }) }
    }),
    loadMerchantContext: jest.fn(),
    requireMerchant: jest.fn()
}));

jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue({}),
        identifyCustomerFromOrder: jest.fn().mockResolvedValue({ customerId: null, method: 'NONE', success: false }),
        getCustomerDetails: jest.fn().mockResolvedValue(null)
    }))
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { catalogHandler } = require('../../services/webhook-handlers');

describe('CatalogHandler - Vendor INSERT race condition', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function makeVendorContext(overrides = {}) {
        return {
            event: { type: 'vendor.created' },
            // entityId is the event reference ID (a UUID), NOT the vendor ID.
            // The handler must use data.vendor.id instead.
            entityId: 'event-ref-uuid-not-vendor-id',
            merchantId: 1,
            data: {
                vendor: {
                    id: 'V-NEW-ID',
                    name: 'Acme Pet Supplies',
                    status: 'ACTIVE',
                    contacts: [{ name: 'John', email_address: 'john@acme.com', phone_number: '555-1234' }]
                }
            },
            ...overrides
        };
    }

    it('should reconcile when concurrent insert triggers unique name constraint (same ID)', async () => {
        const constraintError = new Error('duplicate key value violates unique constraint "idx_vendors_merchant_name_unique"');
        constraintError.constraint = 'idx_vendors_merchant_name_unique';

        const queryResults = [];
        const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
                const call = { sql: typeof sql === 'string' ? sql.trim() : sql, params };
                queryResults.push(call);

                // 1. SELECT — no existing vendor (race window: vendor doesn't exist yet)
                if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('FROM vendors') && sql.includes('vendor_name_normalized')) {
                    // First SELECT returns empty (initial lookup), second returns the concurrent row
                    const selectCount = queryResults.filter(c =>
                        typeof c.sql === 'string' && c.sql.includes('SELECT') && c.sql.includes('FROM vendors') && c.sql.includes('vendor_name_normalized')
                    ).length;
                    if (selectCount === 1) {
                        return { rows: [] };
                    }
                    // Second SELECT (after ROLLBACK TO SAVEPOINT) — finds concurrent insert
                    return {
                        rows: [{
                            id: 'V-NEW-ID',
                            lead_time_days: null,
                            default_supply_days: 14,
                            minimum_order_amount: null,
                            payment_terms: null,
                            notes: null
                        }]
                    };
                }

                // 2. SAVEPOINT
                if (typeof sql === 'string' && sql.includes('SAVEPOINT')) {
                    return { rows: [] };
                }

                // 3. INSERT — fails with unique constraint (concurrent sync already inserted)
                if (typeof sql === 'string' && sql.includes('INSERT INTO vendors') && !sql.includes('lead_time_days')) {
                    throw constraintError;
                }

                // 4. ROLLBACK TO SAVEPOINT
                if (typeof sql === 'string' && sql.includes('ROLLBACK TO SAVEPOINT')) {
                    return { rows: [] };
                }

                // 5. UPDATE (same ID path — just update)
                if (typeof sql === 'string' && sql.includes('UPDATE vendors SET')) {
                    return { rows: [], rowCount: 1 };
                }

                return { rows: [], rowCount: 0 };
            }),
            release: jest.fn()
        };

        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const context = makeVendorContext();
        const result = await catalogHandler.handleVendorCreated(context);

        expect(result.handled).toBe(true);
        expect(result.vendor.id).toBe('V-NEW-ID');
        expect(result.vendor.name).toBe('Acme Pet Supplies');

        // Verify SAVEPOINT was used
        const savepointCalls = queryResults.filter(c => typeof c.sql === 'string' && c.sql.includes('SAVEPOINT vendor_insert'));
        expect(savepointCalls.length).toBeGreaterThanOrEqual(1);

        // Verify ROLLBACK TO SAVEPOINT was called after constraint error
        const rollbackCalls = queryResults.filter(c => typeof c.sql === 'string' && c.sql.includes('ROLLBACK TO SAVEPOINT'));
        expect(rollbackCalls.length).toBe(1);

        // Verify debug log for race condition
        expect(logger.debug).toHaveBeenCalledWith(
            'Vendor insert race condition, reconciling concurrent insert',
            expect.objectContaining({ vendorId: 'V-NEW-ID', merchantId: 1 })
        );

        // Verify UPDATE was called (same ID path)
        const updateCalls = queryResults.filter(c =>
            typeof c.sql === 'string' && c.sql.includes('UPDATE vendors SET') && c.sql.includes('contact_name')
        );
        expect(updateCalls.length).toBe(1);
    });

    it('should migrate FKs when concurrent insert has different vendor ID', async () => {
        const constraintError = new Error('duplicate key value violates unique constraint "idx_vendors_merchant_name_unique"');
        constraintError.constraint = 'idx_vendors_merchant_name_unique';

        const queryResults = [];
        const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
                const call = { sql: typeof sql === 'string' ? sql.trim() : sql, params };
                queryResults.push(call);

                // 1. SELECT — no existing vendor
                if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('FROM vendors') && sql.includes('vendor_name_normalized')) {
                    const selectCount = queryResults.filter(c =>
                        typeof c.sql === 'string' && c.sql.includes('SELECT') && c.sql.includes('FROM vendors') && c.sql.includes('vendor_name_normalized')
                    ).length;
                    if (selectCount === 1) {
                        return { rows: [] };
                    }
                    // After ROLLBACK TO SAVEPOINT — concurrent insert used different ID
                    return {
                        rows: [{
                            id: 'V-OLD-ID',
                            lead_time_days: 5,
                            default_supply_days: 14,
                            minimum_order_amount: 100,
                            payment_terms: 'Net 30',
                            notes: 'Preferred vendor'
                        }]
                    };
                }

                // SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE
                if (typeof sql === 'string' && (sql.includes('SAVEPOINT') || sql.includes('ROLLBACK TO SAVEPOINT') || sql.includes('RELEASE SAVEPOINT'))) {
                    return { rows: [] };
                }

                // INSERT — first insert fails (the plain one without lead_time_days)
                if (typeof sql === 'string' && sql.includes('INSERT INTO vendors') && !sql.includes('lead_time_days')) {
                    throw constraintError;
                }

                // Migration INSERT (with lead_time_days) — succeeds
                if (typeof sql === 'string' && sql.includes('INSERT INTO vendors') && sql.includes('lead_time_days')) {
                    return { rows: [], rowCount: 1 };
                }

                // FK migration UPDATEs
                if (typeof sql === 'string' && sql.includes('UPDATE') && sql.includes('SET vendor_id')) {
                    return { rows: [], rowCount: 2 };
                }

                // Rename __migrating
                if (typeof sql === 'string' && sql.includes('__migrating')) {
                    return { rows: [], rowCount: 1 };
                }

                // Safety check: remaining POs
                if (typeof sql === 'string' && sql.includes('SELECT COUNT') && sql.includes('purchase_orders')) {
                    return { rows: [{ cnt: '0' }] };
                }

                // DELETE old vendor
                if (typeof sql === 'string' && sql.includes('DELETE FROM vendors')) {
                    return { rows: [], rowCount: 1 };
                }

                return { rows: [], rowCount: 0 };
            }),
            release: jest.fn()
        };

        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const context = makeVendorContext();
        const result = await catalogHandler.handleVendorCreated(context);

        expect(result.handled).toBe(true);
        expect(result.vendor.id).toBe('V-NEW-ID');

        // Verify migration log
        expect(logger.info).toHaveBeenCalledWith(
            'Vendor ID change detected during race reconciliation, migrating references',
            expect.objectContaining({ oldId: 'V-OLD-ID', newId: 'V-NEW-ID', merchantId: 1 })
        );

        // Verify old vendor was renamed for migration
        const renameCalls = queryResults.filter(c =>
            typeof c.sql === 'string' && c.sql.includes('__migrating')
        );
        expect(renameCalls.length).toBe(1);
        expect(renameCalls[0].params).toEqual(['V-OLD-ID', 1]);

        // Verify new vendor was inserted with preserved local-only fields
        const migrationInserts = queryResults.filter(c =>
            typeof c.sql === 'string' && c.sql.includes('INSERT INTO vendors') && c.sql.includes('lead_time_days')
        );
        expect(migrationInserts.length).toBe(1);
        expect(migrationInserts[0].params).toEqual([
            'V-NEW-ID', 'Acme Pet Supplies', 'ACTIVE', 'John', 'john@acme.com', '555-1234',
            5, 14, 100, 'Net 30', 'Preferred vendor', 1
        ]);

        // Verify FK migration queries (5 tables)
        const fkTables = ['variation_vendors', 'purchase_orders', 'vendor_catalog_items', 'bundle_definitions', 'loyalty_offers'];
        for (const table of fkTables) {
            const fkCalls = queryResults.filter(c =>
                typeof c.sql === 'string' && c.sql.includes(`UPDATE ${table}`) && c.sql.includes('SET vendor_id')
            );
            expect(fkCalls.length).toBeGreaterThanOrEqual(1);
        }

        // Verify old vendor was deleted
        const deleteCalls = queryResults.filter(c =>
            typeof c.sql === 'string' && c.sql.includes('DELETE FROM vendors')
        );
        expect(deleteCalls.length).toBe(1);
        expect(deleteCalls[0].params).toEqual(['V-OLD-ID', 1]);
    });

    it('should rethrow non-constraint errors from INSERT', async () => {
        const dbError = new Error('Connection lost');

        const mockClient = {
            query: jest.fn().mockImplementation(async (sql) => {
                if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('FROM vendors')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('SAVEPOINT')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO vendors')) {
                    throw dbError;
                }
                if (typeof sql === 'string' && sql.includes('ROLLBACK TO SAVEPOINT')) {
                    return { rows: [] };
                }
                return { rows: [], rowCount: 0 };
            }),
            release: jest.fn()
        };

        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const context = makeVendorContext();
        await expect(catalogHandler.handleVendorCreated(context)).rejects.toThrow('Connection lost');
    });

    it('should succeed on normal insert when no race condition occurs', async () => {
        const queryResults = [];
        const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
                queryResults.push({ sql: typeof sql === 'string' ? sql.trim() : sql, params });

                if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('FROM vendors')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('SAVEPOINT')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('RELEASE SAVEPOINT')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO vendors')) {
                    return { rows: [], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            }),
            release: jest.fn()
        };

        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const context = makeVendorContext();
        const result = await catalogHandler.handleVendorCreated(context);

        expect(result.handled).toBe(true);
        expect(result.vendor.id).toBe('V-NEW-ID');

        // Verify SAVEPOINT was used and RELEASED (no rollback)
        const savepointCalls = queryResults.filter(c => typeof c.sql === 'string' && c.sql === 'SAVEPOINT vendor_insert');
        const releaseCalls = queryResults.filter(c => typeof c.sql === 'string' && c.sql === 'RELEASE SAVEPOINT vendor_insert');
        const rollbackCalls = queryResults.filter(c => typeof c.sql === 'string' && c.sql.includes('ROLLBACK TO SAVEPOINT'));
        expect(savepointCalls.length).toBe(1);
        expect(releaseCalls.length).toBe(1);
        expect(rollbackCalls.length).toBe(0);

        // No reconciliation log
        expect(logger.debug).not.toHaveBeenCalledWith(
            'Vendor insert race condition, reconciling concurrent insert',
            expect.anything()
        );
    });
});
