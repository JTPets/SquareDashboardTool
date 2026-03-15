/**
 * Tests for InventoryHandler (services/webhook-handlers/inventory-handler.js)
 *
 * Covers all public methods and private method behavior tested through
 * public entry points:
 * - handleInventoryCountUpdated
 * - handleInvoiceChanged (+ _upsertInvoiceCommitment, _processOrderForCommitment)
 * - handleInvoiceClosed (+ _removeInvoiceCommitment)
 * - _rebuildReservedForSaleAggregate (tested through invoice flows)
 * - _fetchInvoice (tested through handleInvoiceChanged when order_id missing)
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
    syncInventory: jest.fn()
}));

const mockSquareClient = {
    orders: { get: jest.fn() },
    invoices: { get: jest.fn() }
};
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient)
}));

const db = require('../../../utils/database');
const squareApi = require('../../../services/square');
const { getSquareClientForMerchant } = require('../../../middleware/merchant');
const InventoryHandler = require('../../../services/webhook-handlers/inventory-handler');

let handler;
let mockSyncQueue;
let mockClient;

const originalEnv = process.env.WEBHOOK_INVENTORY_SYNC;

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WEBHOOK_INVENTORY_SYNC;

    mockSyncQueue = {
        executeWithQueue: jest.fn()
    };
    handler = new InventoryHandler(mockSyncQueue);

    mockClient = { query: jest.fn() };
    db.transaction.mockImplementation(async (fn) => fn(mockClient));
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterAll(() => {
    if (originalEnv !== undefined) {
        process.env.WEBHOOK_INVENTORY_SYNC = originalEnv;
    } else {
        delete process.env.WEBHOOK_INVENTORY_SYNC;
    }
});

// ---------------------------------------------------------------------------
// handleInventoryCountUpdated
// ---------------------------------------------------------------------------
describe('handleInventoryCountUpdated', () => {
    const baseContext = {
        data: {
            inventory_count: {
                catalog_object_id: 'VAR_123',
                quantity: '5',
                location_id: 'LOC_1'
            }
        },
        merchantId: 1
    };

    test('skips when WEBHOOK_INVENTORY_SYNC is false', async () => {
        process.env.WEBHOOK_INVENTORY_SYNC = 'false';

        const result = await handler.handleInventoryCountUpdated(baseContext);

        expect(result.handled).toBe(true);
        expect(result.skipped).toBe(true);
        expect(mockSyncQueue.executeWithQueue).not.toHaveBeenCalled();
    });

    test('returns error when no merchantId', async () => {
        const result = await handler.handleInventoryCountUpdated({
            data: { inventory_count: {} },
            merchantId: null
        });

        expect(result.error).toBe('Merchant not found');
        expect(mockSyncQueue.executeWithQueue).not.toHaveBeenCalled();
    });

    test('calls syncQueue.executeWithQueue with inventory key and merchantId', async () => {
        mockSyncQueue.executeWithQueue.mockResolvedValue({ result: 42 });

        await handler.handleInventoryCountUpdated(baseContext);

        expect(mockSyncQueue.executeWithQueue).toHaveBeenCalledWith(
            'inventory',
            1,
            expect.any(Function)
        );
    });

    test('queued callback calls syncInventory', async () => {
        mockSyncQueue.executeWithQueue.mockImplementation(async (key, id, fn) => {
            await fn();
            return { result: 10 };
        });
        squareApi.syncInventory.mockResolvedValue(10);

        await handler.handleInventoryCountUpdated(baseContext);

        expect(squareApi.syncInventory).toHaveBeenCalledWith(1);
    });

    test('returns queued result when sync is queued', async () => {
        mockSyncQueue.executeWithQueue.mockResolvedValue({ queued: true });

        const result = await handler.handleInventoryCountUpdated(baseContext);

        expect(result.queued).toBe(true);
        expect(result.inventory).toBeUndefined();
    });

    test('returns error result when sync fails', async () => {
        mockSyncQueue.executeWithQueue.mockResolvedValue({ error: 'Sync failed' });

        const result = await handler.handleInventoryCountUpdated(baseContext);

        expect(result.error).toBe('Sync failed');
        expect(result.inventory).toBeUndefined();
    });

    test('returns inventory count on success', async () => {
        mockSyncQueue.executeWithQueue.mockResolvedValue({ result: 42 });

        const result = await handler.handleInventoryCountUpdated(baseContext);

        expect(result.inventory).toEqual({
            count: 42,
            catalogObjectId: 'VAR_123'
        });
        expect(logger.info).toHaveBeenCalledWith(
            'Inventory sync completed via webhook',
            { count: 42 }
        );
    });

    test('proceeds when WEBHOOK_INVENTORY_SYNC is not set', async () => {
        mockSyncQueue.executeWithQueue.mockResolvedValue({ result: 5 });

        const result = await handler.handleInventoryCountUpdated(baseContext);

        expect(result.skipped).toBeUndefined();
        expect(result.inventory).toBeDefined();
    });

    test('handles missing inventory_count data gracefully', async () => {
        mockSyncQueue.executeWithQueue.mockResolvedValue({ result: 3 });

        const result = await handler.handleInventoryCountUpdated({
            data: {},
            merchantId: 1
        });

        expect(result.inventory).toEqual({
            count: 3,
            catalogObjectId: undefined
        });
    });
});

// ---------------------------------------------------------------------------
// handleInvoiceChanged
// ---------------------------------------------------------------------------
describe('handleInvoiceChanged', () => {
    test('returns error when no merchantId', async () => {
        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT' } },
            merchantId: null,
            entityId: 'inv_1'
        });

        expect(result.error).toBe('Merchant not found');
    });

    test('skips when no invoiceId from entityId or invoice.id', async () => {
        const result = await handler.handleInvoiceChanged({
            data: {},
            merchantId: 1,
            entityId: null
        });

        expect(result.skipped).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(
            'Invoice webhook missing invoice ID',
            { merchantId: 1 }
        );
    });

    test('uses entityId as invoiceId when available', async () => {
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });

        await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_data', status: 'PAID' } },
            merchantId: 1,
            entityId: 'inv_entity'
        });

        // PAID is terminal, so _removeInvoiceCommitment is called with entityId
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM committed_inventory'),
            [1, 'inv_entity']
        );
    });

    test('falls back to invoice.id when entityId is missing', async () => {
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });

        await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_fallback', status: 'CANCELED' } },
            merchantId: 1,
            entityId: null
        });

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM committed_inventory'),
            [1, 'inv_fallback']
        );
    });

    describe('terminal statuses', () => {
        test.each(['PAID', 'CANCELED', 'REFUNDED'])(
            'calls _removeInvoiceCommitment for %s status',
            async (status) => {
                db.query.mockResolvedValue({ rowCount: 2, rows: [] });

                const result = await handler.handleInvoiceChanged({
                    data: { invoice: { id: 'inv_1', status } },
                    merchantId: 1,
                    entityId: 'inv_1'
                });

                expect(result.handled).toBe(true);
                expect(result.committedInventory).toEqual({
                    invoiceId: 'inv_1',
                    status,
                    rowsRemoved: 2
                });
            }
        );
    });

    describe('open statuses', () => {
        test.each(['DRAFT', 'UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'])(
            'calls _upsertInvoiceCommitment for %s status',
            async (status) => {
                const order = {
                    order: {
                        lineItems: [
                            { catalogObjectId: 'VAR_1', quantity: '3' }
                        ],
                        locationId: 'LOC_1'
                    }
                };
                mockSquareClient.orders.get.mockResolvedValue(order);
                mockClient.query
                    .mockResolvedValueOnce() // DELETE old rows
                    .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known variations
                    .mockResolvedValueOnce(); // INSERT

                const result = await handler.handleInvoiceChanged({
                    data: {
                        invoice: {
                            id: 'inv_1',
                            status,
                            order_id: 'order_1'
                        }
                    },
                    merchantId: 1,
                    entityId: 'inv_1'
                });

                expect(result.handled).toBe(true);
                expect(result.committedInventory).toBeDefined();
                expect(result.committedInventory.lineItemsTracked).toBe(1);
            }
        );
    });

    test('skips for unknown status', async () => {
        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'SOME_NEW_STATUS' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.skipped).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            'Invoice status not actionable for committed inventory',
            expect.objectContaining({ status: 'SOME_NEW_STATUS' })
        );
    });
});

// ---------------------------------------------------------------------------
// handleInvoiceClosed
// ---------------------------------------------------------------------------
describe('handleInvoiceClosed', () => {
    test('returns error when no merchantId', async () => {
        const result = await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1' } },
            merchantId: null,
            entityId: 'inv_1'
        });

        expect(result.error).toBe('Merchant not found');
    });

    test('skips when no invoiceId', async () => {
        const result = await handler.handleInvoiceClosed({
            data: {},
            merchantId: 1,
            entityId: null
        });

        expect(result.skipped).toBe(true);
    });

    test('calls _removeInvoiceCommitment with status from invoice', async () => {
        db.query.mockResolvedValue({ rowCount: 3, rows: [] });

        const result = await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1', status: 'CANCELED' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory).toEqual({
            invoiceId: 'inv_1',
            status: 'CANCELED',
            rowsRemoved: 3
        });
    });

    test('defaults status to CANCELED when invoice has no status', async () => {
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });

        const result = await handler.handleInvoiceClosed({
            data: {},
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.status).toBe('CANCELED');
    });

    test('uses entityId over invoice.id', async () => {
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });

        await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_data', status: 'DELETED' } },
            merchantId: 1,
            entityId: 'inv_entity'
        });

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM committed_inventory'),
            [1, 'inv_entity']
        );
    });
});

// ---------------------------------------------------------------------------
// _upsertInvoiceCommitment (tested through handleInvoiceChanged)
// ---------------------------------------------------------------------------
describe('_upsertInvoiceCommitment (via handleInvoiceChanged)', () => {
    test('processes directly when invoice has order_id', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{ catalogObjectId: 'VAR_1', quantity: '2' }],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known variations
            .mockResolvedValueOnce(); // INSERT

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_1' });
        expect(mockSquareClient.invoices.get).not.toHaveBeenCalled();
        expect(result.committedInventory.orderId).toBe('order_1');
    });

    test('fetches invoice from Square when no order_id in webhook data', async () => {
        mockSquareClient.invoices.get.mockResolvedValue({
            invoice: { id: 'inv_1', order_id: 'order_fetched', status: 'UNPAID' }
        });
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{ catalogObjectId: 'VAR_1', quantity: '1' }],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known
            .mockResolvedValueOnce(); // INSERT

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'UNPAID' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(mockSquareClient.invoices.get).toHaveBeenCalledWith({ invoiceId: 'inv_1' });
        expect(result.committedInventory.orderId).toBe('order_fetched');
    });

    test('skips when fetched invoice has no order_id', async () => {
        mockSquareClient.invoices.get.mockResolvedValue({
            invoice: { id: 'inv_1', status: 'DRAFT' }
        });

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.skipped).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(
            'Invoice has no order_id, skipping committed inventory',
            expect.objectContaining({ invoiceId: 'inv_1' })
        );
    });

    test('returns error when invoice fetch fails and order_id missing', async () => {
        // When order_id is missing, _fetchInvoice is called. If it returns null
        // (due to Square error), the result is skipped with a warning.
        mockSquareClient.invoices.get.mockResolvedValueOnce({ invoice: null });

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.skipped).toBe(true);
        expect(result.handled).toBe(true);
    });

    test('uses fetched invoice status when processing via _fetchInvoice path', async () => {
        // When invoice has no order_id, _fetchInvoice is called, and the
        // fetched invoice's status is passed to _processOrderForCommitment
        mockSquareClient.invoices.get.mockResolvedValueOnce({
            invoice: { id: 'inv_1', order_id: 'order_fetched', status: 'SCHEDULED' }
        });
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{ catalogObjectId: 'VAR_1', quantity: '1' }],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known
            .mockResolvedValueOnce(); // INSERT

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'UNPAID' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        // The INSERT should use the fetched status (SCHEDULED), not the webhook status (UNPAID)
        expect(mockClient.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO committed_inventory'),
            expect.arrayContaining([1, 'inv_1', 'order_fetched', 'VAR_1', 'LOC_1', 1, 'SCHEDULED'])
        );
    });
    test('catches _processOrderForCommitment rejection via try/catch (return await fix)', async () => {
        // Verifies the return-await fix: errors from _processOrderForCommitment
        // are now caught by _upsertInvoiceCommitment's try/catch instead of
        // propagating uncaught to the caller.
        mockSquareClient.orders.get.mockRejectedValueOnce(new Error('Square API down'));

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.error).toBe('Square API down');
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to upsert invoice commitment',
            expect.objectContaining({ error: 'Square API down' })
        );
    });
});

// ---------------------------------------------------------------------------
// _processOrderForCommitment (tested through handleInvoiceChanged)
// ---------------------------------------------------------------------------
describe('_processOrderForCommitment (via handleInvoiceChanged)', () => {
    const invoiceContext = (orderMock) => {
        mockSquareClient.orders.get.mockResolvedValue(orderMock);
        return {
            data: { invoice: { id: 'inv_1', status: 'UNPAID', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        };
    };

    test('skips when order not found', async () => {
        const result = await handler.handleInvoiceChanged(
            invoiceContext({ order: null })
        );

        expect(result.skipped).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(
            'Order not found for invoice commitment',
            expect.objectContaining({ orderId: 'order_1' })
        );
    });

    test('skips when order has no line items', async () => {
        const result = await handler.handleInvoiceChanged(
            invoiceContext({ order: { lineItems: [], locationId: 'LOC_1' } })
        );

        expect(result.skipped).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            'Invoice order has no line items',
            expect.objectContaining({ orderId: 'order_1' })
        );
    });

    test('handles line_items snake_case property', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                line_items: [{ catalog_object_id: 'VAR_1', quantity: '2' }],
                location_id: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known
            .mockResolvedValueOnce(); // INSERT

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'UNPAID', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.lineItemsTracked).toBe(1);
    });

    test('deletes old committed_inventory and inserts line items in transaction', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [
                    { catalogObjectId: 'VAR_1', quantity: '3' },
                    { catalogObjectId: 'VAR_2', quantity: '1' }
                ],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }, { id: 'VAR_2' }] }) // known
            .mockResolvedValueOnce() // INSERT VAR_1
            .mockResolvedValueOnce(); // INSERT VAR_2

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.lineItemsTracked).toBe(2);

        // Verify DELETE was called first
        expect(mockClient.query).toHaveBeenNthCalledWith(1,
            'DELETE FROM committed_inventory WHERE merchant_id = $1 AND square_invoice_id = $2',
            [1, 'inv_1']
        );

        // Verify variation lookup
        expect(mockClient.query).toHaveBeenNthCalledWith(2,
            'SELECT id FROM variations WHERE id = ANY($1) AND merchant_id = $2',
            [['VAR_1', 'VAR_2'], 1]
        );

        // Verify INSERT calls contain correct data
        expect(mockClient.query).toHaveBeenNthCalledWith(3,
            expect.stringContaining('INSERT INTO committed_inventory'),
            [1, 'inv_1', 'order_1', 'VAR_1', 'LOC_1', 3, 'DRAFT']
        );
        expect(mockClient.query).toHaveBeenNthCalledWith(4,
            expect.stringContaining('INSERT INTO committed_inventory'),
            [1, 'inv_1', 'order_1', 'VAR_2', 'LOC_1', 1, 'DRAFT']
        );
    });

    test('skips orphan variations not in local catalog', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [
                    { catalogObjectId: 'VAR_KNOWN', quantity: '2' },
                    { catalogObjectId: 'VAR_ORPHAN', quantity: '1' }
                ],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_KNOWN' }] }) // only VAR_KNOWN
            .mockResolvedValueOnce(); // INSERT VAR_KNOWN only

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'UNPAID', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.lineItemsTracked).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('not in local catalog'),
            expect.objectContaining({ skippedVariationIds: ['VAR_ORPHAN'] })
        );
    });

    test('skips line items with no catalogObjectId', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [
                    { catalogObjectId: 'VAR_1', quantity: '1' },
                    { quantity: '2' } // no catalog ID (ad-hoc item)
                ],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known
            .mockResolvedValueOnce(); // INSERT

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.lineItemsTracked).toBe(1);
    });

    test('skips line items with zero or negative quantity', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [
                    { catalogObjectId: 'VAR_1', quantity: '0' },
                    { catalogObjectId: 'VAR_2', quantity: '-1' },
                    { catalogObjectId: 'VAR_3', quantity: '5' }
                ],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_3' }] }) // only VAR_3 checked (0 and -1 filtered before)
            .mockResolvedValueOnce(); // INSERT VAR_3

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.lineItemsTracked).toBe(1);
    });

    test('rebuilds RESERVED_FOR_SALE aggregate after successful upsert', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{ catalogObjectId: 'VAR_1', quantity: '1' }],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce() // DELETE committed
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] }) // known
            .mockResolvedValueOnce() // INSERT
            .mockResolvedValueOnce() // DELETE RESERVED_FOR_SALE (rebuild transaction)
            .mockResolvedValueOnce(); // INSERT aggregated (rebuild transaction)

        await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT', order_id: 'order_1' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        // db.transaction called twice: once for upsert, once for rebuild
        expect(db.transaction).toHaveBeenCalledTimes(2);

        // Orphan check query after rebuild
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('committed_inventory ci'),
            [1]
        );
    });
});

// ---------------------------------------------------------------------------
// _removeInvoiceCommitment (tested through handleInvoiceChanged/handleInvoiceClosed)
// ---------------------------------------------------------------------------
describe('_removeInvoiceCommitment', () => {
    test('deletes committed_inventory rows and rebuilds aggregate', async () => {
        db.query
            .mockResolvedValueOnce({ rowCount: 2, rows: [] }) // DELETE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // orphan check

        const result = await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1', status: 'CANCELED' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.committedInventory.rowsRemoved).toBe(2);
        expect(db.transaction).toHaveBeenCalledTimes(1); // rebuild aggregate
        expect(logger.info).toHaveBeenCalledWith(
            'Invoice commitment removed',
            expect.objectContaining({ rowsRemoved: 2 })
        );
    });

    test('catches and returns error on failure', async () => {
        db.query.mockRejectedValue(new Error('DB connection lost'));

        const result = await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1', status: 'CANCELED' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(result.error).toBe('DB connection lost');
        expect(result.handled).toBe(true);
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to remove invoice commitment',
            expect.objectContaining({ error: 'DB connection lost' })
        );
    });
});

// ---------------------------------------------------------------------------
// _rebuildReservedForSaleAggregate
// ---------------------------------------------------------------------------
describe('_rebuildReservedForSaleAggregate', () => {
    test('runs DELETE and INSERT in transaction then checks orphans', async () => {
        // Setup: _removeInvoiceCommitment will call _rebuildReservedForSaleAggregate
        db.query
            .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // DELETE committed_inventory
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // orphan check

        mockClient.query
            .mockResolvedValueOnce() // DELETE RESERVED_FOR_SALE
            .mockResolvedValueOnce(); // INSERT aggregated

        await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1', status: 'PAID' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        // Transaction callback called with client
        expect(mockClient.query).toHaveBeenCalledWith(
            expect.stringContaining("DELETE FROM inventory_counts WHERE state = 'RESERVED_FOR_SALE'"),
            [1]
        );
        expect(mockClient.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO inventory_counts'),
            [1]
        );

        expect(logger.debug).toHaveBeenCalledWith(
            'RESERVED_FOR_SALE aggregate rebuilt from committed_inventory',
            { merchantId: 1 }
        );
    });

    test('logs warning when orphan variations found', async () => {
        db.query
            .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // DELETE committed_inventory
            .mockResolvedValueOnce({ // orphan check
                rows: [
                    { catalog_object_id: 'VAR_ORPHAN_1', square_invoice_id: 'inv_A' },
                    { catalog_object_id: 'VAR_ORPHAN_2', square_invoice_id: 'inv_B' }
                ],
                rowCount: 2
            });

        await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1', status: 'PAID' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('2 variation(s) not in local catalog'),
            expect.objectContaining({
                merchantId: 1,
                orphanVariationIds: ['VAR_ORPHAN_1', 'VAR_ORPHAN_2'],
                invoiceIds: ['inv_A', 'inv_B']
            })
        );
    });

    test('does not log orphan warning when no orphans exist', async () => {
        db.query
            .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // DELETE
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // orphan check — empty

        await handler.handleInvoiceClosed({
            data: { invoice: { id: 'inv_1', status: 'CANCELED' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        // Should NOT have the orphan warning
        const orphanWarns = logger.warn.mock.calls.filter(
            call => typeof call[0] === 'string' && call[0].includes('not in local catalog')
        );
        expect(orphanWarns).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// _fetchInvoice
// ---------------------------------------------------------------------------
describe('_fetchInvoice (via handleInvoiceChanged)', () => {
    test('returns invoice from Square API', async () => {
        mockSquareClient.invoices.get.mockResolvedValue({
            invoice: { id: 'inv_1', order_id: 'order_1', status: 'UNPAID' }
        });
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{ catalogObjectId: 'VAR_1', quantity: '1' }],
                locationId: 'LOC_1'
            }
        });
        mockClient.query
            .mockResolvedValueOnce()
            .mockResolvedValueOnce({ rows: [{ id: 'VAR_1' }] })
            .mockResolvedValueOnce();

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'UNPAID' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        expect(getSquareClientForMerchant).toHaveBeenCalledWith(1);
        expect(mockSquareClient.invoices.get).toHaveBeenCalledWith({ invoiceId: 'inv_1' });
        expect(result.committedInventory).toBeDefined();
    });

    test('returns null on Square API error and propagates as upsert error', async () => {
        mockSquareClient.invoices.get.mockRejectedValue(new Error('Not found'));

        const result = await handler.handleInvoiceChanged({
            data: { invoice: { id: 'inv_1', status: 'DRAFT' } },
            merchantId: 1,
            entityId: 'inv_1'
        });

        // _fetchInvoice catches and returns null, then skipped because no order_id
        expect(result.skipped).toBe(true);
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to fetch invoice from Square',
            expect.objectContaining({ error: 'Not found' })
        );
    });
});
