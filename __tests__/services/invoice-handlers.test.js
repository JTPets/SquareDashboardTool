/**
 * Tests for invoice webhook handlers (BACKLOG-10)
 *
 * Tests the inventory handler's invoice-related methods:
 * - handleInvoiceChanged (invoice.created/updated/published/refunded/scheduled_charge_failed)
 * - handleInvoiceClosed (invoice.canceled/deleted)
 * - Aggregate rebuild logic
 */

// Override global database mock to include transaction
jest.mock('../../utils/database', () => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    transaction: jest.fn(),
    getClient: jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
    }),
    pool: { end: jest.fn().mockResolvedValue() }
}));

jest.mock('../../utils/square-api', () => ({
    syncInventory: jest.fn().mockResolvedValue({ counts: 50 }),
    syncCommittedInventory: jest.fn().mockResolvedValue({ synced: true })
}));

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn()
}));

const db = require('../../utils/database');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const InventoryHandler = require('../../services/webhook-handlers/inventory-handler');
const syncQueue = require('../../services/sync-queue');

// Create handler instance with real sync queue
const inventoryHandler = new InventoryHandler(syncQueue);

// Helper to create mock Square client
function mockSquareClient(order) {
    getSquareClientForMerchant.mockResolvedValue({
        orders: {
            get: jest.fn().mockResolvedValue({ order })
        },
        invoices: {
            get: jest.fn().mockResolvedValue({
                invoice: { id: 'inv-1', order_id: 'order-1', status: 'UNPAID' }
            })
        }
    });
}

describe('InventoryHandler - Invoice Handlers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: transaction mock that executes callback
        db.transaction.mockImplementation(async (fn) => {
            const mockClient = {
                query: jest.fn().mockImplementation((sql, params) => {
                    // Return queried variation IDs as known for orphan filter
                    if (sql.includes('SELECT id FROM variations WHERE id = ANY')) {
                        const ids = Array.isArray(params && params[0]) ? params[0] : [];
                        return { rows: ids.map(id => ({ id })), rowCount: ids.length };
                    }
                    return { rows: [], rowCount: 0 };
                })
            };
            return fn(mockClient);
        });
        // Default: query mock
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    describe('handleInvoiceChanged', () => {
        it('should return error when merchantId is missing', async () => {
            const context = {
                data: { invoice: { id: 'inv-1', status: 'UNPAID' } },
                merchantId: null,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.error).toBe('Merchant not found');
        });

        it('should skip when invoice ID is missing', async () => {
            const context = {
                data: {},
                merchantId: 1,
                entityId: null
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.skipped).toBe(true);
        });

        it('should upsert commitment for UNPAID invoice', async () => {
            const mockOrder = {
                id: 'order-1',
                location_id: 'loc-1',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '3' },
                    { catalog_object_id: 'var-2', quantity: '5' }
                ]
            };
            mockSquareClient(mockOrder);

            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'UNPAID',
                        order_id: 'order-1'
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.handled).toBe(true);
            expect(result.committedInventory).toBeDefined();
            expect(result.committedInventory.invoiceId).toBe('inv-1');
            expect(result.committedInventory.lineItemsTracked).toBe(2);
            // Verify transaction was used
            expect(db.transaction).toHaveBeenCalled();
        });

        it('should upsert commitment for DRAFT invoice', async () => {
            const mockOrder = {
                id: 'order-1',
                locationId: 'loc-1',
                lineItems: [
                    { catalogObjectId: 'var-1', quantity: '2' }
                ]
            };
            mockSquareClient(mockOrder);

            const context = {
                data: {
                    invoice: {
                        id: 'inv-2',
                        status: 'DRAFT',
                        order_id: 'order-1'
                    }
                },
                merchantId: 1,
                entityId: 'inv-2'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.handled).toBe(true);
            expect(result.committedInventory.status).toBe('DRAFT');
        });

        it('should remove commitment for PAID invoice', async () => {
            db.query.mockResolvedValue({ rowCount: 2 });

            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'PAID'
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.handled).toBe(true);
            expect(result.committedInventory.status).toBe('PAID');
            expect(result.committedInventory.rowsRemoved).toBe(2);
            // Should DELETE from committed_inventory
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM committed_inventory'),
                [1, 'inv-1']
            );
        });

        it('should remove commitment for REFUNDED invoice', async () => {
            db.query.mockResolvedValue({ rowCount: 1 });

            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'REFUNDED'
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.committedInventory.status).toBe('REFUNDED');
            expect(result.committedInventory.rowsRemoved).toBe(1);
        });

        it('should skip unknown invoice statuses', async () => {
            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'UNKNOWN_STATUS'
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.skipped).toBe(true);
        });

        it('should fetch invoice when order_id is missing from webhook', async () => {
            const mockOrder = {
                id: 'order-1',
                location_id: 'loc-1',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '1' }
                ]
            };
            mockSquareClient(mockOrder);

            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'UNPAID'
                        // no order_id
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.handled).toBe(true);
            // Should have fetched the invoice to get order_id
            const squareClient = await getSquareClientForMerchant(1);
            expect(squareClient.invoices.get).toHaveBeenCalled();
        });

        it('should skip line items without catalog_object_id', async () => {
            const mockOrder = {
                id: 'order-1',
                location_id: 'loc-1',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '3' },
                    { name: 'Custom item', quantity: '1' },  // No catalog_object_id
                    { catalog_object_id: 'var-2', quantity: '0' }  // Zero quantity
                ]
            };
            mockSquareClient(mockOrder);

            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'UNPAID',
                        order_id: 'order-1'
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            // Only var-1 should be tracked (var-2 has 0 quantity, custom has no ID)
            expect(result.committedInventory.lineItemsTracked).toBe(1);
        });

        it('should handle PARTIALLY_PAID status', async () => {
            const mockOrder = {
                id: 'order-1',
                location_id: 'loc-1',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2' }
                ]
            };
            mockSquareClient(mockOrder);

            const context = {
                data: {
                    invoice: {
                        id: 'inv-1',
                        status: 'PARTIALLY_PAID',
                        order_id: 'order-1'
                    }
                },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.committedInventory.status).toBe('PARTIALLY_PAID');
            expect(result.committedInventory.lineItemsTracked).toBe(1);
        });

        it('should use entityId as invoice ID when data.invoice.id is missing', async () => {
            db.query.mockResolvedValue({ rowCount: 0 });

            const context = {
                data: { invoice: { status: 'CANCELED' } },
                merchantId: 1,
                entityId: 'inv-from-entity'
            };

            const result = await inventoryHandler.handleInvoiceChanged(context);

            expect(result.committedInventory.invoiceId).toBe('inv-from-entity');
        });
    });

    describe('handleInvoiceClosed', () => {
        it('should return error when merchantId is missing', async () => {
            const context = {
                data: { invoice: { id: 'inv-1' } },
                merchantId: null,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceClosed(context);

            expect(result.error).toBe('Merchant not found');
        });

        it('should remove commitment rows for canceled invoice', async () => {
            db.query.mockResolvedValue({ rowCount: 3 });

            const context = {
                data: { invoice: { id: 'inv-1', status: 'CANCELED' } },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceClosed(context);

            expect(result.handled).toBe(true);
            expect(result.committedInventory.rowsRemoved).toBe(3);
            expect(result.committedInventory.status).toBe('CANCELED');
        });

        it('should remove commitment rows for deleted invoice', async () => {
            db.query.mockResolvedValue({ rowCount: 1 });

            const context = {
                data: { invoice: { id: 'inv-1', status: 'DELETED' } },
                merchantId: 1,
                entityId: 'inv-1'
            };

            const result = await inventoryHandler.handleInvoiceClosed(context);

            expect(result.committedInventory.rowsRemoved).toBe(1);
        });

        it('should handle invoice with no existing committed rows', async () => {
            db.query.mockResolvedValue({ rowCount: 0 });

            const context = {
                data: { invoice: { id: 'inv-new', status: 'CANCELED' } },
                merchantId: 1,
                entityId: 'inv-new'
            };

            const result = await inventoryHandler.handleInvoiceClosed(context);

            expect(result.committedInventory.rowsRemoved).toBe(0);
        });

        it('should rebuild aggregate after removing commitment', async () => {
            db.query.mockResolvedValue({ rowCount: 1 });

            const context = {
                data: { invoice: { id: 'inv-1', status: 'CANCELED' } },
                merchantId: 1,
                entityId: 'inv-1'
            };

            await inventoryHandler.handleInvoiceClosed(context);

            // Should have called transaction for aggregate rebuild
            expect(db.transaction).toHaveBeenCalled();
        });
    });

    describe('aggregate rebuild', () => {
        it('should delete RESERVED_FOR_SALE and rebuild from committed_inventory', async () => {
            const transactionCalls = [];
            db.transaction.mockImplementation(async (fn) => {
                const mockClient = {
                    query: jest.fn().mockImplementation((...args) => {
                        transactionCalls.push(args[0]);
                        return { rows: [], rowCount: 0 };
                    })
                };
                return fn(mockClient);
            });

            db.query.mockResolvedValue({ rowCount: 1 });

            const context = {
                data: { invoice: { id: 'inv-1', status: 'CANCELED' } },
                merchantId: 1,
                entityId: 'inv-1'
            };

            await inventoryHandler.handleInvoiceClosed(context);

            // Verify the aggregate rebuild queries
            const deleteQuery = transactionCalls.find(q =>
                q.includes('DELETE FROM inventory_counts') && q.includes('RESERVED_FOR_SALE')
            );
            const insertQuery = transactionCalls.find(q =>
                q.includes('INSERT INTO inventory_counts') && q.includes('committed_inventory')
            );

            expect(deleteQuery).toBeDefined();
            expect(insertQuery).toBeDefined();
        });
    });
});
