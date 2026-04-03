'use strict';

/**
 * Purchase Order Routes — CRUD, status transitions, receive, and exports.
 * CRUD/status: services/purchase-orders/po-service.js
 * Receive: services/purchase-orders/po-receive-service.js
 * TODO: exports → po-export-service.js
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const { escapeCSVField, formatDateForSquare, formatMoney, formatGTIN, UTF8_BOM } = require('../utils/csv-helpers');
const validators = require('../middleware/validators/purchase-orders');
const { sendSuccess, sendError } = require('../utils/response-helper');
const poService = require('../services/purchase-orders/po-service');
const poReceiveService = require('../services/purchase-orders/po-receive-service');

// POST /api/purchase-orders — Create PO
router.post('/', requireAuth, requireMerchant, validators.createPurchaseOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { vendor_id, location_id, supply_days_override, items, notes, created_by, force } = req.body;
    let result;
    try {
        result = await poService.createPurchaseOrder(merchantId, {
            vendorId: vendor_id, locationId: location_id, supplyDaysOverride: supply_days_override,
            notes, createdBy: created_by, items, force
        });
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500, err.code);
    }
    const data = { purchase_order: result.po, expiry_discounts_cleared: result.clearedExpiryItems };
    if (result.minimumWarning) data.minimum_warning = result.minimumWarning;
    sendSuccess(res, { data }, 201);
}));

// GET /api/purchase-orders — List POs (optional ?status= and ?vendor_id= filters)
router.get('/', requireAuth, requireMerchant, validators.listPurchaseOrders, asyncHandler(async (req, res) => {
    const rows = await poService.listPurchaseOrders(req.merchantContext.id, {
        status: req.query.status, vendorId: req.query.vendor_id
    });
    sendSuccess(res, { count: rows.length, purchase_orders: rows });
}));

// GET /api/purchase-orders/:id — Get single PO with items
router.get('/:id', requireAuth, requireMerchant, validators.getPurchaseOrder, asyncHandler(async (req, res) => {
    const po = await poService.getPurchaseOrder(req.merchantContext.id, req.params.id);
    if (!po) return sendError(res, 'Purchase order not found', 404);
    sendSuccess(res, po);
}));

// PATCH /api/purchase-orders/:id — Update DRAFT PO header/items
router.patch('/:id', requireAuth, requireMerchant, validators.updatePurchaseOrder, asyncHandler(async (req, res) => {
    const { supply_days_override, items, notes } = req.body;
    let updatedPo;
    try {
        updatedPo = await poService.updatePurchaseOrder(req.merchantContext.id, req.params.id,
            { supplyDaysOverride: supply_days_override, notes, items });
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    sendSuccess(res, { status: 'success', purchase_order: updatedPo });
}));

// POST /api/purchase-orders/:id/submit — DRAFT → SUBMITTED
router.post('/:id/submit', requireAuth, requireMerchant, validators.submitPurchaseOrder, asyncHandler(async (req, res) => {
    let po;
    try {
        po = await poService.submitPurchaseOrder(req.merchantContext.id, req.params.id);
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    sendSuccess(res, { status: 'success', purchase_order: po });
}));

// POST /api/purchase-orders/:id/receive — Record received quantities
router.post('/:id/receive', requireAuth, requireMerchant, validators.receivePurchaseOrder, asyncHandler(async (req, res) => {
    let po;
    try {
        po = await poReceiveService.receiveItems(req.merchantContext.id, req.params.id, req.body.items);
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    sendSuccess(res, { status: 'success', purchase_order: po });
}));

// DELETE /api/purchase-orders/:id — Delete DRAFT PO
router.delete('/:id', requireAuth, requireMerchant, validators.deletePurchaseOrder, asyncHandler(async (req, res) => {
    let deleted;
    try {
        deleted = await poService.deletePurchaseOrder(req.merchantContext.id, req.params.id);
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    sendSuccess(res, { status: 'success', message: `Purchase order ${deleted.poNumber} deleted successfully` });
}));

// GET /api/purchase-orders/:po_number/export-csv — Square CSV export (TODO: po-export-service)
router.get('/:po_number/export-csv', requireAuth, requireMerchant, validators.exportPurchaseOrderCsv, asyncHandler(async (req, res) => {
    const { po_number } = req.params;
    const merchantId = req.merchantContext.id;

    const poResult = await db.query(`
        SELECT po.*, v.name as vendor_name, v.lead_time_days, l.name as location_name, l.address as location_address
        FROM purchase_orders po
        JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
        JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
        WHERE po.po_number = $1 AND po.merchant_id = $2
    `, [po_number, merchantId]);
    if (poResult.rows.length === 0) return sendError(res, 'Purchase order not found', 404);
    const po = poResult.rows[0];

    const itemsResult = await db.query(`
        SELECT poi.*, v.sku, v.upc as gtin, i.name as item_name, v.name as variation_name, vv.vendor_code
        FROM purchase_order_items poi
        JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
        WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3
        ORDER BY i.name, v.name
    `, [po.id, po.vendor_id, merchantId]);

    // EXACT Square 12-column format with BOM and CRLF
    const lines = ['Item Name,Variation Name,SKU,GTIN,Vendor Code,Notes,Qty,Unit Price,Fee,Price w/ Fee,Amount,Status'];
    for (const item of itemsResult.rows) {
        const qty = Math.round(item.quantity_ordered || 0);
        const unitPrice = formatMoney(item.unit_cost_cents);
        lines.push([escapeCSVField(item.item_name || ''), escapeCSVField(item.variation_name || ''),
            formatGTIN(item.sku), formatGTIN(item.gtin), escapeCSVField(item.vendor_code || ''),
            escapeCSVField(item.notes || ''), qty, unitPrice, '', unitPrice,
            formatMoney(qty * (item.unit_cost_cents || 0)), 'Open'].join(','));
    }
    let expectedDeliveryDate = po.expected_delivery_date;
    if (!expectedDeliveryDate) {
        const d = new Date(); d.setDate(d.getDate() + (po.lead_time_days || 7));
        expectedDeliveryDate = d.toISOString();
    }
    lines.push('', '', `Vendor,${escapeCSVField(po.vendor_name)}`, 'Account Number,', 'Address,',
        'Contact,', 'Phone Number,', 'Email,', '',
        `Ship To,${escapeCSVField(po.location_name)}`, `Expected On,${formatDateForSquare(expectedDeliveryDate)}`,
        'Ordered By,', `Notes,${escapeCSVField(po.notes || '')}`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(UTF8_BOM + lines.join('\r\n') + '\r\n');
    logger.info('Square CSV export generated', { po_number: po.po_number, vendor: po.vendor_name, items: itemsResult.rows.length });
}));

// GET /api/purchase-orders/:po_number/export-xlsx — Square XLSX export (TODO: po-export-service)
router.get('/:po_number/export-xlsx', requireAuth, requireMerchant, validators.exportPurchaseOrderXlsx, asyncHandler(async (req, res) => {
    const ExcelJS = require('exceljs');
    const { po_number } = req.params;
    const merchantId = req.merchantContext.id;

    const poResult = await db.query(`
        SELECT po.*, v.name as vendor_name, v.lead_time_days, l.name as location_name
        FROM purchase_orders po
        JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
        JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
        WHERE po.po_number = $1 AND po.merchant_id = $2
    `, [po_number, merchantId]);
    if (poResult.rows.length === 0) return sendError(res, 'Purchase order not found', 404);
    const po = poResult.rows[0];

    const itemsResult = await db.query(`
        SELECT poi.*, v.sku, v.upc as gtin, i.name as item_name, v.name as variation_name, vv.vendor_code
        FROM purchase_order_items poi
        JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
        WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3 ORDER BY i.name, v.name
    `, [po.id, po.vendor_id, merchantId]);

    const expectedDate = po.expected_delivery_date
        ? new Date(po.expected_delivery_date)
        : (() => { const d = new Date(); d.setDate(d.getDate() + (po.lead_time_days || 7)); return d; })();

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Sheet0');
    ws.getCell('A1').value = 'Fill out the purchase order starting with the line items - then add in the vendor and destination name below. Each line item requires at least one of the following: item name, SKU, or GTIN. Quantity is also required for each item.';
    ws.getCell('A4').value = 'Vendor';     ws.getCell('B4').value = po.vendor_name;
    ws.getCell('A5').value = 'Ship to';    ws.getCell('B5').value = po.location_name;
    ws.getCell('A6').value = 'Expected On'; ws.getCell('B6').value = expectedDate; ws.getCell('B6').numFmt = 'm/d/yyyy';
    ws.getCell('A7').value = 'Notes';      ws.getCell('B7').value = po.notes || '';
    ws.getRow(9).values = ['Item Name', 'Variation Name', 'SKU', 'GTIN', 'Vendor Code', 'Notes', 'Qty', 'Unit Cost'];
    ws.getRow(9).font = { bold: true };
    let r = 10;
    for (const item of itemsResult.rows) {
        const row = ws.getRow(r++);
        row.values = [item.item_name || '', item.variation_name || '', item.sku || '', item.gtin || '',
            item.vendor_code || '', item.notes || '', Math.round(item.quantity_ordered || 0), (item.unit_cost_cents || 0) / 100];
        row.getCell(8).numFmt = '0.00';
    }
    ws.columns = [{ key: 'a', width: 25 }, { key: 'b', width: 20 }, { key: 'c', width: 15 }, { key: 'd', width: 15 },
        { key: 'e', width: 15 }, { key: 'f', width: 20 }, { key: 'g', width: 8 }, { key: 'h', width: 12 }];

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(buffer);
    logger.info('Square XLSX export generated', { po_number: po.po_number, vendor: po.vendor_name, items: itemsResult.rows.length });
}));

module.exports = router;
