'use strict';

/**
 * Purchase Order Export Service
 * Extracted from routes/purchase-orders.js export handlers.
 * DB fetch: getPurchaseOrderForExport
 * Pure builders: buildCsvContent, buildXlsxWorkbook
 */

const ExcelJS = require('exceljs');
const db = require('../../utils/database');
const { escapeCSVField, formatDateForSquare, formatMoney, formatGTIN, UTF8_BOM } = require('../../utils/csv-helpers');

/**
 * Fetch PO header and line items for export. Returns null if not found.
 * @param {number} merchantId
 * @param {string} poNumber  e.g. "PO-20260403-001"
 * @returns {Promise<{ po: object, items: Array }|null>}
 */
async function getPurchaseOrderForExport(merchantId, poNumber) {
    const poResult = await db.query(`
        SELECT po.*, v.name AS vendor_name, v.lead_time_days,
               l.name AS location_name, l.address AS location_address
        FROM purchase_orders po
        JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
        JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
        WHERE po.po_number = $1 AND po.merchant_id = $2
    `, [poNumber, merchantId]);

    if (poResult.rows.length === 0) return null;
    const po = poResult.rows[0];

    const itemsResult = await db.query(`
        SELECT poi.*, v.sku, v.upc AS gtin, i.name AS item_name, v.name AS variation_name, vv.vendor_code
        FROM purchase_order_items poi
        JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
        WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3
        ORDER BY i.name, v.name
    `, [po.id, po.vendor_id, merchantId]);

    return { po, items: itemsResult.rows };
}

/**
 * Build Square-compatible CSV content string (with UTF-8 BOM and CRLF endings).
 * 12-column format: Item Name, Variation Name, SKU, GTIN, Vendor Code, Notes,
 *                   Qty, Unit Price, Fee, Price w/ Fee, Amount, Status
 * Metadata rows appended at the bottom per Square's import format.
 * @param {{ po: object, items: Array }} poData
 * @returns {string}
 */
function buildCsvContent({ po, items }) {
    const lines = ['Item Name,Variation Name,SKU,GTIN,Vendor Code,Notes,Qty,Unit Price,Fee,Price w/ Fee,Amount,Status'];

    for (const item of items) {
        const qty = Math.round(item.quantity_ordered || 0);
        const unitPrice = formatMoney(item.unit_cost_cents);
        lines.push([
            escapeCSVField(item.item_name || ''),
            escapeCSVField(item.variation_name || ''),
            formatGTIN(item.sku),
            formatGTIN(item.gtin),
            escapeCSVField(item.vendor_code || ''),
            escapeCSVField(item.notes || ''),
            qty,
            unitPrice,
            '',           // Fee (blank — no fee)
            unitPrice,    // Price w/ Fee = Unit Price when no fee
            formatMoney(qty * (item.unit_cost_cents || 0)),
            'Open',
        ].join(','));
    }

    let expectedDeliveryDate = po.expected_delivery_date;
    if (!expectedDeliveryDate) {
        const d = new Date();
        d.setDate(d.getDate() + (po.lead_time_days || 7));
        expectedDeliveryDate = d.toISOString();
    }

    lines.push(
        '', '',
        `Vendor,${escapeCSVField(po.vendor_name)}`,
        'Account Number,', 'Address,', 'Contact,', 'Phone Number,', 'Email,', '',
        `Ship To,${escapeCSVField(po.location_name)}`,
        `Expected On,${formatDateForSquare(expectedDeliveryDate)}`,
        'Ordered By,',
        `Notes,${escapeCSVField(po.notes || '')}`
    );

    return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * Build Square-compatible XLSX workbook.
 * Row layout: A1 instructions, rows 4-7 metadata, row 9 headers, row 10+ items.
 * @param {{ po: object, items: Array }} poData
 * @returns {ExcelJS.Workbook}
 */
function buildXlsxWorkbook({ po, items }) {
    const expectedDate = po.expected_delivery_date
        ? new Date(po.expected_delivery_date)
        : (() => { const d = new Date(); d.setDate(d.getDate() + (po.lead_time_days || 7)); return d; })();

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Sheet0');

    ws.getCell('A1').value = 'Fill out the purchase order starting with the line items - then add in the vendor and destination name below. Each line item requires at least one of the following: item name, SKU, or GTIN. Quantity is also required for each item.';
    ws.getCell('A4').value = 'Vendor';      ws.getCell('B4').value = po.vendor_name;
    ws.getCell('A5').value = 'Ship to';     ws.getCell('B5').value = po.location_name;
    ws.getCell('A6').value = 'Expected On'; ws.getCell('B6').value = expectedDate;
    ws.getCell('B6').numFmt = 'm/d/yyyy';
    ws.getCell('A7').value = 'Notes';       ws.getCell('B7').value = po.notes || '';

    ws.getRow(9).values = ['Item Name', 'Variation Name', 'SKU', 'GTIN', 'Vendor Code', 'Notes', 'Qty', 'Unit Cost'];
    ws.getRow(9).font = { bold: true };

    let r = 10;
    for (const item of items) {
        const row = ws.getRow(r++);
        row.values = [
            item.item_name || '', item.variation_name || '', item.sku || '', item.gtin || '',
            item.vendor_code || '', item.notes || '',
            Math.round(item.quantity_ordered || 0),
            (item.unit_cost_cents || 0) / 100,
        ];
        row.getCell(8).numFmt = '0.00';
    }

    ws.columns = [
        { key: 'a', width: 25 }, { key: 'b', width: 20 }, { key: 'c', width: 15 },
        { key: 'd', width: 15 }, { key: 'e', width: 15 }, { key: 'f', width: 20 },
        { key: 'g', width: 8 },  { key: 'h', width: 12 },
    ];

    return workbook;
}

module.exports = { getPurchaseOrderForExport, buildCsvContent, buildXlsxWorkbook };
