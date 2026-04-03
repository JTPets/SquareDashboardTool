'use strict';

/**
 * Purchase Order Routes — thin handlers; all logic in services.
 * CRUD/status:  services/purchase-orders/po-service.js
 * Receive:      services/purchase-orders/po-receive-service.js
 * Exports:      services/purchase-orders/po-export-service.js
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/purchase-orders');
const { sendSuccess, sendError } = require('../utils/response-helper');
const poService = require('../services/purchase-orders/po-service');
const poReceiveService = require('../services/purchase-orders/po-receive-service');
const poExportService = require('../services/purchase-orders/po-export-service');

// POST /api/purchase-orders — Create PO
router.post('/', requireAuth, requireMerchant, validators.createPurchaseOrder, asyncHandler(async (req, res) => {
    const { vendor_id, location_id, supply_days_override, items, notes, created_by, force } = req.body;
    let result;
    try {
        result = await poService.createPurchaseOrder(req.merchantContext.id, {
            vendorId: vendor_id, locationId: location_id, supplyDaysOverride: supply_days_override,
            notes, createdBy: created_by, items, force,
        });
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500, err.code);
    }
    const data = { purchase_order: result.po, expiry_discounts_cleared: result.clearedExpiryItems };
    if (result.minimumWarning) data.minimum_warning = result.minimumWarning;
    sendSuccess(res, { data }, 201);
}));

// GET /api/purchase-orders — List POs (?status= and ?vendor_id= filters)
router.get('/', requireAuth, requireMerchant, validators.listPurchaseOrders, asyncHandler(async (req, res) => {
    const rows = await poService.listPurchaseOrders(req.merchantContext.id, {
        status: req.query.status, vendorId: req.query.vendor_id,
    });
    sendSuccess(res, { count: rows.length, purchase_orders: rows });
}));

// GET /api/purchase-orders/:id — Get single PO with items
router.get('/:id', requireAuth, requireMerchant, validators.getPurchaseOrder, asyncHandler(async (req, res) => {
    const po = await poService.getPurchaseOrder(req.merchantContext.id, req.params.id);
    if (!po) return sendError(res, 'Purchase order not found', 404);
    sendSuccess(res, po);
}));

// PATCH /api/purchase-orders/:id — Update DRAFT PO
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

// GET /api/purchase-orders/:po_number/export-csv — Square CSV
router.get('/:po_number/export-csv', requireAuth, requireMerchant, validators.exportPurchaseOrderCsv, asyncHandler(async (req, res) => {
    const poData = await poExportService.getPurchaseOrderForExport(req.merchantContext.id, req.params.po_number);
    if (!poData) return sendError(res, 'Purchase order not found', 404);
    const content = poExportService.buildCsvContent(poData);
    const safeName = poData.po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poData.po.po_number}_${safeName}.csv"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(content);
    logger.info('Square CSV export generated', { po_number: poData.po.po_number, vendor: poData.po.vendor_name, items: poData.items.length });
}));

// GET /api/purchase-orders/:po_number/export-xlsx — Square XLSX
router.get('/:po_number/export-xlsx', requireAuth, requireMerchant, validators.exportPurchaseOrderXlsx, asyncHandler(async (req, res) => {
    const poData = await poExportService.getPurchaseOrderForExport(req.merchantContext.id, req.params.po_number);
    if (!poData) return sendError(res, 'Purchase order not found', 404);
    const workbook = poExportService.buildXlsxWorkbook(poData);
    const buffer = await workbook.xlsx.writeBuffer();
    const safeName = poData.po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poData.po.po_number}_${safeName}.xlsx"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(buffer);
    logger.info('Square XLSX export generated', { po_number: poData.po.po_number, vendor: poData.po.vendor_name, items: poData.items.length });
}));

module.exports = router;
