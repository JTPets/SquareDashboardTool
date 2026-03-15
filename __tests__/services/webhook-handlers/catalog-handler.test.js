/**
 * Tests for CatalogHandler (services/webhook-handlers/catalog-handler.js)
 *
 * Covers all public methods and private method behavior tested through
 * public entry points:
 * - handleCatalogVersionUpdated
 * - handleVendorCreated / handleVendorUpdated (+ _handleVendorChange)
 * - handleLocationCreated / handleLocationUpdated (+ _handleLocationChange)
 * - reconcileBundleComponents (named export)
 */

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};
jest.mock('../../../utils/logger', () => logger);

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn()
}));

jest.mock('../../../services/square', () => ({
    deltaSyncCatalog: jest.fn()
}));

const db = require('../../../utils/database');
const squareApi = require('../../../services/square');
const CatalogHandler = require('../../../services/webhook-handlers/catalog-handler');
const { reconcileBundleComponents } = require('../../../services/webhook-handlers/catalog-handler');

let handler;
let mockSyncQueue;
let mockClient;

beforeEach(() => {
    jest.clearAllMocks();

    mockClient = { query: jest.fn() };
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    mockSyncQueue = {
        executeWithQueue: jest.fn()
    };

    handler = new CatalogHandler(mockSyncQueue);

    delete process.env.WEBHOOK_CATALOG_SYNC;
});

// ─── handleCatalogVersionUpdated ─────────────────────────────────────────────

describe('handleCatalogVersionUpdated', () => {
    const baseContext = {
        merchantId: 42,
        data: {
            object: {
                catalog_version: {
                    updated_at: '2026-03-15T10:00:00Z'
                }
            }
        }
    };

    describe('guard clauses', () => {
        it('returns skipped when WEBHOOK_CATALOG_SYNC is false', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.skipped).toBe(true);
            expect(result.handled).toBe(true);
            expect(mockSyncQueue.executeWithQueue).not.toHaveBeenCalled();
        });

        it('returns error when merchantId is falsy', async () => {
            const result = await handler.handleCatalogVersionUpdated({
                ...baseContext,
                merchantId: null
            });

            expect(result.error).toBe('Merchant not found');
            expect(result.handled).toBe(true);
            expect(mockSyncQueue.executeWithQueue).not.toHaveBeenCalled();
        });

        it('returns error when merchantId is 0', async () => {
            const result = await handler.handleCatalogVersionUpdated({
                ...baseContext,
                merchantId: 0
            });

            expect(result.error).toBe('Merchant not found');
        });

        it('returns error when merchantId is undefined', async () => {
            const result = await handler.handleCatalogVersionUpdated({
                data: baseContext.data
            });

            expect(result.error).toBe('Merchant not found');
        });
    });

    describe('version deduplication', () => {
        it('skips when last_catalog_version >= catalogVersionUpdatedAt', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ last_catalog_version: '2026-03-15T12:00:00Z' }]
            });

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.skipped).toBe(true);
            expect(result.reason).toBe('duplicate_version');
            expect(mockSyncQueue.executeWithQueue).not.toHaveBeenCalled();
        });

        it('skips when last_catalog_version equals catalogVersionUpdatedAt', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ last_catalog_version: '2026-03-15T10:00:00Z' }]
            });

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.skipped).toBe(true);
            expect(result.reason).toBe('duplicate_version');
        });

        it('proceeds when last_catalog_version < catalogVersionUpdatedAt', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ last_catalog_version: '2026-03-15T08:00:00Z' }]
            });
            mockSyncQueue.executeWithQueue.mockResolvedValue({ result: { items: 5, variations: 10, deltaSync: true } });
            // reconcileBundleComponents query
            db.query.mockResolvedValueOnce({ rows: [] });
            // version update query
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.skipped).toBeUndefined();
            expect(mockSyncQueue.executeWithQueue).toHaveBeenCalled();
        });

        it('proceeds when no sync_history row exists', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            mockSyncQueue.executeWithQueue.mockResolvedValue({ result: { items: 3, variations: 7, deltaSync: true } });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.skipped).toBeUndefined();
            expect(mockSyncQueue.executeWithQueue).toHaveBeenCalled();
        });

        it('proceeds when last_catalog_version is null', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ last_catalog_version: null }]
            });
            mockSyncQueue.executeWithQueue.mockResolvedValue({ result: { items: 1, variations: 2, deltaSync: false } });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(mockSyncQueue.executeWithQueue).toHaveBeenCalled();
        });

        it('proceeds if dedup check throws an error (non-fatal)', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection timeout'));
            mockSyncQueue.executeWithQueue.mockResolvedValue({ result: { items: 2, variations: 4, deltaSync: true } });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(logger.warn).toHaveBeenCalledWith('Catalog version dedup check failed', expect.any(Object));
            expect(mockSyncQueue.executeWithQueue).toHaveBeenCalled();
        });

        it('skips dedup check when catalogVersionUpdatedAt is absent', async () => {
            const contextNoVersion = { merchantId: 42, data: {} };
            mockSyncQueue.executeWithQueue.mockResolvedValue({ result: { items: 1, variations: 1, deltaSync: false } });
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await handler.handleCatalogVersionUpdated(contextNoVersion);

            // Should not have queried sync_history for version check
            expect(db.query).not.toHaveBeenCalledWith(
                expect.stringContaining('last_catalog_version'),
                expect.any(Array)
            );
            expect(mockSyncQueue.executeWithQueue).toHaveBeenCalled();
        });
    });

    describe('sync queue execution', () => {
        beforeEach(() => {
            // Skip past dedup check
            db.query.mockResolvedValueOnce({ rows: [] });
        });

        it('calls syncQueue.executeWithQueue with correct arguments', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ result: { items: 0, variations: 0, deltaSync: true } });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({});

            await handler.handleCatalogVersionUpdated(baseContext);

            expect(mockSyncQueue.executeWithQueue).toHaveBeenCalledWith(
                'catalog',
                42,
                expect.any(Function)
            );
        });

        it('calls deltaSyncCatalog when queue function executes', async () => {
            mockSyncQueue.executeWithQueue.mockImplementation(async (type, id, fn) => {
                const syncResult = await fn();
                return { result: syncResult };
            });
            squareApi.deltaSyncCatalog.mockResolvedValue({ items: 5, variations: 10, deltaSync: true });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({});

            await handler.handleCatalogVersionUpdated(baseContext);

            expect(squareApi.deltaSyncCatalog).toHaveBeenCalledWith(42);
        });

        it('sets result.queued when syncResult.queued is true', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ queued: true });
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.queued).toBe(true);
            expect(result.catalog).toBeUndefined();
        });

        it('sets result.error when syncResult.error is present', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ error: 'Sync failed' });

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.error).toBe('Sync failed');
            expect(result.catalog).toBeUndefined();
        });

        it('sets result.catalog on success with items/variations/deltaSync', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({
                result: { items: 12, variations: 30, deltaSync: true }
            });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.catalog).toEqual({
                items: 12,
                variations: 30,
                deltaSync: true
            });
        });
    });

    describe('post-sync behavior', () => {
        beforeEach(() => {
            db.query.mockResolvedValueOnce({ rows: [] }); // dedup check
        });

        it('calls reconcileBundleComponents after successful sync', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({
                result: { items: 5, variations: 10, deltaSync: true }
            });
            // reconcileBundleComponents stale query
            db.query.mockResolvedValueOnce({ rows: [] });
            // version update
            db.query.mockResolvedValueOnce({});

            await handler.handleCatalogVersionUpdated(baseContext);

            // Second db.query call should be the reconcile query
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('bundle_components'),
                [42]
            );
        });

        it('does not call reconcileBundleComponents when syncResult has error', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ error: 'Something broke' });

            await handler.handleCatalogVersionUpdated(baseContext);

            // Only 1 db.query call for dedup, none for reconcile
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('does not call reconcileBundleComponents when syncResult is queued', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ queued: true });

            await handler.handleCatalogVersionUpdated(baseContext);

            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('updates last_catalog_version after successful sync', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({
                result: { items: 1, variations: 2, deltaSync: true }
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // reconcile
            db.query.mockResolvedValueOnce({}); // version update

            await handler.handleCatalogVersionUpdated(baseContext);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE sync_history'),
                ['2026-03-15T10:00:00Z', 42]
            );
        });

        it('does not update version when catalogVersionUpdatedAt is absent', async () => {
            const contextNoVersion = { merchantId: 42, data: {} };
            // Reset mocks since we skip dedup too
            db.query.mockReset();
            mockSyncQueue.executeWithQueue.mockResolvedValue({
                result: { items: 1, variations: 2, deltaSync: false }
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // reconcile

            await handler.handleCatalogVersionUpdated(contextNoVersion);

            expect(db.query).not.toHaveBeenCalledWith(
                expect.stringContaining('UPDATE sync_history'),
                expect.any(Array)
            );
        });

        it('does not update version when syncResult has error', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ error: 'Failed' });

            await handler.handleCatalogVersionUpdated(baseContext);

            expect(db.query).not.toHaveBeenCalledWith(
                expect.stringContaining('UPDATE sync_history'),
                expect.any(Array)
            );
        });

        it('does not update version when syncResult is queued', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({ queued: true });

            await handler.handleCatalogVersionUpdated(baseContext);

            expect(db.query).not.toHaveBeenCalledWith(
                expect.stringContaining('UPDATE sync_history'),
                expect.any(Array)
            );
        });

        it('tolerates version update failure (non-fatal)', async () => {
            mockSyncQueue.executeWithQueue.mockResolvedValue({
                result: { items: 1, variations: 1, deltaSync: true }
            });
            db.query
                .mockResolvedValueOnce({ rows: [] }) // reconcile
                .mockRejectedValueOnce(new Error('DB write failed')); // version update

            const result = await handler.handleCatalogVersionUpdated(baseContext);

            expect(result.handled).toBe(true);
            expect(result.catalog).toBeDefined();
            expect(logger.warn).toHaveBeenCalledWith(
                'Failed to update catalog version',
                expect.objectContaining({ error: 'DB write failed' })
            );
        });
    });
});

// ─── handleVendorCreated / handleVendorUpdated ───────────────────────────────

describe('handleVendorCreated / handleVendorUpdated', () => {
    const vendorContext = {
        merchantId: 42,
        data: {
            vendor: {
                id: 'VENDOR_ABC',
                name: 'Acme Pet Supplies',
                status: 'ACTIVE',
                contacts: [
                    {
                        name: 'John Doe',
                        email_address: 'john@acme.com',
                        phone_number: '555-1234'
                    }
                ]
            }
        },
        event: { type: 'vendor.created' },
        entityId: 'EVENT_REF_ID_NOT_VENDOR_ID'
    };

    describe('guard clauses', () => {
        it('returns skipped when WEBHOOK_CATALOG_SYNC is false', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleVendorCreated(vendorContext);

            expect(result.skipped).toBe(true);
            expect(result.handled).toBe(true);
            expect(db.transaction).not.toHaveBeenCalled();
        });

        it('returns error when merchantId is falsy', async () => {
            const result = await handler.handleVendorUpdated({
                ...vendorContext,
                merchantId: null
            });

            expect(result.error).toBe('Merchant not found');
        });

        it('returns handled:true when no vendor in data', async () => {
            const result = await handler.handleVendorCreated({
                merchantId: 42,
                data: {},
                event: { type: 'vendor.created' }
            });

            expect(result.handled).toBe(true);
            expect(result.vendor).toBeUndefined();
            expect(db.transaction).not.toHaveBeenCalled();
        });
    });

    describe('vendor ID sourcing', () => {
        it('uses data.vendor.id NOT entityId', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // existing check
            mockClient.query.mockResolvedValueOnce({}); // SAVEPOINT
            mockClient.query.mockResolvedValueOnce({}); // INSERT
            mockClient.query.mockResolvedValueOnce({}); // RELEASE

            const result = await handler.handleVendorCreated(vendorContext);

            expect(result.vendor.id).toBe('VENDOR_ABC');
            // The entityId 'EVENT_REF_ID_NOT_VENDOR_ID' should NOT appear in queries
            const allQueryCalls = mockClient.query.mock.calls;
            const allArgs = allQueryCalls.flatMap(call => call[1] || []);
            expect(allArgs).not.toContain('EVENT_REF_ID_NOT_VENDOR_ID');
        });
    });

    describe('existing vendor matched by ID (UPDATE path)', () => {
        it('updates vendor fields when matched by ID', async () => {
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 'VENDOR_ABC',
                    lead_time_days: 3,
                    default_supply_days: 14,
                    minimum_order_amount: 100,
                    payment_terms: 'NET30',
                    notes: 'Good supplier'
                }]
            });
            // UPDATE query
            mockClient.query.mockResolvedValueOnce({});

            const result = await handler.handleVendorUpdated(vendorContext);

            expect(result.vendor).toEqual({
                id: 'VENDOR_ABC',
                name: 'Acme Pet Supplies',
                status: 'ACTIVE'
            });

            const updateCall = mockClient.query.mock.calls[1];
            expect(updateCall[0]).toContain('UPDATE vendors SET');
            expect(updateCall[1]).toContain('Acme Pet Supplies');
            expect(updateCall[1]).toContain('ACTIVE');
            expect(updateCall[1]).toContain('John Doe');
            expect(updateCall[1]).toContain('john@acme.com');
            expect(updateCall[1]).toContain('555-1234');
        });
    });

    describe('existing vendor matched by name with different ID (migration path)', () => {
        it('migrates FK references from old to new vendor ID', async () => {
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 'OLD_VENDOR_ID',
                    lead_time_days: 5,
                    default_supply_days: 21,
                    minimum_order_amount: 200,
                    payment_terms: 'NET60',
                    notes: 'Legacy entry'
                }]
            });
            // Rename old vendor
            mockClient.query.mockResolvedValueOnce({});
            // Insert new vendor
            mockClient.query.mockResolvedValueOnce({});
            // Update variation_vendors
            mockClient.query.mockResolvedValueOnce({});
            // Update purchase_orders
            mockClient.query.mockResolvedValueOnce({});
            // Update vendor_catalog_items
            mockClient.query.mockResolvedValueOnce({});
            // Update bundle_definitions
            mockClient.query.mockResolvedValueOnce({});
            // Update loyalty_offers
            mockClient.query.mockResolvedValueOnce({});
            // Check remaining POs
            mockClient.query.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
            // Delete old vendor
            mockClient.query.mockResolvedValueOnce({});

            const result = await handler.handleVendorCreated(vendorContext);

            expect(result.vendor.id).toBe('VENDOR_ABC');
            expect(logger.info).toHaveBeenCalledWith(
                'Vendor ID change detected, migrating references',
                expect.objectContaining({ oldId: 'OLD_VENDOR_ID', newId: 'VENDOR_ABC' })
            );

            // Verify the new vendor INSERT preserves local-only fields
            const insertCall = mockClient.query.mock.calls[2];
            expect(insertCall[1]).toContain(5);   // lead_time_days
            expect(insertCall[1]).toContain(21);   // default_supply_days
            expect(insertCall[1]).toContain(200);  // minimum_order_amount
            expect(insertCall[1]).toContain('NET60');
            expect(insertCall[1]).toContain('Legacy entry');
        });

        it('handles unmigrated purchase_orders during ID migration', async () => {
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 'OLD_ID',
                    lead_time_days: null,
                    default_supply_days: null,
                    minimum_order_amount: null,
                    payment_terms: null,
                    notes: null
                }]
            });
            // Rename, insert, 5 FK updates
            for (let i = 0; i < 7; i++) mockClient.query.mockResolvedValueOnce({});
            // Remaining POs check — found unmigrated
            mockClient.query.mockResolvedValueOnce({ rows: [{ cnt: '2' }] });
            // Unfiltered PO update
            mockClient.query.mockResolvedValueOnce({});
            // Delete old vendor
            mockClient.query.mockResolvedValueOnce({});

            await handler.handleVendorCreated(vendorContext);

            expect(logger.warn).toHaveBeenCalledWith(
                'Found unmigrated purchase_orders during vendor ID change',
                expect.objectContaining({ count: '2' })
            );
        });
    });

    describe('new vendor INSERT path', () => {
        it('inserts new vendor when no match exists', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // no existing
            mockClient.query.mockResolvedValueOnce({}); // SAVEPOINT
            mockClient.query.mockResolvedValueOnce({}); // INSERT
            mockClient.query.mockResolvedValueOnce({}); // RELEASE SAVEPOINT

            const result = await handler.handleVendorCreated(vendorContext);

            expect(result.vendor).toEqual({
                id: 'VENDOR_ABC',
                name: 'Acme Pet Supplies',
                status: 'ACTIVE'
            });

            const insertCall = mockClient.query.mock.calls[2];
            expect(insertCall[0]).toContain('INSERT INTO vendors');
            expect(insertCall[1]).toContain('VENDOR_ABC');
        });

        it('handles missing contacts gracefully', async () => {
            const noContactContext = {
                ...vendorContext,
                data: {
                    vendor: {
                        id: 'VENDOR_XYZ',
                        name: 'No Contact Vendor',
                        status: 'ACTIVE'
                    }
                }
            };

            mockClient.query.mockResolvedValueOnce({ rows: [] });
            mockClient.query.mockResolvedValueOnce({});
            mockClient.query.mockResolvedValueOnce({});
            mockClient.query.mockResolvedValueOnce({});

            const result = await handler.handleVendorCreated(noContactContext);

            expect(result.vendor.id).toBe('VENDOR_XYZ');
            // Contact fields should be null
            const insertCall = mockClient.query.mock.calls[2];
            expect(insertCall[1]).toContain(null); // contactName
        });
    });

    describe('race condition handling on INSERT constraint violation', () => {
        it('falls back to UPDATE when same vendor ID inserted by concurrent sync', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // no existing
            mockClient.query.mockResolvedValueOnce({}); // SAVEPOINT

            const constraintError = new Error('duplicate key');
            constraintError.constraint = 'idx_vendors_merchant_name_unique';
            mockClient.query.mockRejectedValueOnce(constraintError); // INSERT fails

            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK TO SAVEPOINT
            // Race row lookup — same ID
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 'VENDOR_ABC',
                    lead_time_days: null,
                    default_supply_days: null,
                    minimum_order_amount: null,
                    payment_terms: null,
                    notes: null
                }]
            });
            // UPDATE existing
            mockClient.query.mockResolvedValueOnce({});

            const result = await handler.handleVendorCreated(vendorContext);

            expect(result.vendor.id).toBe('VENDOR_ABC');
            expect(logger.debug).toHaveBeenCalledWith(
                'Vendor insert race condition, reconciling concurrent insert',
                expect.any(Object)
            );
        });

        it('migrates FKs when race row has different ID', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] }); // no existing
            mockClient.query.mockResolvedValueOnce({}); // SAVEPOINT

            const constraintError = new Error('duplicate key');
            constraintError.constraint = 'idx_vendors_merchant_name_unique';
            mockClient.query.mockRejectedValueOnce(constraintError); // INSERT fails

            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK TO SAVEPOINT
            // Race row lookup — different ID
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 'RACE_OLD_ID',
                    lead_time_days: 7,
                    default_supply_days: 28,
                    minimum_order_amount: 500,
                    payment_terms: 'COD',
                    notes: 'From race'
                }]
            });
            // Rename old
            mockClient.query.mockResolvedValueOnce({});
            // Insert new with preserved fields
            mockClient.query.mockResolvedValueOnce({});
            // 5 FK updates
            for (let i = 0; i < 5; i++) mockClient.query.mockResolvedValueOnce({});
            // Remaining POs check
            mockClient.query.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
            // Delete old
            mockClient.query.mockResolvedValueOnce({});

            const result = await handler.handleVendorCreated(vendorContext);

            expect(result.vendor.id).toBe('VENDOR_ABC');
            expect(logger.info).toHaveBeenCalledWith(
                'Vendor ID change detected during race reconciliation, migrating references',
                expect.objectContaining({ oldId: 'RACE_OLD_ID', newId: 'VENDOR_ABC' })
            );
        });

        it('handles unmigrated POs during race reconciliation', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] });
            mockClient.query.mockResolvedValueOnce({});

            const constraintError = new Error('duplicate key');
            constraintError.constraint = 'idx_vendors_merchant_name_unique';
            mockClient.query.mockRejectedValueOnce(constraintError);

            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 'RACE_OLD',
                    lead_time_days: null,
                    default_supply_days: null,
                    minimum_order_amount: null,
                    payment_terms: null,
                    notes: null
                }]
            });
            // Rename, insert, 5 FK updates
            for (let i = 0; i < 7; i++) mockClient.query.mockResolvedValueOnce({});
            // Remaining POs — found some
            mockClient.query.mockResolvedValueOnce({ rows: [{ cnt: '3' }] });
            // Unfiltered PO update
            mockClient.query.mockResolvedValueOnce({});
            // Delete old
            mockClient.query.mockResolvedValueOnce({});

            await handler.handleVendorCreated(vendorContext);

            expect(logger.warn).toHaveBeenCalledWith(
                'Found unmigrated purchase_orders during vendor race reconciliation',
                expect.objectContaining({ count: '3' })
            );
        });

        it('re-throws on non-unique constraint violation', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] });
            mockClient.query.mockResolvedValueOnce({}); // SAVEPOINT

            const otherError = new Error('foreign key violation');
            otherError.constraint = 'fk_some_other';
            mockClient.query.mockRejectedValueOnce(otherError);

            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK

            await expect(handler.handleVendorCreated(vendorContext)).rejects.toThrow('foreign key violation');
        });

        it('re-throws when race lookup finds no rows', async () => {
            mockClient.query.mockResolvedValueOnce({ rows: [] });
            mockClient.query.mockResolvedValueOnce({}); // SAVEPOINT

            const constraintError = new Error('duplicate key');
            constraintError.constraint = 'idx_vendors_merchant_name_unique';
            mockClient.query.mockRejectedValueOnce(constraintError);

            mockClient.query.mockResolvedValueOnce({}); // ROLLBACK
            // Race lookup returns empty — should re-throw
            mockClient.query.mockResolvedValueOnce({ rows: [] });

            await expect(handler.handleVendorCreated(vendorContext)).rejects.toThrow('duplicate key');
        });
    });

    describe('delegation methods', () => {
        it('handleVendorCreated delegates to _handleVendorChange', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleVendorCreated(vendorContext);
            expect(result.skipped).toBe(true);
        });

        it('handleVendorUpdated delegates to _handleVendorChange', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleVendorUpdated(vendorContext);
            expect(result.skipped).toBe(true);
        });
    });
});

// ─── handleLocationCreated / handleLocationUpdated ───────────────────────────

describe('handleLocationCreated / handleLocationUpdated', () => {
    const locationContext = {
        merchantId: 42,
        entityId: 'LOC_ENTITY_ID',
        data: {
            location: {
                id: 'LOC_NESTED_ID',
                name: 'Downtown Store',
                status: 'ACTIVE',
                address: { line1: '123 Main St', city: 'Toronto' },
                timezone: 'America/Toronto',
                phoneNumber: '555-9876',
                businessEmail: 'store@example.com'
            }
        },
        event: { type: 'location.created' }
    };

    describe('guard clauses', () => {
        it('returns skipped when WEBHOOK_CATALOG_SYNC is false', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleLocationCreated(locationContext);

            expect(result.skipped).toBe(true);
            expect(result.handled).toBe(true);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('returns error when merchantId is falsy', async () => {
            const result = await handler.handleLocationUpdated({
                ...locationContext,
                merchantId: undefined
            });

            expect(result.error).toBe('Merchant not found');
        });

        it('returns handled:true when no location in data', async () => {
            const result = await handler.handleLocationCreated({
                merchantId: 42,
                data: {},
                event: { type: 'location.created' },
                entityId: 'some_id'
            });

            expect(result.handled).toBe(true);
            expect(result.location).toBeUndefined();
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    describe('location ID resolution', () => {
        it('uses entityId when available', async () => {
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleLocationCreated(locationContext);

            expect(result.location.id).toBe('LOC_ENTITY_ID');
            const queryArgs = db.query.mock.calls[0][1];
            expect(queryArgs[0]).toBe('LOC_ENTITY_ID'); // id param
            expect(queryArgs[2]).toBe('LOC_ENTITY_ID'); // square_location_id param
        });

        it('falls back to location.id when entityId is absent', async () => {
            db.query.mockResolvedValueOnce({});

            const contextNoEntityId = {
                ...locationContext,
                entityId: undefined
            };
            const result = await handler.handleLocationCreated(contextNoEntityId);

            expect(result.location.id).toBe('LOC_NESTED_ID');
        });
    });

    describe('upsert query', () => {
        it('passes correct parameters to upsert query', async () => {
            db.query.mockResolvedValueOnce({});

            await handler.handleLocationCreated(locationContext);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO locations');
            expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
            expect(params).toEqual([
                'LOC_ENTITY_ID',                                    // id
                'Downtown Store',                                   // name
                'LOC_ENTITY_ID',                                    // square_location_id
                true,                                               // active (ACTIVE => true)
                JSON.stringify({ line1: '123 Main St', city: 'Toronto' }), // address
                'America/Toronto',                                  // timezone
                '555-9876',                                         // phoneNumber
                'store@example.com',                                // businessEmail
                42                                                  // merchantId
            ]);
        });

        it('maps ACTIVE status to true', async () => {
            db.query.mockResolvedValueOnce({});

            await handler.handleLocationCreated(locationContext);

            const params = db.query.mock.calls[0][1];
            expect(params[3]).toBe(true);
        });

        it('maps INACTIVE status to false', async () => {
            db.query.mockResolvedValueOnce({});

            const inactiveContext = {
                ...locationContext,
                data: {
                    location: {
                        ...locationContext.data.location,
                        status: 'INACTIVE'
                    }
                }
            };
            await handler.handleLocationUpdated(inactiveContext);

            const params = db.query.mock.calls[0][1];
            expect(params[3]).toBe(false);
        });

        it('handles null address', async () => {
            db.query.mockResolvedValueOnce({});

            const noAddressContext = {
                ...locationContext,
                data: {
                    location: {
                        ...locationContext.data.location,
                        address: null
                    }
                }
            };
            await handler.handleLocationCreated(noAddressContext);

            const params = db.query.mock.calls[0][1];
            expect(params[4]).toBeNull();
        });

        it('handles missing optional fields', async () => {
            db.query.mockResolvedValueOnce({});

            const minimalContext = {
                merchantId: 42,
                entityId: 'LOC_1',
                data: {
                    location: {
                        id: 'LOC_1',
                        name: 'Minimal Store',
                        status: 'ACTIVE'
                    }
                },
                event: { type: 'location.created' }
            };
            await handler.handleLocationCreated(minimalContext);

            const params = db.query.mock.calls[0][1];
            expect(params[4]).toBeNull(); // address undefined => null
            expect(params[5]).toBeUndefined(); // timezone
            expect(params[6]).toBeNull(); // phoneNumber
            expect(params[7]).toBeNull(); // businessEmail
        });

        it('returns result with location details', async () => {
            db.query.mockResolvedValueOnce({});

            const result = await handler.handleLocationCreated(locationContext);

            expect(result).toEqual({
                handled: true,
                location: {
                    id: 'LOC_ENTITY_ID',
                    name: 'Downtown Store',
                    status: 'ACTIVE'
                }
            });
        });
    });

    describe('delegation methods', () => {
        it('handleLocationCreated delegates to _handleLocationChange', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleLocationCreated(locationContext);
            expect(result.skipped).toBe(true);
        });

        it('handleLocationUpdated delegates to _handleLocationChange', async () => {
            process.env.WEBHOOK_CATALOG_SYNC = 'false';
            const result = await handler.handleLocationUpdated(locationContext);
            expect(result.skipped).toBe(true);
        });
    });
});

// ─── reconcileBundleComponents ───────────────────────────────────────────────

describe('reconcileBundleComponents', () => {
    it('does nothing when no stale components found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await reconcileBundleComponents(42);

        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('bundle_components'),
            [42]
        );
    });

    it('updates stale bundle components with new variation IDs', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    component_id: 100,
                    bundle_id: 10,
                    old_id: 'OLD_VAR_1',
                    child_sku: 'SKU-001',
                    new_id: 'NEW_VAR_1',
                    new_variation_name: 'New Variation',
                    new_item_name: 'New Item'
                },
                {
                    component_id: 101,
                    bundle_id: 10,
                    old_id: 'OLD_VAR_2',
                    child_sku: 'SKU-002',
                    new_id: 'NEW_VAR_2',
                    new_variation_name: 'Another Variation',
                    new_item_name: 'Another Item'
                }
            ]
        });
        // Two update queries
        db.query.mockResolvedValueOnce({});
        db.query.mockResolvedValueOnce({});

        await reconcileBundleComponents(42);

        // 1 stale query + 2 updates = 3 calls
        expect(db.query).toHaveBeenCalledTimes(3);

        // First update
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE bundle_components'),
            ['NEW_VAR_1', 'New Variation', 'New Item', 100]
        );

        // Second update
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE bundle_components'),
            ['NEW_VAR_2', 'Another Variation', 'Another Item', 101]
        );

        // Logs per component
        expect(logger.info).toHaveBeenCalledWith(
            'Bundle component reconciled: replaced deleted variation',
            expect.objectContaining({
                merchantId: 42,
                bundleId: 10,
                oldVariationId: 'OLD_VAR_1',
                newVariationId: 'NEW_VAR_1',
                sku: 'SKU-001'
            })
        );

        // Summary log
        expect(logger.info).toHaveBeenCalledWith(
            'Bundle component reconciliation complete',
            { merchantId: 42, componentsFixed: 2 }
        );
    });

    it('catches and logs errors without throwing', async () => {
        db.query.mockRejectedValueOnce(new Error('DB connection lost'));

        await expect(reconcileBundleComponents(42)).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledWith(
            'Bundle component reconciliation failed',
            { merchantId: 42, error: 'DB connection lost' }
        );
    });

    it('handles error during individual component update', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                component_id: 200,
                bundle_id: 20,
                old_id: 'OLD_V',
                child_sku: 'SKU-X',
                new_id: 'NEW_V',
                new_variation_name: 'V Name',
                new_item_name: 'I Name'
            }]
        });
        db.query.mockRejectedValueOnce(new Error('Update failed'));

        // Should not throw — caught by outer try/catch
        await expect(reconcileBundleComponents(42)).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledWith(
            'Bundle component reconciliation failed',
            expect.objectContaining({ error: 'Update failed' })
        );
    });
});
