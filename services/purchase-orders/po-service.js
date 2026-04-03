'use strict';

/**
 * Purchase Order Service — CRUD and status transitions.
 * Extracted from routes/purchase-orders.js.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { clearExpiryDiscountForReorder, applyDiscounts } = require('../expiry/discount-service');
const { getLocationById } = require('../catalog/location-service');

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function calculateSubtotal(items) {
    return items.reduce((sum, i) => sum + i.quantity_ordered * i.unit_cost_cents, 0);
}

/**
 * Returns { ok: true } or { ok: false, shortfallCents, minimumCents, subtotalCents }.
 */
function validateVendorMinimum(vendor, subtotalCents) {
    const min = vendor.minimum_order_amount ? Math.round(Number(vendor.minimum_order_amount)) : null;
    if (!min || min <= 0 || subtotalCents >= min) return { ok: true };
    return { ok: false, shortfallCents: min - subtotalCents, minimumCents: min, subtotalCents };
}

async function generatePoNumber(merchantId) {
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const { rows } = await db.query(
        "SELECT COUNT(*) as count FROM purchase_orders WHERE po_number LIKE $1 AND merchant_id = $2",
        [`PO-${dateStr}-%`, merchantId]
    );
    return `PO-${dateStr}-${(parseInt(rows[0].count) + 1).toString().padStart(3, '0')}`;
}

function clientError(message, statusCode, code) {
    const err = new Error(message);
    err.statusCode = statusCode;
    if (code) err.code = code;
    return err;
}

// ─── Internal: expiry clear after PO creation ─────────────────────────────────

async function clearExpiryDiscountsForItems(merchantId, variationIds) {
    const { rows } = await db.query(`
        SELECT vds.variation_id, edt.tier_code, i.name as item_name, v.name as variation_name
        FROM variation_discount_status vds
        JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
        JOIN variations v ON vds.variation_id = v.id AND v.merchant_id = $1
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        WHERE vds.variation_id = ANY($2) AND vds.merchant_id = $1
          AND edt.is_auto_apply = TRUE AND edt.tier_code IN ('AUTO50', 'AUTO25', 'EXPIRED')
    `, [merchantId, variationIds]);

    const cleared = [];
    const tiers = new Set();
    for (const item of rows) {
        try {
            const result = await clearExpiryDiscountForReorder(merchantId, item.variation_id);
            if (result.cleared) {
                cleared.push({ variation_id: item.variation_id, item_name: item.item_name,
                    variation_name: item.variation_name, previous_tier: result.previousTier });
                tiers.add(result.previousTier);
            }
        } catch (err) {
            logger.error('Failed to clear expiry discount during PO creation',
                { merchantId, variationId: item.variation_id, error: err.message });
        }
    }

    if (cleared.length > 0) {
        logger.info('Triggering applyDiscounts after reorder expiry clear',
            { merchantId, clearedCount: cleared.length, affectedTiers: Array.from(tiers) });
        applyDiscounts({ merchantId, dryRun: false }).catch(err =>
            logger.error('Background applyDiscounts failed after reorder', { merchantId, error: err.message })
        );
    }
    return cleared;
}

// ─── Service functions ─────────────────────────────────────────────────────────

async function listPurchaseOrders(merchantId, { status, vendorId } = {}) {
    let query = `
        SELECT po.*, v.name as vendor_name, l.name as location_name, COUNT(poi.id) as item_count
        FROM purchase_orders po
        JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $1
        JOIN locations l ON po.location_id = l.id AND l.merchant_id = $1
        LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id AND poi.merchant_id = $1
        WHERE po.merchant_id = $1
    `;
    const params = [merchantId];
    if (status) { params.push(status); query += ` AND po.status = $${params.length}`; }
    if (vendorId) { params.push(vendorId); query += ` AND po.vendor_id = $${params.length}`; }
    query += ' GROUP BY po.id, v.name, l.name ORDER BY po.created_at DESC';
    const { rows } = await db.query(query, params);
    return rows;
}

async function getPurchaseOrder(merchantId, poId) {
    const poResult = await db.query(`
        SELECT po.*, v.name as vendor_name, v.lead_time_days, l.name as location_name
        FROM purchase_orders po
        JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
        JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
        WHERE po.id = $1 AND po.merchant_id = $2
    `, [poId, merchantId]);
    if (poResult.rows.length === 0) return null;

    const po = poResult.rows[0];
    const itemsResult = await db.query(`
        SELECT poi.*, v.sku, v.upc as gtin, i.name as item_name, v.name as variation_name, vv.vendor_code
        FROM purchase_order_items poi
        JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $2
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $3 AND vv.merchant_id = $2
        WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $2
        ORDER BY i.name, v.name
    `, [poId, merchantId, po.vendor_id]);
    po.items = itemsResult.rows;
    return po;
}

async function createPurchaseOrder(merchantId, { vendorId, locationId, supplyDaysOverride, notes, createdBy, items, force }) {
    const validItems = items.filter(item => item.quantity_ordered > 0);
    if (validItems.length === 0)
        throw clientError('No items with valid quantities. All items have zero or negative quantity.', 400);

    const vendorResult = await db.query(
        'SELECT id, minimum_order_amount FROM vendors WHERE id = $1 AND merchant_id = $2',
        [vendorId, merchantId]
    );
    if (vendorResult.rows.length === 0)
        throw clientError('Invalid vendor or vendor does not belong to this merchant', 403);

    // Vendor minimum check (BACKLOG-91)
    const subtotalCents = calculateSubtotal(validItems);
    const minCheck = validateVendorMinimum(vendorResult.rows[0], subtotalCents);
    let minimumWarning = null;
    if (!minCheck.ok) {
        if (!force) throw clientError(
            `Order total ($${(minCheck.subtotalCents / 100).toFixed(2)}) is below vendor minimum ($${(minCheck.minimumCents / 100).toFixed(2)}). Shortfall: $${(minCheck.shortfallCents / 100).toFixed(2)}. Pass force: true to proceed anyway.`,
            400, 'BELOW_VENDOR_MINIMUM'
        );
        minimumWarning = {
            message: `Order is $${(minCheck.shortfallCents / 100).toFixed(2)} below $${(minCheck.minimumCents / 100).toFixed(2)} vendor minimum`,
            subtotal_cents: minCheck.subtotalCents, minimum_cents: minCheck.minimumCents, shortfall_cents: minCheck.shortfallCents
        };
    }

    const location = await getLocationById(merchantId, locationId);
    if (!location)
        throw clientError('Invalid location or location does not belong to this merchant', 403);

    const poNumber = await generatePoNumber(merchantId);

    const po = await db.transaction(async (client) => {
        const { rows } = await client.query(`
            INSERT INTO purchase_orders (
                po_number, vendor_id, location_id, status, supply_days_override,
                subtotal_cents, total_cents, notes, created_by, merchant_id
            ) VALUES ($1,$2,$3,'DRAFT',$4,$5,$5,$6,$7,$8) RETURNING *
        `, [poNumber, vendorId, locationId, supplyDaysOverride, subtotalCents, notes, createdBy, merchantId]);

        const createdPo = rows[0];
        const batchValues = [];
        const placeholders = validItems.map((item, i) => {
            const o = i * 8;
            batchValues.push(createdPo.id, item.variation_id, item.quantity_override || null,
                item.quantity_ordered, item.unit_cost_cents, item.quantity_ordered * item.unit_cost_cents,
                item.notes || null, merchantId);
            return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8})`;
        }).join(',');
        await client.query(`
            INSERT INTO purchase_order_items (
                purchase_order_id, variation_id, quantity_override,
                quantity_ordered, unit_cost_cents, total_cost_cents, notes, merchant_id
            ) VALUES ${placeholders}
        `, batchValues);
        return createdPo;
    });

    const variationIds = validItems.map(i => i.variation_id);
    const clearedExpiryItems = await clearExpiryDiscountsForItems(merchantId, variationIds);
    return { po, clearedExpiryItems, minimumWarning };
}

async function updatePurchaseOrder(merchantId, poId, { supplyDaysOverride, notes, items }) {
    const { rows: check } = await db.query(
        'SELECT status FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [poId, merchantId]
    );
    if (check.length === 0) throw clientError('Purchase order not found', 404);
    if (check[0].status !== 'DRAFT') throw clientError('Only draft purchase orders can be updated', 400);

    await db.transaction(async (client) => {
        const setClauses = [];
        const vals = [];
        let p = 1;
        if (supplyDaysOverride !== undefined) { setClauses.push(`supply_days_override = $${p++}`); vals.push(supplyDaysOverride); }
        if (notes !== undefined) { setClauses.push(`notes = $${p++}`); vals.push(notes); }
        if (setClauses.length > 0) {
            setClauses.push('updated_at = CURRENT_TIMESTAMP');
            vals.push(poId, merchantId);
            await client.query(`UPDATE purchase_orders SET ${setClauses.join(', ')} WHERE id = $${p} AND merchant_id = $${p+1}`, vals);
        }

        if (items) {
            await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1 AND merchant_id = $2', [poId, merchantId]);
            const subtotalCents = calculateSubtotal(items);
            const batchValues = [];
            const placeholders = items.map((item, i) => {
                const o = i * 7;
                batchValues.push(poId, item.variation_id, item.quantity_ordered,
                    item.unit_cost_cents, item.quantity_ordered * item.unit_cost_cents, item.notes || null, merchantId);
                return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7})`;
            }).join(',');
            await client.query(`
                INSERT INTO purchase_order_items (
                    purchase_order_id, variation_id, quantity_ordered,
                    unit_cost_cents, total_cost_cents, notes, merchant_id
                ) VALUES ${placeholders}
            `, batchValues);
            await client.query(
                'UPDATE purchase_orders SET subtotal_cents = $1, total_cents = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND merchant_id = $3',
                [subtotalCents, poId, merchantId]
            );
        }
    });

    const { rows } = await db.query('SELECT * FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [poId, merchantId]);
    return rows[0];
}

async function submitPurchaseOrder(merchantId, poId) {
    const { rows } = await db.query(`
        UPDATE purchase_orders po
        SET status = 'SUBMITTED',
            order_date = COALESCE(order_date, CURRENT_DATE),
            expected_delivery_date = CURRENT_DATE + (
                SELECT COALESCE(lead_time_days, 7) FROM vendors WHERE id = po.vendor_id AND merchant_id = $2
            ),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'DRAFT' AND merchant_id = $2
        RETURNING *
    `, [poId, merchantId]);
    if (rows.length === 0) throw clientError('Purchase order not found or not in DRAFT status', 400);
    return rows[0];
}

async function deletePurchaseOrder(merchantId, poId) {
    const { rows } = await db.query(
        'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
        [poId, merchantId]
    );
    if (rows.length === 0) throw clientError('Purchase order not found', 404);
    if (rows[0].status !== 'DRAFT')
        throw clientError(`Only draft purchase orders can be deleted. Cannot delete ${rows[0].status} purchase order.`, 400);
    await db.query('DELETE FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [poId, merchantId]);
    return { poNumber: rows[0].po_number };
}

module.exports = {
    calculateSubtotal,
    validateVendorMinimum,
    generatePoNumber,
    listPurchaseOrders,
    getPurchaseOrder,
    createPurchaseOrder,
    updatePurchaseOrder,
    submitPurchaseOrder,
    deletePurchaseOrder,
};
