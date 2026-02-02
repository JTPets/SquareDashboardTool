/**
 * Purchase Order Routes
 *
 * Financial operations for managing purchase orders:
 * - Create, update, delete draft POs
 * - Submit and receive POs
 * - Export to CSV/XLSX (Square-compatible formats)
 *
 * SECURITY CONSIDERATIONS:
 * - All operations scoped to merchant context (multi-tenant isolation)
 * - Vendor and location ownership validated before operations
 * - Only DRAFT orders can be modified/deleted
 * - All monetary values in cents to avoid floating point issues
 *
 * Endpoints:
 * - POST   /api/purchase-orders                    - Create PO
 * - GET    /api/purchase-orders                    - List POs
 * - GET    /api/purchase-orders/:id                - Get single PO
 * - PATCH  /api/purchase-orders/:id                - Update draft PO
 * - POST   /api/purchase-orders/:id/submit         - Submit PO
 * - POST   /api/purchase-orders/:id/receive        - Receive PO items
 * - DELETE /api/purchase-orders/:id                - Delete draft PO
 * - GET    /api/purchase-orders/:po_number/export-csv  - Export as CSV
 * - GET    /api/purchase-orders/:po_number/export-xlsx - Export as Excel
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
const { clearExpiryDiscountForReorder, applyDiscounts } = require('../services/expiry/discount-service');

/**
 * POST /api/purchase-orders
 * Create a new purchase order
 */
router.post('/', requireAuth, requireMerchant, validators.createPurchaseOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
        const { vendor_id, location_id, supply_days_override, items, notes, created_by } = req.body;

        // Filter out any items with zero or negative quantity
        const validItems = items.filter(item => item.quantity_ordered > 0);
        if (validItems.length === 0) {
            return res.status(400).json({
                error: 'No items with valid quantities. All items have zero or negative quantity.'
            });
        }

        // Security: Pre-validate vendor_id belongs to this merchant
        const vendorCheck = await db.query(
            'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
            [vendor_id, merchantId]
        );
        if (vendorCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid vendor or vendor does not belong to this merchant' });
        }

        // Security: Pre-validate location_id belongs to this merchant
        const locationCheck = await db.query(
            'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
            [location_id, merchantId]
        );
        if (locationCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid location or location does not belong to this merchant' });
        }

        // Generate PO number: PO-YYYYMMDD-XXX
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
        const countResult = await db.query(
            "SELECT COUNT(*) as count FROM purchase_orders WHERE po_number LIKE $1 AND merchant_id = $2",
            [`PO-${dateStr}-%`, merchantId]
        );
        const sequence = parseInt(countResult.rows[0].count) + 1;
        const poNumber = `PO-${dateStr}-${sequence.toString().padStart(3, '0')}`;

        // Calculate totals
        let subtotalCents = 0;
        for (const item of validItems) {
            subtotalCents += item.quantity_ordered * item.unit_cost_cents;
        }

        // Use transaction to ensure PO and items are created atomically
        const po = await db.transaction(async (client) => {
            // Create PO
            const poResult = await client.query(`
                INSERT INTO purchase_orders (
                    po_number, vendor_id, location_id, status, supply_days_override,
                    subtotal_cents, total_cents, notes, created_by, merchant_id
                )
                VALUES ($1, $2, $3, 'DRAFT', $4, $5, $5, $6, $7, $8)
                RETURNING *
            `, [poNumber, vendor_id, location_id, supply_days_override, subtotalCents, notes, created_by, merchantId]);

            const createdPo = poResult.rows[0];

            // Create PO items with batch insert (avoid N+1 queries)
            if (validItems.length > 0) {
                const values = [];
                const placeholders = validItems.map((item, i) => {
                    const offset = i * 8;
                    const totalCost = item.quantity_ordered * item.unit_cost_cents;
                    values.push(
                        createdPo.id,
                        item.variation_id,
                        item.quantity_override || null,
                        item.quantity_ordered,
                        item.unit_cost_cents,
                        totalCost,
                        item.notes || null,
                        merchantId
                    );
                    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
                }).join(', ');

                await client.query(`
                    INSERT INTO purchase_order_items (
                        purchase_order_id, variation_id, quantity_override,
                        quantity_ordered, unit_cost_cents, total_cost_cents, notes, merchant_id
                    )
                    VALUES ${placeholders}
                `, values);
            }

            return createdPo;
        });

    // After PO creation, check for items with active expiry discounts and clear them
    const clearedExpiryItems = [];
    const affectedTiers = new Set();

    // Get expiry status for all items in the PO
    const variationIds = validItems.map(item => item.variation_id);
    const expiryStatusResult = await db.query(`
        SELECT
            vds.variation_id,
            edt.tier_code,
            edt.is_auto_apply,
            i.name as item_name,
            v.name as variation_name
        FROM variation_discount_status vds
        JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
        JOIN variations v ON vds.variation_id = v.id AND v.merchant_id = $1
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        WHERE vds.variation_id = ANY($2) AND vds.merchant_id = $1
          AND edt.is_auto_apply = TRUE
          AND edt.tier_code IN ('AUTO50', 'AUTO25', 'EXPIRED')
    `, [merchantId, variationIds]);

    // Clear expiry discounts for affected items
    for (const item of expiryStatusResult.rows) {
        try {
            const result = await clearExpiryDiscountForReorder(merchantId, item.variation_id);
            if (result.cleared) {
                clearedExpiryItems.push({
                    variation_id: item.variation_id,
                    item_name: item.item_name,
                    variation_name: item.variation_name,
                    previous_tier: result.previousTier
                });
                affectedTiers.add(result.previousTier);
            }
        } catch (clearError) {
            logger.error('Failed to clear expiry discount during PO creation', {
                merchantId,
                variationId: item.variation_id,
                error: clearError.message
            });
            // Continue processing other items - don't fail the whole PO
        }
    }

    // If any expiry discounts were cleared, trigger applyDiscounts to rebuild Square pricing rules
    if (clearedExpiryItems.length > 0) {
        try {
            logger.info('Triggering applyDiscounts after reorder expiry clear', {
                merchantId,
                clearedCount: clearedExpiryItems.length,
                affectedTiers: Array.from(affectedTiers)
            });
            // Run applyDiscounts asynchronously - don't wait for it to complete
            // This rebuilds the Square pricing rules without the cleared variations
            applyDiscounts({ merchantId, dryRun: false }).catch(applyError => {
                logger.error('Background applyDiscounts failed after reorder', {
                    merchantId,
                    error: applyError.message
                });
            });
        } catch (applyError) {
            logger.error('Failed to trigger applyDiscounts after reorder', {
                merchantId,
                error: applyError.message
            });
            // Don't fail the PO creation - the daily job will clean up
        }
    }

    res.status(201).json({
        success: true,
        data: {
            purchase_order: po,
            expiry_discounts_cleared: clearedExpiryItems
        }
    });
}));

/**
 * GET /api/purchase-orders
 * List purchase orders with filtering
 */
router.get('/', requireAuth, requireMerchant, validators.listPurchaseOrders, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { status, vendor_id } = req.query;
        let query = `
            SELECT
                po.*,
                v.name as vendor_name,
                l.name as location_name,
                COUNT(poi.id) as item_count
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $1
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $1
            LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id AND poi.merchant_id = $1
            WHERE po.merchant_id = $1
        `;
        const params = [merchantId];

        if (status) {
            params.push(status);
            query += ` AND po.status = $${params.length}`;
        }

        if (vendor_id) {
            params.push(vendor_id);
            query += ` AND po.vendor_id = $${params.length}`;
        }

        query += ' GROUP BY po.id, v.name, l.name ORDER BY po.created_at DESC';

    const result = await db.query(query, params);
    res.json({
        count: result.rows.length,
        purchase_orders: result.rows
    });
}));

/**
 * GET /api/purchase-orders/:id
 * Get single purchase order with all items
 */
router.get('/:id', requireAuth, requireMerchant, validators.getPurchaseOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { id } = req.params;

        // Get PO header
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
            WHERE po.id = $1 AND po.merchant_id = $2
        `, [id, merchantId]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];

        // Get PO items with vendor code and UPC for reconciliation
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                v.upc as gtin,
                i.name as item_name,
                v.name as variation_name,
                vv.vendor_code
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $2
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $3 AND vv.merchant_id = $2
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $2
            ORDER BY i.name, v.name
        `, [id, merchantId, po.vendor_id]);

    po.items = itemsResult.rows;

    res.json(po);
}));

/**
 * PATCH /api/purchase-orders/:id
 * Update a draft purchase order
 */
router.patch('/:id', requireAuth, requireMerchant, validators.updatePurchaseOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { id } = req.params;
    const { supply_days_override, items, notes } = req.body;

        // Check if PO is in DRAFT status and belongs to this merchant
        const statusCheck = await db.query(
            'SELECT status FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
        );

        if (statusCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        if (statusCheck.rows[0].status !== 'DRAFT') {
            return res.status(400).json({
                error: 'Only draft purchase orders can be updated'
            });
        }

        await db.transaction(async (client) => {
            // Update PO header
            const updates = [];
            const values = [];
            let paramCount = 1;

            if (supply_days_override !== undefined) {
                updates.push(`supply_days_override = $${paramCount}`);
                values.push(supply_days_override);
                paramCount++;
            }

            if (notes !== undefined) {
                updates.push(`notes = $${paramCount}`);
                values.push(notes);
                paramCount++;
            }

            if (updates.length > 0) {
                updates.push('updated_at = CURRENT_TIMESTAMP');
                values.push(id);
                values.push(merchantId);
                await client.query(`
                    UPDATE purchase_orders
                    SET ${updates.join(', ')}
                    WHERE id = $${paramCount} AND merchant_id = $${paramCount + 1}
                `, values);
            }

            // Update items if provided
            if (items) {
                // Delete existing items
                await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1 AND merchant_id = $2', [id, merchantId]);

                // Insert new items and calculate totals
                let subtotalCents = 0;
                for (const item of items) {
                    const totalCost = item.quantity_ordered * item.unit_cost_cents;
                    subtotalCents += totalCost;

                    await client.query(`
                        INSERT INTO purchase_order_items (
                            purchase_order_id, variation_id, quantity_ordered,
                            unit_cost_cents, total_cost_cents, notes, merchant_id
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [id, item.variation_id, item.quantity_ordered, item.unit_cost_cents, totalCost, item.notes, merchantId]);
                }

                // Update totals
                await client.query(`
                    UPDATE purchase_orders
                    SET subtotal_cents = $1, total_cents = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2 AND merchant_id = $3
                `, [subtotalCents, id, merchantId]);
            }
        });

    // Return updated PO
    const result = await db.query('SELECT * FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    res.json({
        status: 'success',
        purchase_order: result.rows[0]
    });
}));

/**
 * POST /api/purchase-orders/:id/submit
 * Submit a purchase order (change from DRAFT to SUBMITTED)
 */
router.post('/:id/submit', requireAuth, requireMerchant, validators.submitPurchaseOrder, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const merchantId = req.merchantContext.id;

    const result = await db.query(`
            UPDATE purchase_orders po
            SET
                status = 'SUBMITTED',
                order_date = COALESCE(order_date, CURRENT_DATE),
                expected_delivery_date = CURRENT_DATE + (
                    SELECT COALESCE(lead_time_days, 7) FROM vendors WHERE id = po.vendor_id AND merchant_id = $2
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'DRAFT' AND merchant_id = $2
            RETURNING *
        `, [id, merchantId]);

        if (result.rows.length === 0) {
            return res.status(400).json({
                error: 'Purchase order not found or not in DRAFT status'
            });
        }

    res.json({
        status: 'success',
        purchase_order: result.rows[0]
    });
}));

/**
 * POST /api/purchase-orders/:id/receive
 * Record received quantities for PO items
 */
router.post('/:id/receive', requireAuth, requireMerchant, validators.receivePurchaseOrder, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { items } = req.body;
    const merchantId = req.merchantContext.id;

        // Verify PO belongs to this merchant
        const poCheck = await db.query(
            'SELECT id FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
        );
        if (poCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        await db.transaction(async (client) => {
            // Update received quantities
            for (const item of items) {
                await client.query(`
                    UPDATE purchase_order_items
                    SET received_quantity = $1
                    WHERE id = $2 AND purchase_order_id = $3 AND merchant_id = $4
                `, [item.received_quantity, item.id, id, merchantId]);
            }

            // Check if all items fully received
            const checkResult = await client.query(`
                SELECT
                    COUNT(*) as total,
                    COUNT(CASE WHEN received_quantity >= quantity_ordered THEN 1 END) as received
                FROM purchase_order_items
                WHERE purchase_order_id = $1 AND merchant_id = $2
            `, [id, merchantId]);

            const { total, received } = checkResult.rows[0];

            // Update PO status if all items received
            if (parseInt(total) === parseInt(received)) {
                await client.query(`
                    UPDATE purchase_orders
                    SET status = 'RECEIVED', actual_delivery_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND merchant_id = $2
                `, [id, merchantId]);
            } else {
                await client.query(`
                    UPDATE purchase_orders
                    SET status = 'PARTIAL', updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND merchant_id = $2
                `, [id, merchantId]);
            }
        });

    // Return updated PO
    const result = await db.query('SELECT * FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    res.json({
        status: 'success',
        purchase_order: result.rows[0]
    });
}));

/**
 * DELETE /api/purchase-orders/:id
 * Delete a purchase order (only DRAFT orders can be deleted)
 */
router.delete('/:id', requireAuth, requireMerchant, validators.deletePurchaseOrder, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const merchantId = req.merchantContext.id;

        // Check if PO exists and is in DRAFT status
        const poCheck = await db.query(
            'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
        );

        if (poCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poCheck.rows[0];

        if (po.status !== 'DRAFT') {
            return res.status(400).json({
                error: 'Only draft purchase orders can be deleted',
                message: `Cannot delete ${po.status} purchase order. Only DRAFT orders can be deleted.`
            });
        }

        // Delete PO (items will be cascade deleted)
        await db.query('DELETE FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [id, merchantId]);

    res.json({
        status: 'success',
        message: `Purchase order ${po.po_number} deleted successfully`
    });
}));

/**
 * GET /api/purchase-orders/:po_number/export-csv
 * Export a purchase order in Square's CSV format
 */
router.get('/:po_number/export-csv', requireAuth, requireMerchant, validators.exportPurchaseOrderCsv, asyncHandler(async (req, res) => {
    const { po_number } = req.params;
    const merchantId = req.merchantContext.id;

        // Get PO header with vendor and location info
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name,
                l.address as location_address
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
            WHERE po.po_number = $1 AND po.merchant_id = $2
        `, [po_number, merchantId]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];

        // Get PO items with SKU, UPC (GTIN), and item names
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                v.upc as gtin,
                i.name as item_name,
                v.name as variation_name,
                vv.vendor_code
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3
            ORDER BY i.name, v.name
        `, [po.id, po.vendor_id, merchantId]);

        // Build CSV content
        const lines = [];

        // Header row - EXACT Square format (12 columns in exact order)
        lines.push('Item Name,Variation Name,SKU,GTIN,Vendor Code,Notes,Qty,Unit Price,Fee,Price w/ Fee,Amount,Status');

        // Data rows (12 fields matching header order)
        for (const item of itemsResult.rows) {
            const qty = Math.round(item.quantity_ordered || 0); // Integer
            const unitPrice = formatMoney(item.unit_cost_cents); // $105.00 format
            const fee = ''; // Blank (no fee)
            const priceWithFee = unitPrice; // Same as unit price when no fee

            // Calculate Amount = Qty * Price w/ Fee
            const unitPriceCents = item.unit_cost_cents || 0;
            const amountCents = qty * unitPriceCents;
            const amount = formatMoney(amountCents);

            const status = 'Open'; // Default status for new PO items

            const row = [
                escapeCSVField(item.item_name || ''),
                escapeCSVField(item.variation_name || ''),
                formatGTIN(item.sku), // Tab-prefixed to prevent scientific notation
                formatGTIN(item.gtin), // Tab-prefixed to prevent scientific notation
                escapeCSVField(item.vendor_code || ''),
                escapeCSVField(item.notes || ''), // Notes column (item-specific)
                qty, // Integer
                unitPrice, // $105.00
                fee, // Blank
                priceWithFee, // $105.00
                amount, // $315.00
                status // Open
            ];

            lines.push(row.join(','));
        }

        // Calculate expected delivery date (use existing or default to today + lead time)
        let expectedDeliveryDate = po.expected_delivery_date;
        if (!expectedDeliveryDate) {
            // Default: today + vendor lead time (or 7 days if no lead time set)
            const leadTimeDays = po.lead_time_days || 7;
            const deliveryDate = new Date();
            deliveryDate.setDate(deliveryDate.getDate() + leadTimeDays);
            expectedDeliveryDate = deliveryDate.toISOString();
        }

        // Add blank rows before metadata (matches Square's format)
        lines.push('');
        lines.push('');

        // Metadata rows at BOTTOM (Square's actual format)
        lines.push(`Vendor,${escapeCSVField(po.vendor_name)}`);
        lines.push('Account Number,');
        lines.push('Address,');
        lines.push('Contact,');
        lines.push('Phone Number,');
        lines.push('Email,');
        lines.push('');
        lines.push(`Ship To,${escapeCSVField(po.location_name)}`);
        lines.push(`Expected On,${formatDateForSquare(expectedDeliveryDate)}`);
        lines.push('Ordered By,');
        lines.push(`Notes,${escapeCSVField(po.notes || '')}`);


        // Join with \r\n (CRLF) line endings for maximum compatibility
        const csvLines = lines.join('\r\n') + '\r\n';

        // Add UTF-8 BOM (Byte Order Mark) for proper encoding recognition
        const csvContent = UTF8_BOM + csvLines;

        // Set response headers with cache-busting to prevent stale file issues
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        // Send CSV
        res.send(csvContent);

    logger.info('Square CSV export generated', {
        po_number: po.po_number,
        vendor: po.vendor_name,
        items: itemsResult.rows.length
    });
}));

/**
 * GET /api/purchase-orders/:po_number/export-xlsx
 * Export a purchase order as Square-compatible XLSX file
 */
router.get('/:po_number/export-xlsx', requireAuth, requireMerchant, validators.exportPurchaseOrderXlsx, asyncHandler(async (req, res) => {
    const ExcelJS = require('exceljs');
    const { po_number } = req.params;
    const merchantId = req.merchantContext.id;

        // Get PO header with vendor and location info
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
            WHERE po.po_number = $1 AND po.merchant_id = $2
        `, [po_number, merchantId]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];

        // Get PO items
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                v.upc as gtin,
                i.name as item_name,
                v.name as variation_name,
                vv.vendor_code
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3
            ORDER BY i.name, v.name
        `, [po.id, po.vendor_id, merchantId]);

        // Calculate expected delivery date
        let expectedDeliveryDate = po.expected_delivery_date;
        if (!expectedDeliveryDate) {
            const leadTimeDays = po.lead_time_days || 7;
            const deliveryDate = new Date();
            deliveryDate.setDate(deliveryDate.getDate() + leadTimeDays);
            expectedDeliveryDate = deliveryDate;
        } else {
            expectedDeliveryDate = new Date(expectedDeliveryDate);
        }

        // Create workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Sheet0');

        // Row 1: Instructions (exact text from Square template)
        worksheet.getCell('A1').value = 'Fill out the purchase order starting with the line items - then add in the vendor and destination name below. Each line item requires at least one of the following: item name, SKU, or GTIN. Quantity is also required for each item.';

        // Rows 2-3: Blank (skip)

        // Row 4: Vendor
        worksheet.getCell('A4').value = 'Vendor';
        worksheet.getCell('B4').value = po.vendor_name;

        // Row 5: Ship to
        worksheet.getCell('A5').value = 'Ship to';
        worksheet.getCell('B5').value = po.location_name;

        // Row 6: Expected On (must be Excel date)
        worksheet.getCell('A6').value = 'Expected On';
        worksheet.getCell('B6').value = expectedDeliveryDate;
        worksheet.getCell('B6').numFmt = 'm/d/yyyy'; // Format as date

        // Row 7: Notes
        worksheet.getCell('A7').value = 'Notes';
        worksheet.getCell('B7').value = po.notes || '';

        // Row 8: Blank (skip)

        // Row 9: Column Headers (EXACT order required by Square)
        const headers = ['Item Name', 'Variation Name', 'SKU', 'GTIN', 'Vendor Code', 'Notes', 'Qty', 'Unit Cost'];
        worksheet.getRow(9).values = headers;

        // Make header row bold
        worksheet.getRow(9).font = { bold: true };

        // Row 10+: Line items
        let currentRow = 10;
        for (const item of itemsResult.rows) {
            const row = worksheet.getRow(currentRow);
            row.values = [
                item.item_name || '',
                item.variation_name || '',
                item.sku || '',
                item.gtin || '',
                item.vendor_code || '',
                item.notes || '',
                Math.round(item.quantity_ordered || 0), // Integer
                (item.unit_cost_cents || 0) / 100 // Decimal (no $ symbol in Excel)
            ];

            // Format Unit Cost as currency with 2 decimals
            row.getCell(8).numFmt = '0.00';

            currentRow++;
        }

        // Auto-fit columns for readability
        worksheet.columns = [
            { key: 'itemName', width: 25 },
            { key: 'variationName', width: 20 },
            { key: 'sku', width: 15 },
            { key: 'gtin', width: 15 },
            { key: 'vendorCode', width: 15 },
            { key: 'notes', width: 20 },
            { key: 'qty', width: 8 },
            { key: 'unitCost', width: 12 }
        ];

        // Generate Excel file buffer
        const buffer = await workbook.xlsx.writeBuffer();

        // Set response headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        // Send Excel file
        res.send(buffer);

    logger.info('Square XLSX export generated', {
        po_number: po.po_number,
        vendor: po.vendor_name,
        items: itemsResult.rows.length
    });
}));

module.exports = router;
