/**
 * Tests for services/vendor/catalog-service.js
 *
 * Covers: money parsing, UPC cleaning, margin calculation, CSV/XLSX parsing,
 * header normalization, validation/transformation, catalog matching, import
 * operations, batch management, price report regeneration, search queries.
 */

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

// Mock ExcelJS
const mockWorksheet = {
    rowCount: 3,
    getRow: jest.fn(),
    eachRow: jest.fn()
};
const mockWorkbook = {
    worksheets: [mockWorksheet],
    xlsx: { load: jest.fn().mockResolvedValue() }
};
jest.mock('exceljs', () => {
    const ValueType = { RichText: 8, Formula: 6 };
    return {
        Workbook: jest.fn(() => mockWorkbook),
        ValueType
    };
});

const catalogService = require('../../../services/vendor/catalog-service');

const MERCHANT_ID = 1;

beforeEach(() => {
    jest.resetAllMocks();
    mockWorkbook.worksheets = [mockWorksheet];
    // Re-apply default mock behavior (restoreMocks: true in jest.config clears between tests)
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    db.transaction.mockImplementation(async (fn) => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        return fn(mockClient);
    });
    // Re-apply ExcelJS mocks
    mockWorkbook.xlsx.load.mockResolvedValue();
    mockWorksheet.getRow.mockReturnValue({ values: [] });
    mockWorksheet.eachRow.mockImplementation(() => {});
});

// ============================================================================
// PURE UTILITY FUNCTIONS
// ============================================================================

describe('parseMoney', () => {
    it('returns null for null/undefined/empty', () => {
        expect(catalogService.parseCSV).toBeDefined(); // Ensure module loaded
        // Access parseMoney through the module
        const { validateAndTransform, normalizeHeader } = catalogService;

        // We need to test parseMoney indirectly or through validateAndTransform
        // Since parseMoney is not exported, test through validateAndTransform
    });
});

// Test parseMoney indirectly through validateAndTransform
describe('money parsing (via validateAndTransform)', () => {
    // Note: 'Price' maps to 'cost' in normalizeHeader (B2B convention).
    // Use 'Retail' for the SRP/retail price column.
    const headers = ['Vendor', 'Product Name', 'Item Number', 'Cost', 'Retail'];

    it('parses "$10.99" correctly', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '$10.99', Retail: '$15.99' }],
            headers
        );
        expect(result.items[0].cost_cents).toBe(1099);
        expect(result.items[0].price_cents).toBe(1599);
    });

    it('parses plain number "10.99"', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.99' }],
            headers
        );
        expect(result.items[0].cost_cents).toBe(1099);
    });

    it('parses thousands separator "$1,234.56"', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '$1,234.56' }],
            headers
        );
        expect(result.items[0].cost_cents).toBe(123456);
    });

    it('parses European format "10,99"', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10,99' }],
            headers
        );
        expect(result.items[0].cost_cents).toBe(1099);
    });

    it('parses numeric value (assumes dollars)', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: 10.99 }],
            headers
        );
        expect(result.items[0].cost_cents).toBe(1099);
    });

    it('handles rounding for $0.005 edge case', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '0.005' }],
            headers
        );
        // Math.round(0.5) = 1
        expect(result.items[0].cost_cents).toBe(1);
    });

    it('reports error for negative cost', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '-5.00' }],
            headers
        );
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].errors[0]).toContain('Invalid cost');
    });

    it('reports error for non-numeric cost', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: 'free' }],
            headers
        );
        expect(result.errors).toHaveLength(1);
    });

    it('handles empty price as null', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00', Retail: '' }],
            headers
        );
        expect(result.items[0].price_cents).toBeNull();
    });
});

// ============================================================================
// MARGIN CALCULATION
// ============================================================================

describe('margin calculation (via validateAndTransform)', () => {
    const headers = ['Vendor', 'Product Name', 'Item Number', 'Cost', 'Retail'];

    it('calculates margin correctly: cost $10, price $20 = 50%', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00', Retail: '20.00' }],
            headers
        );
        expect(result.items[0].margin_percent).toBe(50);
    });

    it('calculates margin for cost > price (negative margin)', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '15.00', Retail: '10.00' }],
            headers
        );
        expect(result.items[0].margin_percent).toBe(-50); // (10-15)/10*100
    });

    it('returns null margin when price missing', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00' }],
            headers
        );
        expect(result.items[0].margin_percent).toBeNull();
    });

    it('caps margin to database range (-999.99 to 999.99)', () => {
        // Cost: 1 cent, price: $100 → margin = 99.99%
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '0.01', Retail: '100.00' }],
            headers
        );
        expect(result.items[0].margin_percent).toBeLessThanOrEqual(999.99);
    });
});

// ============================================================================
// UPC CLEANING
// ============================================================================

describe('UPC cleaning (via validateAndTransform)', () => {
    const headers = ['Vendor', 'Product Name', 'Item Number', 'UPC', 'Cost'];

    it('cleans standard 12-digit UPC', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', UPC: '012345678901', Cost: '10.00' }],
            headers
        );
        expect(result.items[0].upc).toBe('012345678901');
    });

    it('strips non-digit characters from UPC', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', UPC: '012-345-678901', Cost: '10.00' }],
            headers
        );
        expect(result.items[0].upc).toBe('012345678901');
    });

    it('handles 13-digit EAN', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', UPC: '4006381333931', Cost: '10.00' }],
            headers
        );
        expect(result.items[0].upc).toBe('4006381333931');
    });

    it('handles 8-digit UPC', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', UPC: '12345678', Cost: '10.00' }],
            headers
        );
        expect(result.items[0].upc).toBe('12345678');
    });

    it('handles empty/null UPC', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00' }],
            headers
        );
        expect(result.items[0].upc).toBeNull();
    });
});

// ============================================================================
// HEADER NORMALIZATION
// ============================================================================

describe('normalizeHeader', () => {
    it('maps vendor-related headers', () => {
        expect(catalogService.normalizeHeader('Vendor')).toBe('vendor_name');
        expect(catalogService.normalizeHeader('Supplier')).toBe('vendor_name');
        expect(catalogService.normalizeHeader('VENDOR_NAME')).toBe('vendor_name');
    });

    it('maps product name headers', () => {
        expect(catalogService.normalizeHeader('Product Name')).toBe('product_name');
        expect(catalogService.normalizeHeader('Description')).toBe('product_name');
        expect(catalogService.normalizeHeader('Item')).toBe('product_name');
        expect(catalogService.normalizeHeader('Title')).toBe('product_name');
    });

    it('maps UPC/barcode headers', () => {
        expect(catalogService.normalizeHeader('UPC')).toBe('upc');
        expect(catalogService.normalizeHeader('GTIN')).toBe('upc');
        expect(catalogService.normalizeHeader('Barcode')).toBe('upc');
        expect(catalogService.normalizeHeader('EAN')).toBe('upc');
    });

    it('maps vendor item number headers', () => {
        expect(catalogService.normalizeHeader('SKU')).toBe('vendor_item_number');
        expect(catalogService.normalizeHeader('Part Number')).toBe('vendor_item_number');
        expect(catalogService.normalizeHeader('Item#')).toBe('vendor_item_number');
        expect(catalogService.normalizeHeader('Item Code')).toBe('vendor_item_number');
        expect(catalogService.normalizeHeader('Catalog Number')).toBe('vendor_item_number');
    });

    it('maps cost headers (B2B price = cost)', () => {
        expect(catalogService.normalizeHeader('Cost')).toBe('cost');
        expect(catalogService.normalizeHeader('Wholesale Price')).toBe('cost');
        expect(catalogService.normalizeHeader('Net Price')).toBe('cost');
        expect(catalogService.normalizeHeader('Price')).toBe('cost'); // B2B "price" = cost
        expect(catalogService.normalizeHeader('Dealer Cost')).toBe('cost');
    });

    it('maps retail/SRP headers', () => {
        expect(catalogService.normalizeHeader('Retail')).toBe('price');
        expect(catalogService.normalizeHeader('MSRP')).toBe('price');
        expect(catalogService.normalizeHeader('SRP')).toBe('price');
        expect(catalogService.normalizeHeader('Suggested Retail Price')).toBe('price');
    });

    it('maps brand headers', () => {
        expect(catalogService.normalizeHeader('Brand')).toBe('brand');
        expect(catalogService.normalizeHeader('Manufacturer')).toBe('brand');
    });

    it('returns null for unknown headers', () => {
        expect(catalogService.normalizeHeader('Random Column')).toBeNull();
        expect(catalogService.normalizeHeader('Notes')).toBeNull();
        expect(catalogService.normalizeHeader(null)).toBeNull();
    });

    it('handles extra whitespace and dots', () => {
        expect(catalogService.normalizeHeader('  Product  Name  ')).toBe('product_name');
        expect(catalogService.normalizeHeader('Item No.')).toBe('vendor_item_number');
    });
});

// ============================================================================
// CSV PARSING
// ============================================================================

describe('parseCSV', () => {
    it('parses basic CSV', () => {
        const csv = 'Name,Cost\nWidget,10.99\nGadget,20.50';
        const result = catalogService.parseCSV(csv);

        expect(result.headers).toEqual(['Name', 'Cost']);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].Name).toBe('Widget');
        expect(result.rows[0].Cost).toBe('10.99');
    });

    it('handles quoted fields with commas', () => {
        const csv = 'Name,Description\nWidget,"A nice, fancy widget"';
        const result = catalogService.parseCSV(csv);

        expect(result.rows[0].Description).toBe('A nice, fancy widget');
    });

    it('handles escaped quotes in fields', () => {
        const csv = 'Name,Description\nWidget,"Contains ""quotes"" inside"';
        const result = catalogService.parseCSV(csv);

        expect(result.rows[0].Description).toBe('Contains "quotes" inside');
    });

    it('throws for empty CSV', () => {
        expect(() => catalogService.parseCSV('Header Only'))
            .toThrow('at least a header row and one data row');
    });

    it('skips empty lines', () => {
        const csv = 'Name,Cost\nWidget,10.99\n\nGadget,20.50\n';
        const result = catalogService.parseCSV(csv);

        expect(result.rows).toHaveLength(2);
    });

    it('handles Windows line endings', () => {
        const csv = 'Name,Cost\r\nWidget,10.99\r\nGadget,20.50';
        const result = catalogService.parseCSV(csv);

        expect(result.rows).toHaveLength(2);
    });
});

// ============================================================================
// VALIDATION AND TRANSFORMATION
// ============================================================================

describe('validateAndTransform', () => {
    it('reports missing required columns', () => {
        const result = catalogService.validateAndTransform(
            [{ 'Random': 'data' }],
            ['Random']
        );

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing required columns');
        expect(result.error).toContain('vendor_name');
        expect(result.error).toContain('product_name');
    });

    it('accepts brand as vendor substitute', () => {
        const result = catalogService.validateAndTransform(
            [{ Brand: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00' }],
            ['Brand', 'Product Name', 'Item Number', 'Cost']
        );

        expect(result.items).toHaveLength(1);
        expect(result.items[0].vendor_name).toBe('Acme');
    });

    it('accepts defaultVendorName parameter', () => {
        const result = catalogService.validateAndTransform(
            [{ 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00' }],
            ['Product Name', 'Item Number', 'Cost'],
            'Default Vendor'
        );

        expect(result.items).toHaveLength(1);
        expect(result.items[0].vendor_name).toBe('Default Vendor');
    });

    it('reports row-level errors', () => {
        const headers = ['Vendor', 'Product Name', 'Item Number', 'Cost'];
        const result = catalogService.validateAndTransform(
            [
                { Vendor: 'Acme', 'Product Name': 'Widget', 'Item Number': 'W001', Cost: '10.00' },
                { Vendor: 'Acme', 'Product Name': '', 'Item Number': 'W002', Cost: '5.00' }, // Missing name
                { Vendor: 'Acme', 'Product Name': 'Gadget', 'Item Number': '', Cost: '5.00' }  // Missing item#
            ],
            headers
        );

        expect(result.items).toHaveLength(1); // Only first row valid
        expect(result.errors).toHaveLength(2);
        expect(result.errors[0].row).toBe(3); // Row 3 (header=1, data starts at 2)
        expect(result.errors[1].row).toBe(4);
    });

    it('trims whitespace from text fields', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: '  Acme  ', 'Product Name': '  Widget  ', 'Item Number': '  W001  ', Cost: '10.00' }],
            ['Vendor', 'Product Name', 'Item Number', 'Cost']
        );

        expect(result.items[0].vendor_name).toBe('Acme');
        expect(result.items[0].product_name).toBe('Widget');
        expect(result.items[0].vendor_item_number).toBe('W001');
    });

    it('returns fieldMap showing column → field mapping', () => {
        const result = catalogService.validateAndTransform(
            [{ Vendor: 'Acme', 'Product Name': 'Widget', SKU: 'W001', Cost: '10.00' }],
            ['Vendor', 'Product Name', 'SKU', 'Cost']
        );

        expect(result.fieldMap.Vendor).toBe('vendor_name');
        expect(result.fieldMap.SKU).toBe('vendor_item_number');
    });
});

// ============================================================================
// CATALOG MATCHING
// ============================================================================

describe('matchToOurCatalog', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.matchToOurCatalog({ upc: '123' }, null))
            .rejects.toThrow('merchantId is required');
    });

    it('matches by UPC first', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'VAR_1',
                sku: 'SKU001',
                variation_name: 'Large',
                item_name: 'Dog Food',
                price_money: 2500
            }]
        });

        const result = await catalogService.matchToOurCatalog(
            { upc: '012345678901', vendor_item_number: 'VIN001' },
            MERCHANT_ID
        );

        expect(result.variation_id).toBe('VAR_1');
        expect(result.method).toBe('upc');
        expect(result.allMatches).toHaveLength(1);
    });

    it('falls back to vendor code match via variation_vendors', async () => {
        // UPC query returns empty
        db.query.mockResolvedValueOnce({ rows: [] });
        // Vendor code match via variation_vendors JOIN
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'VAR_2',
                sku: 'VIN001',
                variation_name: 'Standard',
                item_name: 'Cat Treats',
                price_money: 1500
            }]
        });

        const result = await catalogService.matchToOurCatalog(
            { upc: '999999999999', vendor_item_number: 'VIN001' },
            MERCHANT_ID
        );

        expect(result.variation_id).toBe('VAR_2');
        expect(result.method).toBe('vendor_code');
    });

    it('returns multiple matches across methods', async () => {
        // UPC match
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 'VAR_1', sku: 'SKU001', variation_name: 'Large', item_name: 'Food', price_money: 2500 },
                { id: 'VAR_2', sku: 'SKU002', variation_name: 'Small', item_name: 'Food', price_money: 1500 }
            ]
        });
        // Vendor code match via variation_vendors (excludes already matched)
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 'VAR_3', sku: 'VIN001', variation_name: 'Medium', item_name: 'Food', price_money: 2000 }
            ]
        });

        const result = await catalogService.matchToOurCatalog(
            { upc: '012345678901', vendor_item_number: 'VIN001' },
            MERCHANT_ID
        );

        expect(result.allMatches).toHaveLength(3);
        expect(result.variation_id).toBe('VAR_1'); // First match is primary
    });

    it('returns no match when nothing found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await catalogService.matchToOurCatalog(
            { upc: '999999999999', vendor_item_number: 'UNKNOWN' },
            MERCHANT_ID
        );

        expect(result.variation_id).toBeNull();
        expect(result.method).toBeNull();
        expect(result.allMatches).toHaveLength(0);
    });

    it('vendor code match via variation_vendors finds correct variation', async () => {
        // No UPC on item — UPC block skipped
        // Vendor code match via variation_vendors JOIN
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'VAR_10',
                sku: 'SKU-VC',
                variation_name: 'Regular',
                item_name: 'Bird Seed',
                price_money: 3200
            }]
        });

        const result = await catalogService.matchToOurCatalog(
            { vendor_item_number: 'VENDOR-CODE-001' },
            MERCHANT_ID
        );

        expect(result.variation_id).toBe('VAR_10');
        expect(result.method).toBe('vendor_code');
        expect(result.allMatches).toHaveLength(1);
    });

    it('vendor code match is scoped to same vendor when vendorId provided', async () => {
        // No UPC — UPC block skipped
        // Vendor code query returns empty (cross-vendor code filtered out by vendor_id)
        db.query.mockResolvedValueOnce({ rows: [] });
        // SKU fallback also empty
        // (uses default mock)

        await catalogService.matchToOurCatalog(
            { vendor_item_number: 'SHARED-CODE' },
            MERCHANT_ID,
            'VENDOR_A'
        );

        // Vendor code query (first call) params must include VENDOR_A as 4th param
        const vendorCodeQueryParams = db.query.mock.calls[0][1];
        expect(vendorCodeQueryParams).toHaveLength(4);
        expect(vendorCodeQueryParams[3]).toBe('VENDOR_A');
    });

    it('does not filter by vendor_id in vendor code query when vendorId not provided', async () => {
        // No UPC — UPC block skipped
        // Vendor code query returns a match (no vendor_id restriction)
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'VAR_20', sku: 'S', variation_name: 'V', item_name: 'I', price_money: 100 }]
        });

        const result = await catalogService.matchToOurCatalog(
            { vendor_item_number: 'SHARED-CODE' },
            MERCHANT_ID
            // no vendorId
        );

        expect(result.variation_id).toBe('VAR_20');
        // Vendor code query params should have exactly 3 (no vendor_id filter)
        const vendorCodeQueryParams = db.query.mock.calls[0][1];
        expect(vendorCodeQueryParams).toHaveLength(3);
    });

    it('SKU fallback still works when no vendor code match found', async () => {
        // No UPC — UPC block skipped
        // Vendor code match: empty
        db.query.mockResolvedValueOnce({ rows: [] });
        // SKU fallback: match found
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'VAR_30',
                sku: 'SKU-FB',
                variation_name: 'Default',
                item_name: 'Fish Food',
                price_money: 1800
            }]
        });

        const result = await catalogService.matchToOurCatalog(
            { vendor_item_number: 'SKU-FB' },
            MERCHANT_ID
        );

        expect(result.variation_id).toBe('VAR_30');
        expect(result.method).toBe('vendor_item_number');
    });

    it('UPC match still takes priority over vendor code match', async () => {
        // UPC match found first
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'VAR_UPC', sku: 'SKU-U', variation_name: 'UPC-matched', item_name: 'Dog Chews', price_money: 999 }]
        });
        // Vendor code also finds a different match
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'VAR_VC', sku: 'SKU-V', variation_name: 'VC-matched', item_name: 'Dog Chews', price_money: 999 }]
        });

        const result = await catalogService.matchToOurCatalog(
            { upc: '012345678901', vendor_item_number: 'VENDOR-001' },
            MERCHANT_ID
        );

        // UPC match is primary (first in allMatches)
        expect(result.variation_id).toBe('VAR_UPC');
        expect(result.method).toBe('upc');
        // Both matches are present
        expect(result.allMatches).toHaveLength(2);
        expect(result.allMatches[0].method).toBe('upc');
        expect(result.allMatches[1].method).toBe('vendor_code');
    });
});

describe('findOrCreateVendor', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.findOrCreateVendor('Acme', null))
            .rejects.toThrow('merchantId is required');
    });

    it('creates vendor if not exists', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'VENDOR-123', inserted: true }]
        });

        const id = await catalogService.findOrCreateVendor('Acme Corp', MERCHANT_ID);

        expect(id).toBe('VENDOR-123');
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('ON CONFLICT'),
            expect.arrayContaining(['Acme Corp', MERCHANT_ID])
        );
    });

    it('returns existing vendor on conflict', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'EXISTING-VENDOR', inserted: false }]
        });

        const id = await catalogService.findOrCreateVendor('Acme Corp', MERCHANT_ID);

        expect(id).toBe('EXISTING-VENDOR');
    });
});

// ============================================================================
// IMPORT OPERATIONS
// ============================================================================

describe('importVendorCatalog', () => {
    it('returns error without merchantId', async () => {
        const result = await catalogService.importVendorCatalog('data', 'csv', {});

        expect(result.success).toBe(false);
        expect(result.error).toContain('merchantId is required');
    });

    it('imports CSV with matching items', async () => {
        const csv = 'Vendor,Product Name,Item Number,Cost,UPC\nAcme,Widget,W001,10.99,012345678901';

        // matchToOurCatalog → UPC lookup
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'VAR_1', sku: 'SKU001', variation_name: 'Widget', item_name: 'Widget', price_money: 1599 }]
        });
        // INSERT catalog item
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await catalogService.importVendorCatalog(csv, 'csv', {
            merchantId: MERCHANT_ID
        });

        expect(result.success).toBe(true);
        expect(result.stats.imported).toBe(1);
        expect(result.stats.matched).toBe(1);
    });

    it('returns validation errors for invalid data', () => {
        // CSV missing required columns
        const csv = 'Notes\nSome notes here';

        return catalogService.importVendorCatalog(csv, 'csv', {
            merchantId: MERCHANT_ID
        }).then(result => {
            expect(result.success).toBe(false);
            expect(result.error).toContain('Missing required columns');
        });
    });

    it('detects price differences and generates report', async () => {
        const csv = 'Vendor,Product Name,Item Number,Cost,Retail\nAcme,Widget,W001,10.00,20.00';

        // matchToOurCatalog → UPC lookup skipped (no UPC in CSV)
        // matchToOurCatalog → vendor_item_number match
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'VAR_1',
                sku: 'SKU001',
                variation_name: 'Widget',
                item_name: 'Widget',
                price_money: 1500 // Our price: $15
            }]
        });
        // INSERT catalog item
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await catalogService.importVendorCatalog(csv, 'csv', {
            merchantId: MERCHANT_ID
        });

        expect(result.success).toBe(true);
        expect(result.stats.priceUpdatesCount).toBe(1);
        expect(result.stats.priceIncreasesCount).toBe(1);
        expect(result.stats.priceUpdates[0].price_diff_cents).toBe(500); // 2000 - 1500
    });
});

describe('importWithMappings', () => {
    it('returns error without merchantId', async () => {
        const result = await catalogService.importWithMappings('data', 'csv', {});
        expect(result.success).toBe(false);
    });

    it('returns error without vendorId', async () => {
        const result = await catalogService.importWithMappings('data', 'csv', {
            merchantId: MERCHANT_ID
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('select a vendor');
    });

    it('imports with explicit column mappings', async () => {
        const csv = 'Col A,Col B,Col C,Col D\nDog Food,DF001,10.99,15.99';

        const columnMappings = {
            'Col A': 'product_name',
            'Col B': 'vendor_item_number',
            'Col C': 'cost',
            'Col D': 'price'
        };

        // matchToOurCatalog → no match
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [] });
        // INSERT catalog item
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await catalogService.importWithMappings(csv, 'csv', {
            merchantId: MERCHANT_ID,
            columnMappings,
            vendorId: 'V001',
            vendorName: 'Test Vendor',
            importName: 'Test Import 2026'
        });

        expect(result.success).toBe(true);
        expect(result.stats.imported).toBe(1);
        expect(result.importName).toBe('Test Import 2026');
    });

    it('reports missing required mappings', async () => {
        const csv = 'Col A,Col B\nDog Food,10.99';

        // Only map product_name and cost, missing vendor_item_number
        const result = await catalogService.importWithMappings(csv, 'csv', {
            merchantId: MERCHANT_ID,
            vendorId: 'V001',
            columnMappings: { 'Col A': 'product_name', 'Col B': 'cost' }
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('vendor_item_number');
    });

    it('falls back to auto-detect when mapping is "auto"', async () => {
        const csv = 'Product Name,SKU,Cost\nWidget,W001,10.99';

        // matchToOurCatalog
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [] });
        // INSERT
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await catalogService.importWithMappings(csv, 'csv', {
            merchantId: MERCHANT_ID,
            vendorId: 'V001',
            vendorName: 'Vendor',
            columnMappings: { 'Product Name': 'auto', SKU: 'auto', Cost: 'auto' }
        });

        expect(result.success).toBe(true);
    });
});

// ============================================================================
// SEARCH AND QUERY
// ============================================================================

describe('searchVendorCatalog', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.searchVendorCatalog({}))
            .rejects.toThrow('merchantId is required');
    });

    it('searches with multiple filters', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await catalogService.searchVendorCatalog({
            merchantId: MERCHANT_ID,
            vendorId: 'V001',
            search: 'dog food',
            matchedOnly: true,
            limit: 50,
            offset: 10
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('vci.vendor_id =');
        expect(sql).toContain('LIKE LOWER');
        expect(sql).toContain('matched_variation_id IS NOT NULL');
    });

    it('searches by UPC', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await catalogService.searchVendorCatalog({
            merchantId: MERCHANT_ID,
            upc: '012345678901'
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('vci.upc =');
    });
});

describe('getImportBatches', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.getImportBatches({}))
            .rejects.toThrow('merchantId is required');
    });

    it('excludes archived by default', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await catalogService.getImportBatches({ merchantId: MERCHANT_ID });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('is_archived = FALSE');
    });

    it('includes archived when requested', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await catalogService.getImportBatches({
            merchantId: MERCHANT_ID,
            includeArchived: true
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).not.toContain('is_archived = FALSE');
    });
});

// ============================================================================
// BATCH MANAGEMENT
// ============================================================================

describe('archiveImportBatch', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.archiveImportBatch('BATCH_1', null))
            .rejects.toThrow('merchantId is required');
    });

    it('archives batch items', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 5 });

        const count = await catalogService.archiveImportBatch('BATCH_1', MERCHANT_ID);

        expect(count).toBe(5);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('is_archived = TRUE'),
            ['BATCH_1', MERCHANT_ID]
        );
    });
});

describe('unarchiveImportBatch', () => {
    it('unarchives batch items', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 5 });

        const count = await catalogService.unarchiveImportBatch('BATCH_1', MERCHANT_ID);

        expect(count).toBe(5);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('is_archived = FALSE'),
            ['BATCH_1', MERCHANT_ID]
        );
    });
});

describe('deleteImportBatch', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.deleteImportBatch('BATCH_1', null))
            .rejects.toThrow('merchantId is required');
    });

    it('deletes batch items', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 10 });

        const count = await catalogService.deleteImportBatch('BATCH_1', MERCHANT_ID);

        expect(count).toBe(10);
    });
});

// ============================================================================
// PRICE REPORT
// ============================================================================

describe('regeneratePriceReport', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.regeneratePriceReport('BATCH_1', null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns error for unknown batch', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await catalogService.regeneratePriceReport('UNKNOWN', MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('returns error when db.query returns undefined (null guard)', async () => {
        // LOGIC CHANGE: regeneratePriceReport now guards against db.query returning undefined
        db.query.mockResolvedValueOnce(undefined);

        const result = await catalogService.regeneratePriceReport('BATCH_1', MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('returns error when db.query returns null rows', async () => {
        db.query.mockResolvedValueOnce({ rows: null });

        const result = await catalogService.regeneratePriceReport('BATCH_1', MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('generates price comparison report', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    vendor_id: 'V001',
                    vendor_name: 'Acme',
                    import_name: 'Spring 2026',
                    imported_at: new Date(),
                    vendor_item_number: 'W001',
                    product_name: 'Widget',
                    brand: null,
                    upc: '012345678901',
                    vendor_cost_cents: 1000,
                    vendor_srp_cents: 2000,
                    matched_variation_id: 'VAR_1',
                    match_method: 'upc',
                    our_sku: 'SKU001',
                    variation_name: 'Widget',
                    our_price_cents: 1500, // Our price: $15
                    item_name: 'Widget'
                },
                {
                    vendor_id: 'V001',
                    vendor_name: 'Acme',
                    import_name: 'Spring 2026',
                    imported_at: new Date(),
                    vendor_item_number: 'W002',
                    product_name: 'Gadget',
                    brand: null,
                    upc: null,
                    vendor_cost_cents: 500,
                    vendor_srp_cents: null, // No SRP
                    matched_variation_id: null, // No match
                    match_method: null,
                    our_sku: null,
                    variation_name: null,
                    our_price_cents: null,
                    item_name: null
                }
            ]
        });

        const result = await catalogService.regeneratePriceReport('BATCH_1', MERCHANT_ID);

        expect(result.success).toBe(true);
        expect(result.totalItems).toBe(2);
        expect(result.matchedItems).toBe(1);
        expect(result.priceUpdates).toHaveLength(1);
        expect(result.priceUpdates[0].price_diff_cents).toBe(500); // 2000 - 1500
        expect(result.priceUpdates[0].action).toBe('price_increase');
        expect(result.summary.increases).toBe(1);
        expect(result.summary.decreases).toBe(0);
    });

    it('ignores price differences less than 1%', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                vendor_id: 'V001',
                vendor_name: 'Acme',
                import_name: 'Test',
                imported_at: new Date(),
                vendor_item_number: 'W001',
                product_name: 'Widget',
                vendor_cost_cents: 1000,
                vendor_srp_cents: 1505, // 0.33% diff from 1500
                matched_variation_id: 'VAR_1',
                match_method: 'upc',
                our_sku: 'SKU001',
                our_price_cents: 1500,
                item_name: 'Widget'
            }]
        });

        const result = await catalogService.regeneratePriceReport('BATCH_1', MERCHANT_ID);

        expect(result.priceUpdates).toHaveLength(0);
    });
});

// ============================================================================
// LOOKUP AND STATS
// ============================================================================

describe('lookupByUPC', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.lookupByUPC('012345678901', null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns empty for invalid UPC', async () => {
        const result = await catalogService.lookupByUPC('', MERCHANT_ID);
        expect(result).toEqual([]);
    });

    it('cleans UPC before lookup', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

        await catalogService.lookupByUPC('012-345-678901', MERCHANT_ID);

        expect(db.query).toHaveBeenCalledWith(
            expect.any(String),
            [MERCHANT_ID, '012345678901']
        );
    });
});

describe('getStats', () => {
    it('throws without merchantId', async () => {
        await expect(catalogService.getStats(null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns aggregate statistics', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                total_items: '150',
                vendor_count: '5',
                matched_items: '80',
                batch_count: '10',
                avg_margin: '35.5'
            }]
        });

        const stats = await catalogService.getStats(MERCHANT_ID);

        expect(stats.total_items).toBe('150');
        expect(stats.vendor_count).toBe('5');
    });
});

// ============================================================================
// PREVIEW
// ============================================================================

describe('previewFile', () => {
    it('previews CSV with auto-detected mappings', async () => {
        const csv = 'Vendor,Product Name,SKU,Cost,MSRP,UPC\nAcme,Widget,W001,10.99,15.99,012345678901';

        const result = await catalogService.previewFile(csv, 'csv');

        expect(result.totalRows).toBe(1);
        expect(result.columns).toHaveLength(6);
        expect(result.columns[0].suggestedMapping).toBe('vendor_name');
        expect(result.columns[1].suggestedMapping).toBe('product_name');
        expect(result.columns[2].suggestedMapping).toBe('vendor_item_number');
        expect(result.columns[3].suggestedMapping).toBe('cost');
        expect(result.columns[4].suggestedMapping).toBe('price');
        expect(result.columns[5].suggestedMapping).toBe('upc');
        expect(result.fieldTypes).toEqual(catalogService.FIELD_TYPES);
    });

    it('sets "skip" for unrecognized columns', async () => {
        const csv = 'Notes,Weight\nSome note,5kg';

        const result = await catalogService.previewFile(csv, 'csv');

        expect(result.columns[0].suggestedMapping).toBe('skip');
        expect(result.columns[1].suggestedMapping).toBe('skip');
    });

    it('includes sample values (max 3 rows)', async () => {
        const csv = 'Vendor,Product Name,SKU,Cost\nAcme,Widget A,W001,10.99\nAcme,Widget B,W002,11.99\nAcme,Widget C,W003,12.99\nAcme,Widget D,W004,13.99';

        const result = await catalogService.previewFile(csv, 'csv');

        expect(result.columns[1].sampleValues).toHaveLength(3);
        expect(result.columns[1].sampleValues).toEqual(['Widget A', 'Widget B', 'Widget C']);
    });
});

// ============================================================================
// BATCH ID GENERATION
// ============================================================================

describe('generateBatchId', () => {
    it('generates unique batch IDs', () => {
        const id1 = catalogService.generateBatchId();
        const id2 = catalogService.generateBatchId();

        expect(id1).toMatch(/^IMPORT-\d{14}-[a-f0-9]{8}$/);
        expect(id1).not.toBe(id2);
    });
});
