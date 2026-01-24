/**
 * Tests for vendor catalog utility functions
 */

// Mock modules BEFORE requiring the module under test
jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const db = require('../../utils/database');
const { regeneratePriceReport } = require('../../utils/vendor-catalog');

describe('vendor-catalog', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('regeneratePriceReport', () => {
        const merchantId = 1;
        const batchId = 'IMPORT-20250124-abc123';

        it('should throw error when merchantId is not provided', async () => {
            await expect(regeneratePriceReport(batchId, null))
                .rejects.toThrow('merchantId is required');
        });

        it('should return error when batch not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await regeneratePriceReport(batchId, merchantId);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Batch not found or no items');
        });

        it('should return report with price updates for matched items', async () => {
            const mockBatchData = [
                {
                    vendor_id: 'VENDOR123',
                    vendor_name: 'Test Vendor',
                    import_name: 'Q1 2025 Price List',
                    imported_at: new Date('2025-01-15'),
                    vendor_item_number: 'SKU001',
                    product_name: 'Test Product 1',
                    brand: 'TestBrand',
                    upc: '123456789012',
                    vendor_cost_cents: 500,
                    vendor_srp_cents: 1099,
                    matched_variation_id: 'VAR123',
                    match_method: 'upc',
                    our_sku: 'OUR-SKU-001',
                    variation_name: 'Test Variation',
                    our_price_cents: 999,
                    item_name: 'Test Item'
                },
                {
                    vendor_id: 'VENDOR123',
                    vendor_name: 'Test Vendor',
                    import_name: 'Q1 2025 Price List',
                    imported_at: new Date('2025-01-15'),
                    vendor_item_number: 'SKU002',
                    product_name: 'Test Product 2',
                    brand: null,
                    upc: '123456789013',
                    vendor_cost_cents: 300,
                    vendor_srp_cents: 599,
                    matched_variation_id: 'VAR456',
                    match_method: 'upc',
                    our_sku: 'OUR-SKU-002',
                    variation_name: 'Test Variation 2',
                    our_price_cents: 699,
                    item_name: 'Test Item 2'
                }
            ];

            db.query.mockResolvedValueOnce({ rows: mockBatchData });

            const result = await regeneratePriceReport(batchId, merchantId);

            expect(result.success).toBe(true);
            expect(result.batchId).toBe(batchId);
            expect(result.vendorName).toBe('Test Vendor');
            expect(result.importName).toBe('Q1 2025 Price List');
            expect(result.totalItems).toBe(2);
            expect(result.matchedItems).toBe(2);
            expect(result.priceUpdates).toHaveLength(2);

            // First item: $9.99 -> $10.99 = +10% increase
            const firstUpdate = result.priceUpdates.find(p => p.our_sku === 'OUR-SKU-001');
            expect(firstUpdate.price_diff_cents).toBe(100);
            expect(firstUpdate.action).toBe('price_increase');
            expect(firstUpdate.matched_variation_id).toBe('VAR123');

            // Second item: $6.99 -> $5.99 = -14.3% decrease
            const secondUpdate = result.priceUpdates.find(p => p.our_sku === 'OUR-SKU-002');
            expect(secondUpdate.price_diff_cents).toBe(-100);
            expect(secondUpdate.action).toBe('price_decrease');

            // Summary should be correct
            expect(result.summary.total).toBe(2);
            expect(result.summary.increases).toBe(1);
            expect(result.summary.decreases).toBe(1);
        });

        it('should filter out price differences less than 1%', async () => {
            const mockBatchData = [
                {
                    vendor_id: 'VENDOR123',
                    vendor_name: 'Test Vendor',
                    import_name: 'Test Import',
                    imported_at: new Date(),
                    vendor_item_number: 'SKU001',
                    product_name: 'Test Product',
                    brand: null,
                    upc: '123456789012',
                    vendor_cost_cents: 500,
                    vendor_srp_cents: 1000, // Same as our price
                    matched_variation_id: 'VAR123',
                    match_method: 'upc',
                    our_sku: 'OUR-SKU-001',
                    variation_name: 'Test Variation',
                    our_price_cents: 1000,
                    item_name: 'Test Item'
                },
                {
                    vendor_id: 'VENDOR123',
                    vendor_name: 'Test Vendor',
                    import_name: 'Test Import',
                    imported_at: new Date(),
                    vendor_item_number: 'SKU002',
                    product_name: 'Test Product 2',
                    brand: null,
                    upc: '123456789013',
                    vendor_cost_cents: 500,
                    vendor_srp_cents: 1005, // Only 0.5% higher
                    matched_variation_id: 'VAR456',
                    match_method: 'upc',
                    our_sku: 'OUR-SKU-002',
                    variation_name: 'Test Variation 2',
                    our_price_cents: 1000,
                    item_name: 'Test Item 2'
                }
            ];

            db.query.mockResolvedValueOnce({ rows: mockBatchData });

            const result = await regeneratePriceReport(batchId, merchantId);

            expect(result.success).toBe(true);
            expect(result.priceUpdates).toHaveLength(0);
            expect(result.summary.total).toBe(0);
        });

        it('should skip unmatched items', async () => {
            const mockBatchData = [
                {
                    vendor_id: 'VENDOR123',
                    vendor_name: 'Test Vendor',
                    import_name: 'Test Import',
                    imported_at: new Date(),
                    vendor_item_number: 'SKU001',
                    product_name: 'Unmatched Product',
                    brand: null,
                    upc: null,
                    vendor_cost_cents: 500,
                    vendor_srp_cents: 1099,
                    matched_variation_id: null, // Not matched
                    match_method: null,
                    our_sku: null,
                    variation_name: null,
                    our_price_cents: null,
                    item_name: null
                }
            ];

            db.query.mockResolvedValueOnce({ rows: mockBatchData });

            const result = await regeneratePriceReport(batchId, merchantId);

            expect(result.success).toBe(true);
            expect(result.totalItems).toBe(1);
            expect(result.matchedItems).toBe(0);
            expect(result.priceUpdates).toHaveLength(0);
        });

        it('should query with correct merchant isolation', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await regeneratePriceReport(batchId, merchantId);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE vci.import_batch_id = $1 AND vci.merchant_id = $2'),
                [batchId, merchantId]
            );
        });

        it('should include all required fields in price update', async () => {
            const mockBatchData = [
                {
                    vendor_id: 'VENDOR123',
                    vendor_name: 'Test Vendor',
                    import_name: 'Test Import',
                    imported_at: new Date(),
                    vendor_item_number: 'SKU001',
                    product_name: 'Test Product',
                    brand: 'TestBrand',
                    upc: '123456789012',
                    vendor_cost_cents: 500,
                    vendor_srp_cents: 1500,
                    matched_variation_id: 'VAR123',
                    match_method: 'upc',
                    our_sku: 'OUR-SKU-001',
                    variation_name: 'Test Variation',
                    our_price_cents: 1000,
                    item_name: 'Test Item'
                }
            ];

            db.query.mockResolvedValueOnce({ rows: mockBatchData });

            const result = await regeneratePriceReport(batchId, merchantId);
            const update = result.priceUpdates[0];

            expect(update).toHaveProperty('vendor_item_number', 'SKU001');
            expect(update).toHaveProperty('product_name', 'Test Product');
            expect(update).toHaveProperty('brand', 'TestBrand');
            expect(update).toHaveProperty('upc', '123456789012');
            expect(update).toHaveProperty('our_sku', 'OUR-SKU-001');
            expect(update).toHaveProperty('our_item_name', 'Test Item');
            expect(update).toHaveProperty('our_price_cents', 1000);
            expect(update).toHaveProperty('vendor_srp_cents', 1500);
            expect(update).toHaveProperty('vendor_cost_cents', 500);
            expect(update).toHaveProperty('price_diff_cents', 500);
            expect(update).toHaveProperty('price_diff_percent');
            expect(update).toHaveProperty('match_method', 'upc');
            expect(update).toHaveProperty('action', 'price_increase');
            expect(update).toHaveProperty('matched_variation_id', 'VAR123');
        });
    });
});
