jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    logAuthEvent: jest.fn().mockResolvedValue(),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
    loadMerchantContext: (req, res, next) => next(),
    getSquareClientForMerchant: jest.fn(),
    requireMerchantRole: () => (req, res, next) => next(),
}));
jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));
jest.mock('../../utils/csv-helpers', () => ({
    escapeCSVField: jest.fn(v => v),
    formatDateForSquare: jest.fn(v => '01/01/2026'),
    formatMoney: jest.fn(v => `$${(v / 100).toFixed(2)}`),
    formatGTIN: jest.fn(v => v || ''),
    UTF8_BOM: '\uFEFF',
}));
jest.mock('../../services/expiry/discount-service', () => ({
    clearExpiryDiscountForReorder: jest.fn().mockResolvedValue({ cleared: false }),
    applyDiscounts: jest.fn().mockResolvedValue(),
}));
jest.mock('../../middleware/validators/purchase-orders', () => ({
    createPurchaseOrder: [(req, res, next) => next()],
    listPurchaseOrders: [(req, res, next) => next()],
    getPurchaseOrder: [(req, res, next) => next()],
    updatePurchaseOrder: [(req, res, next) => next()],
    submitPurchaseOrder: [(req, res, next) => next()],
    receivePurchaseOrder: [(req, res, next) => next()],
    deletePurchaseOrder: [(req, res, next) => next()],
    exportPurchaseOrderCsv: [(req, res, next) => next()],
    exportPurchaseOrderXlsx: [(req, res, next) => next()],
}));
jest.mock('exceljs', () => {
    const mockWorksheet = {
        getCell: jest.fn(() => ({ value: null, numFmt: null })),
        addWorksheet: jest.fn(),
        getRow: jest.fn(() => ({ values: [], font: null, getCell: jest.fn(() => ({ numFmt: null })) })),
        columns: null,
    };
    const mockWorkbook = {
        addWorksheet: jest.fn(() => mockWorksheet),
        xlsx: { writeBuffer: jest.fn().mockResolvedValue(Buffer.from('test')) },
    };
    return { Workbook: jest.fn(() => mockWorkbook) };
});

const request = require('supertest');
const express = require('express');
const db = require('../../utils/database');
const discountService = require('../../services/expiry/discount-service');

let app;

function buildApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = { user: { id: 1, role: 'admin' } };
        req.merchantContext = { id: 10, square_merchant_id: 'sq-merchant-1' };
        next();
    });
    const routes = require('../../routes/purchase-orders');
    a.use('/api/purchase-orders', routes);
    // Error handler so asyncHandler errors return proper JSON
    a.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
    });
    return a;
}

function buildUnauthApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = {};
        next();
    });
    const routes = require('../../routes/purchase-orders');
    a.use('/api/purchase-orders', routes);
    return a;
}

function buildNoMerchantApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = { user: { id: 1, role: 'admin' } };
        next();
    });
    const routes = require('../../routes/purchase-orders');
    a.use('/api/purchase-orders', routes);
    return a;
}

const samplePO = {
    id: 1,
    po_number: 'PO-20260315-001',
    merchant_id: 10,
    vendor_id: 5,
    location_id: 'loc-1',
    status: 'DRAFT',
    notes: 'Test PO',
    vendor_name: 'Test Vendor',
    location_name: 'Main Store',
    lead_time_days: 7,
    created_at: '2026-03-15T00:00:00Z',
    updated_at: '2026-03-15T00:00:00Z',
};

const sampleItems = [
    { id: 1, purchase_order_id: 1, variation_id: 'var-1', item_name: 'Dog Food', variation_name: 'Large', sku: 'DF-L', quantity_ordered: 10, unit_cost_cents: 1500, gtin: '1234567890' },
    { id: 2, purchase_order_id: 1, variation_id: 'var-2', item_name: 'Cat Food', variation_name: 'Small', sku: 'CF-S', quantity_ordered: 5, unit_cost_cents: 800, gtin: '' },
];

beforeEach(() => {
    jest.resetAllMocks();
    // Re-apply default for discount service
    discountService.clearExpiryDiscountForReorder.mockResolvedValue({ cleared: false });
    discountService.applyDiscounts.mockResolvedValue();
    app = buildApp();
});

describe('Purchase Orders Routes', () => {
    describe('Authentication and Merchant Guards', () => {
        test('returns 401 when not authenticated', async () => {
            const unauthApp = buildUnauthApp();
            const res = await request(unauthApp).get('/api/purchase-orders');
            expect(res.status).toBe(401);
        });

        test('returns 400 when merchant context missing', async () => {
            const noMerchantApp = buildNoMerchantApp();
            const res = await request(noMerchantApp).get('/api/purchase-orders');
            expect(res.status).toBe(400);
        });
    });

    describe('POST / - Create Purchase Order', () => {
        const createPayload = {
            vendor_id: 5,
            location_id: 'loc-1',
            notes: 'Test PO',
            items: [
                { variation_id: 'var-1', quantity_ordered: 10, unit_cost_cents: 1500 },
                { variation_id: 'var-2', quantity_ordered: 5, unit_cost_cents: 800 },
            ],
        };

        test('creates PO successfully', async () => {
            // vendor check
            db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
            // location check
            db.query.mockResolvedValueOnce({ rows: [{ id: 'loc-1' }] });
            // count for PO number
            db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

            db.transaction.mockImplementation(async (fn) => {
                const client = { query: jest.fn() };
                client.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-20260315-001', status: 'DRAFT', vendor_id: 5, location_id: 'loc-1', notes: 'Test PO', created_at: '2026-03-15' }] });
                client.query.mockResolvedValueOnce({ rows: [] });
                return fn(client);
            });

            // expiry status check (variation_discount_status query after transaction)
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/purchase-orders')
                .send(createPayload);

            expect(res.status).toBe(201);
            expect(db.transaction).toHaveBeenCalled();
        });

        test('filters zero quantity items', async () => {
            const payloadWithZero = {
                ...createPayload,
                items: [
                    ...createPayload.items,
                    { variation_id: 'var-3', quantity_ordered: 0, unit_cost_cents: 500 },
                ],
            };

            db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
            db.query.mockResolvedValueOnce({ rows: [{ id: 'loc-1' }] });
            db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

            db.transaction.mockImplementation(async (fn) => {
                const client = { query: jest.fn() };
                client.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-20260315-001', status: 'DRAFT' }] });
                client.query.mockResolvedValueOnce({ rows: [] });
                return fn(client);
            });

            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/purchase-orders')
                .send(payloadWithZero);

            expect(res.status).toBe(201);
        });

        test('returns 403 when vendor not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/purchase-orders')
                .send(createPayload);

            expect(res.status).toBe(403);
        });

        test('returns 403 when location not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/purchase-orders')
                .send(createPayload);

            expect(res.status).toBe(403);
        });

        test('checks expiry discounts after PO creation', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
            db.query.mockResolvedValueOnce({ rows: [{ id: 'loc-1' }] });
            db.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });

            db.transaction.mockImplementation(async (fn) => {
                const client = { query: jest.fn() };
                client.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-20260315-003', status: 'DRAFT' }] });
                client.query.mockResolvedValueOnce({ rows: [] });
                return fn(client);
            });

            // expiry status query returns a variation with active discount
            db.query.mockResolvedValueOnce({ rows: [{ variation_id: 'var-1', tier_code: 'AUTO50', is_auto_apply: true, item_name: 'Dog Food', variation_name: 'Large' }] });

            const res = await request(app)
                .post('/api/purchase-orders')
                .send(createPayload);

            expect(res.status).toBe(201);
        });
    });

    describe('GET / - List Purchase Orders', () => {
        test('lists POs successfully', async () => {
            db.query.mockResolvedValueOnce({ rows: [samplePO] });

            const res = await request(app).get('/api/purchase-orders');

            expect(res.status).toBe(200);
            expect(res.body).toBeDefined();
        });

        test('lists POs with status filter', async () => {
            db.query.mockResolvedValueOnce({ rows: [samplePO] });

            const res = await request(app).get('/api/purchase-orders?status=DRAFT');

            expect(res.status).toBe(200);
            expect(db.query).toHaveBeenCalled();
        });

        test('lists POs with vendor_id filter', async () => {
            db.query.mockResolvedValueOnce({ rows: [samplePO] });

            const res = await request(app).get('/api/purchase-orders?vendor_id=5');

            expect(res.status).toBe(200);
            expect(db.query).toHaveBeenCalled();
        });
    });

    describe('GET /:id - Get Purchase Order', () => {
        test('returns PO with items', async () => {
            // PO header query
            db.query.mockResolvedValueOnce({ rows: [samplePO] });
            // PO items query
            db.query.mockResolvedValueOnce({ rows: sampleItems });

            const res = await request(app).get('/api/purchase-orders/1');

            expect(res.status).toBe(200);
        });

        test('returns 404 when PO not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/purchase-orders/999');

            expect(res.status).toBe(404);
        });
    });

    describe('PATCH /:id - Update Purchase Order', () => {
        test('updates draft PO successfully', async () => {
            // status check query
            db.query.mockResolvedValueOnce({ rows: [{ status: 'DRAFT' }] });

            db.transaction.mockImplementation(async (fn) => {
                const client = { query: jest.fn() };
                // update PO header
                client.query.mockResolvedValueOnce({ rows: [{ ...samplePO, notes: 'Updated' }] });
                // delete existing items
                client.query.mockResolvedValueOnce({ rows: [] });
                // insert items (one per item)
                client.query.mockResolvedValue({ rows: [] });
                return fn(client);
            });

            // final SELECT to return updated PO
            db.query.mockResolvedValueOnce({ rows: [{ ...samplePO, notes: 'Updated' }] });

            const res = await request(app)
                .patch('/api/purchase-orders/1')
                .send({ notes: 'Updated', items: [{ variation_id: 'var-1', quantity_ordered: 10, unit_cost_cents: 1500, notes: '' }] });

            expect(res.status).toBe(200);
        });

        test('returns 404 when PO not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .patch('/api/purchase-orders/999')
                .send({ notes: 'Updated' });

            expect(res.status).toBe(404);
        });

        test('returns 400 when PO is not DRAFT', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ status: 'SUBMITTED' }] });

            const res = await request(app)
                .patch('/api/purchase-orders/1')
                .send({ notes: 'Updated' });

            expect(res.status).toBe(400);
        });
    });

    describe('POST /:id/submit - Submit Purchase Order', () => {
        test('submits draft PO successfully', async () => {
            // The submit route does a single UPDATE...WHERE status = 'DRAFT' RETURNING *
            db.query.mockResolvedValueOnce({ rows: [{ ...samplePO, status: 'SUBMITTED' }] });

            const res = await request(app).post('/api/purchase-orders/1/submit');

            expect(res.status).toBe(200);
        });

        test('returns 400 when PO is not DRAFT', async () => {
            // UPDATE with WHERE status = 'DRAFT' returns no rows when PO isn't draft
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).post('/api/purchase-orders/1/submit');

            expect(res.status).toBe(400);
        });

        test('returns 400 when PO not found for submit', async () => {
            // UPDATE with WHERE id = $1 returns no rows when PO doesn't exist
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).post('/api/purchase-orders/999/submit');

            // Route returns 400 with "not found or not in DRAFT status" for both cases
            expect(res.status).toBe(400);
        });
    });

    describe('POST /:id/receive - Receive Purchase Order', () => {
        test('records received quantities successfully', async () => {
            // poCheck query
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

            db.transaction.mockImplementation(async (fn) => {
                const client = { query: jest.fn() };
                // update received quantities (2 items)
                client.query.mockResolvedValueOnce({ rows: [] });
                client.query.mockResolvedValueOnce({ rows: [] });
                // check if all items received
                client.query.mockResolvedValueOnce({ rows: [{ total: '2', received: '2' }] });
                // update PO status to RECEIVED
                client.query.mockResolvedValueOnce({ rows: [] });
                return fn(client);
            });

            // final SELECT to return updated PO
            db.query.mockResolvedValueOnce({ rows: [{ ...samplePO, status: 'RECEIVED' }] });

            const res = await request(app)
                .post('/api/purchase-orders/1/receive')
                .send({ items: [{ id: 1, received_quantity: 10 }, { id: 2, received_quantity: 5 }] });

            expect(res.status).toBe(200);
        });

        test('returns 404 when PO not found for receive', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/purchase-orders/999/receive')
                .send({ items: [{ id: 1, received_quantity: 10 }] });

            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /:id - Delete Purchase Order', () => {
        test('deletes draft PO successfully', async () => {
            // poCheck query (SELECT id, po_number, status)
            db.query.mockResolvedValueOnce({ rows: [samplePO] });
            // DELETE query
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).delete('/api/purchase-orders/1');

            expect(res.status).toBe(200);
        });

        test('returns 404 when PO not found for delete', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).delete('/api/purchase-orders/999');

            expect(res.status).toBe(404);
        });

        test('returns 400 when deleting non-DRAFT PO', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ ...samplePO, status: 'SUBMITTED' }] });

            const res = await request(app).delete('/api/purchase-orders/1');

            expect(res.status).toBe(400);
        });
    });

    describe('GET /:po_number/export-csv - Export CSV', () => {
        test('exports CSV successfully', async () => {
            // PO header query
            db.query.mockResolvedValueOnce({ rows: [samplePO] });
            // PO items query
            db.query.mockResolvedValueOnce({ rows: sampleItems });

            const res = await request(app).get('/api/purchase-orders/PO-20260315-001/export-csv');

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/csv/);
        });

        test('returns 404 when PO not found for CSV export', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/purchase-orders/PO-INVALID/export-csv');

            expect(res.status).toBe(404);
        });
    });

    describe('GET /:po_number/export-xlsx - Export XLSX', () => {
        test('exports XLSX successfully', async () => {
            // PO header query
            db.query.mockResolvedValueOnce({ rows: [samplePO] });
            // PO items query
            db.query.mockResolvedValueOnce({ rows: sampleItems });

            const res = await request(app).get('/api/purchase-orders/PO-20260315-001/export-xlsx');

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/spreadsheetml|octet-stream/);
        });

        test('returns 404 when PO not found for XLSX export', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/purchase-orders/PO-INVALID/export-xlsx');

            expect(res.status).toBe(404);
        });
    });
});
