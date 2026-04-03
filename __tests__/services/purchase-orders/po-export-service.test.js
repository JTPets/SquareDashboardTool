jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../../../utils/database');
const { getPurchaseOrderForExport, buildCsvContent, buildXlsxWorkbook } = require('../../../services/purchase-orders/po-export-service');

beforeEach(() => jest.clearAllMocks());

// ─── Test fixtures ────────────────────────────────────────────────────────────

const samplePo = {
    id: 1,
    po_number: 'PO-20260403-001',
    vendor_id: 5,
    vendor_name: 'Best Pets Wholesale',
    lead_time_days: 7,
    location_name: 'Main Store',
    location_address: '123 Main St',
    notes: 'Rush order',
    expected_delivery_date: '2026-04-10T00:00:00Z',
};

const sampleItems = [
    { item_name: 'Dog Food', variation_name: 'Large Bag', sku: 'DF-LG', gtin: '012345678901', vendor_code: 'BPW-001', notes: '', quantity_ordered: 5, unit_cost_cents: 2500 },
    { item_name: 'Cat Food', variation_name: 'Small Can', sku: 'CF-SM', gtin: '',             vendor_code: null,     notes: null, quantity_ordered: 10, unit_cost_cents: 800 },
];

// ─── getPurchaseOrderForExport ────────────────────────────────────────────────

describe('getPurchaseOrderForExport', () => {
    test('returns null when PO not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await getPurchaseOrderForExport(10, 'PO-MISSING')).toBeNull();
    });

    test('returns { po, items } on success', async () => {
        db.query.mockResolvedValueOnce({ rows: [samplePo] });
        db.query.mockResolvedValueOnce({ rows: sampleItems });
        const result = await getPurchaseOrderForExport(10, 'PO-20260403-001');
        expect(result).not.toBeNull();
        expect(result.po.po_number).toBe('PO-20260403-001');
        expect(result.items).toHaveLength(2);
    });

    test('passes merchant_id to both queries', async () => {
        db.query.mockResolvedValueOnce({ rows: [samplePo] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await getPurchaseOrderForExport(42, 'PO-20260403-001');
        expect(db.query.mock.calls[0][1]).toContain(42);
        expect(db.query.mock.calls[1][1]).toContain(42);
    });

    test('passes poNumber to header query', async () => {
        db.query.mockResolvedValueOnce({ rows: [samplePo] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await getPurchaseOrderForExport(10, 'PO-20260403-001');
        expect(db.query.mock.calls[0][1]).toContain('PO-20260403-001');
    });

    test('passes vendor_id to items query for vendor_code join', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ ...samplePo, vendor_id: 7 }] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await getPurchaseOrderForExport(10, 'PO-20260403-001');
        expect(db.query.mock.calls[1][1]).toContain(7);
    });
});

// ─── buildCsvContent — headers and structure ──────────────────────────────────

describe('buildCsvContent — headers', () => {
    test('first line is exact Square 12-column header', () => {
        const csv = buildCsvContent({ po: samplePo, items: [] });
        const firstLine = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
        expect(firstLine).toBe(
            'Item Name,Variation Name,SKU,GTIN,Vendor Code,Notes,Qty,Unit Price,Fee,Price w/ Fee,Amount,Status'
        );
    });

    test('starts with UTF-8 BOM', () => {
        const csv = buildCsvContent({ po: samplePo, items: [] });
        expect(csv.charCodeAt(0)).toBe(0xFEFF);
    });

    test('uses CRLF line endings throughout', () => {
        const csv = buildCsvContent({ po: samplePo, items: sampleItems });
        // All line breaks should be CRLF (no bare LF)
        const lonelyLF = csv.replace(/\r\n/g, '').includes('\n');
        expect(lonelyLF).toBe(false);
    });

    test('ends with CRLF', () => {
        const csv = buildCsvContent({ po: samplePo, items: [] });
        expect(csv.endsWith('\r\n')).toBe(true);
    });
});

// ─── buildCsvContent — data rows ─────────────────────────────────────────────

describe('buildCsvContent — data rows', () => {
    function getDataLines(csv) {
        const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
        // Lines 0 = header, then data rows until first blank line
        const blankIdx = lines.findIndex((l, i) => i > 0 && l === '');
        return lines.slice(1, blankIdx);
    }

    test('produces one data row per item', () => {
        const csv = buildCsvContent({ po: samplePo, items: sampleItems });
        expect(getDataLines(csv)).toHaveLength(2);
    });

    test('unit price is dollars (not cents) in $X.XX format', () => {
        const csv = buildCsvContent({ po: samplePo, items: [sampleItems[0]] }); // 2500 cents
        const row = getDataLines(csv)[0].split(',');
        expect(row[7]).toBe('$25.00'); // Unit Price column
    });

    test('amount = qty * unit_cost in dollars', () => {
        const csv = buildCsvContent({ po: samplePo, items: [sampleItems[0]] }); // qty=5, cost=2500¢
        const row = getDataLines(csv)[0].split(',');
        expect(row[10]).toBe('$125.00'); // Amount column (5 * $25.00)
    });

    test('status column is "Open" for all rows', () => {
        const csv = buildCsvContent({ po: samplePo, items: sampleItems });
        for (const line of getDataLines(csv)) {
            expect(line.split(',').at(-1)).toBe('Open');
        }
    });

    test('fee column is blank (no fee)', () => {
        const csv = buildCsvContent({ po: samplePo, items: [sampleItems[0]] });
        const row = getDataLines(csv)[0].split(',');
        expect(row[8]).toBe(''); // Fee column
    });

    test('handles null gtin gracefully (empty string)', () => {
        const item = { ...sampleItems[1], gtin: null };
        const csv = buildCsvContent({ po: samplePo, items: [item] });
        const row = getDataLines(csv)[0].split(',');
        expect(row[3]).toBe(''); // GTIN column
    });

    test('handles null vendor_code gracefully', () => {
        const csv = buildCsvContent({ po: samplePo, items: [sampleItems[1]] }); // null vendor_code
        const row = getDataLines(csv)[0].split(',');
        expect(row[4]).toBe(''); // Vendor Code column
    });

    test('handles null item notes gracefully', () => {
        const csv = buildCsvContent({ po: samplePo, items: [sampleItems[1]] }); // null notes
        const row = getDataLines(csv)[0].split(',');
        expect(row[5]).toBe(''); // Notes column
    });

    test('unit_cost_cents=0 renders as $0.00', () => {
        const item = { ...sampleItems[0], unit_cost_cents: 0 };
        const csv = buildCsvContent({ po: samplePo, items: [item] });
        const row = getDataLines(csv)[0].split(',');
        expect(row[7]).toBe('$0.00');
    });
});

// ─── buildCsvContent — metadata footer ───────────────────────────────────────

describe('buildCsvContent — metadata footer', () => {
    function getFooterLines(csv) {
        const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
        // Footer starts after the second blank line
        const blankPositions = [];
        csv.replace(/^\uFEFF/, '').split('\r\n').forEach((l, i) => { if (l === '') blankPositions.push(i); });
        const footerStart = (blankPositions[1] ?? lines.length - 1) + 1;
        return csv.replace(/^\uFEFF/, '').split('\r\n').slice(footerStart).filter(Boolean);
    }

    test('vendor row uses po.vendor_name', () => {
        const csv = buildCsvContent({ po: samplePo, items: [] });
        expect(getFooterLines(csv).some(l => l.includes('Best Pets Wholesale'))).toBe(true);
    });

    test('ship-to row uses po.location_name', () => {
        const csv = buildCsvContent({ po: samplePo, items: [] });
        expect(getFooterLines(csv).some(l => l.includes('Main Store'))).toBe(true);
    });

    test('notes row uses po.notes', () => {
        const csv = buildCsvContent({ po: samplePo, items: [] });
        expect(getFooterLines(csv).some(l => l.startsWith('Notes,') && l.includes('Rush order'))).toBe(true);
    });

    test('uses lead_time_days fallback when expected_delivery_date absent', () => {
        const po = { ...samplePo, expected_delivery_date: null, lead_time_days: 14 };
        // Should not throw and should produce an "Expected On" footer line
        const csv = buildCsvContent({ po, items: [] });
        expect(getFooterLines(csv).some(l => l.startsWith('Expected On,'))).toBe(true);
    });
});

// ─── buildXlsxWorkbook — structure ───────────────────────────────────────────

describe('buildXlsxWorkbook — sheet structure', () => {
    test('returns a workbook with sheet named Sheet0', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws).toBeDefined();
        expect(ws.name).toBe('Sheet0');
    });

    test('A1 contains Square instructions text', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getCell('A1').value).toContain('Fill out the purchase order');
    });

    test('A4/B4 contain Vendor label and vendor name', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getCell('A4').value).toBe('Vendor');
        expect(ws.getCell('B4').value).toBe('Best Pets Wholesale');
    });

    test('A5/B5 contain Ship to label and location name', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getCell('A5').value).toBe('Ship to');
        expect(ws.getCell('B5').value).toBe('Main Store');
    });

    test('B6 has date number format', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getCell('B6').numFmt).toBe('m/d/yyyy');
    });

    test('row 9 has correct 8-column headers in order', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        const headers = ws.getRow(9).values;
        // ExcelJS row.values is 1-indexed (index 0 is undefined)
        expect(headers[1]).toBe('Item Name');
        expect(headers[2]).toBe('Variation Name');
        expect(headers[3]).toBe('SKU');
        expect(headers[4]).toBe('GTIN');
        expect(headers[5]).toBe('Vendor Code');
        expect(headers[6]).toBe('Notes');
        expect(headers[7]).toBe('Qty');
        expect(headers[8]).toBe('Unit Cost');
    });

    test('row 9 is bold', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getRow(9).font).toEqual({ bold: true });
    });
});

// ─── buildXlsxWorkbook — data rows ───────────────────────────────────────────

describe('buildXlsxWorkbook — data rows', () => {
    test('first item starts at row 10', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [sampleItems[0]] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getRow(10).values[1]).toBe('Dog Food');
    });

    test('unit cost is decimal (cents / 100), not raw cents', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [sampleItems[0]] }); // 2500 cents
        const ws = wb.getWorksheet('Sheet0');
        const row10 = ws.getRow(10);
        expect(row10.values[8]).toBe(25.00); // Unit Cost column (8th)
    });

    test('unit cost cell has "0.00" number format', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: [sampleItems[0]] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getRow(10).getCell(8).numFmt).toBe('0.00');
    });

    test('quantity is rounded integer', () => {
        const item = { ...sampleItems[0], quantity_ordered: 4.9 };
        const wb = buildXlsxWorkbook({ po: samplePo, items: [item] });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getRow(10).values[7]).toBe(5); // Math.round(4.9) = 5
    });

    test('multiple items placed in sequential rows', () => {
        const wb = buildXlsxWorkbook({ po: samplePo, items: sampleItems });
        const ws = wb.getWorksheet('Sheet0');
        expect(ws.getRow(10).values[1]).toBe('Dog Food');
        expect(ws.getRow(11).values[1]).toBe('Cat Food');
    });

    test('null/undefined item fields default to empty string', () => {
        const item = { item_name: null, variation_name: undefined, sku: null, gtin: null,
                       vendor_code: null, notes: null, quantity_ordered: 3, unit_cost_cents: 500 };
        const wb = buildXlsxWorkbook({ po: samplePo, items: [item] });
        const ws = wb.getWorksheet('Sheet0');
        const vals = ws.getRow(10).values;
        expect(vals[1]).toBe(''); // item_name
        expect(vals[4]).toBe(''); // gtin
    });

    test('uses lead_time_days for expectedDate when expected_delivery_date absent', () => {
        const po = { ...samplePo, expected_delivery_date: null, lead_time_days: 5 };
        expect(() => buildXlsxWorkbook({ po, items: [] })).not.toThrow();
        const wb = buildXlsxWorkbook({ po, items: [] });
        const ws = wb.getWorksheet('Sheet0');
        const dateVal = ws.getCell('B6').value;
        expect(dateVal).toBeInstanceOf(Date);
    });
});
