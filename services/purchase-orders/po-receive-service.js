'use strict';

/**
 * Purchase Order Receive Service
 * Extracted from routes/purchase-orders.js receive handler.
 * Orchestrates: quantity recording, vendor cost sync, status transition, expiry re-audit flag.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// ─── Internal sub-functions ────────────────────────────────────────────────────

async function updateLineItemQuantities(client, poId, items, merchantId) {
    for (const item of items) {
        await client.query(
            'UPDATE purchase_order_items SET received_quantity = $1 WHERE id = $2 AND purchase_order_id = $3 AND merchant_id = $4',
            [item.received_quantity, item.id, poId, merchantId]
        );
    }
}

/**
 * Compare PO line-item costs against variation_vendors; upsert where different.
 * Keeps reorder page costs current with actual amounts paid.
 */
async function syncVendorCosts(client, poId, items, merchantId) {
    const { rows: poRows } = await client.query(
        'SELECT vendor_id FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
        [poId, merchantId]
    );
    const vendorId = poRows[0]?.vendor_id;
    if (!vendorId) return;

    const itemIds = items.map(i => i.id).filter(Boolean);
    const { rows: diffs } = await client.query(`
        SELECT poi.variation_id, poi.unit_cost_cents, vv.unit_cost_money AS current_vendor_cost
        FROM purchase_order_items poi
        LEFT JOIN variation_vendors vv
            ON poi.variation_id = vv.variation_id AND vv.vendor_id = $3 AND vv.merchant_id = $4
        WHERE poi.id = ANY($1) AND poi.purchase_order_id = $2 AND poi.merchant_id = $4
    `, [itemIds, poId, vendorId, merchantId]);

    for (const row of diffs) {
        if (row.unit_cost_cents !== row.current_vendor_cost) {
            await client.query(`
                INSERT INTO variation_vendors (variation_id, vendor_id, unit_cost_money, currency, merchant_id, updated_at)
                VALUES ($1, $2, $3, 'CAD', $4, CURRENT_TIMESTAMP)
                ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
                    unit_cost_money = EXCLUDED.unit_cost_money, updated_at = CURRENT_TIMESTAMP
            `, [row.variation_id, vendorId, row.unit_cost_cents, merchantId]);
        }
    }
}

/**
 * Returns 'RECEIVED' if every line item has received_quantity >= quantity_ordered, else 'PARTIAL'.
 */
async function determinePOStatus(client, poId, merchantId) {
    const { rows } = await client.query(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN received_quantity >= quantity_ordered THEN 1 END) AS received
        FROM purchase_order_items
        WHERE purchase_order_id = $1 AND merchant_id = $2
    `, [poId, merchantId]);
    return parseInt(rows[0].total) === parseInt(rows[0].received) ? 'RECEIVED' : 'PARTIAL';
}

/**
 * Flag items currently on AUTO25/AUTO50 expiry tiers for manual re-audit.
 * Non-blocking: errors are logged, not propagated. (EXPIRY-REORDER-AUDIT)
 */
async function flagExpiryItems(poId, items, merchantId) {
    const itemIds = items.map(i => i.id).filter(Boolean);
    if (!itemIds.length) return;
    try {
        const { rowCount } = await db.query(`
            UPDATE variation_discount_status
            SET needs_manual_review = TRUE, updated_at = NOW()
            WHERE variation_id IN (
                SELECT variation_id FROM purchase_order_items
                WHERE id = ANY($1) AND purchase_order_id = $2 AND merchant_id = $3
            )
              AND merchant_id = $3
              AND current_tier_id IN (
                  SELECT id FROM expiry_discount_tiers
                  WHERE tier_code IN ('AUTO25', 'AUTO50') AND merchant_id = $3
              )
              AND needs_manual_review = FALSE
        `, [itemIds, poId, merchantId]);
        if (rowCount > 0) logger.info('Flagged expiry-discounted items for re-audit after PO receiving',
            { merchantId, purchaseOrderId: poId, flaggedCount: rowCount });
    } catch (err) {
        logger.warn('Failed to flag items for expiry re-audit during PO receiving',
            { merchantId, purchaseOrderId: poId, error: err.message });
    }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Record received quantities for a SUBMITTED purchase order.
 *
 * @param {number} merchantId
 * @param {number|string} poId
 * @param {Array<{ id: number, received_quantity: number }>} items
 * @returns {Promise<object>} updated PO row
 * @throws with .statusCode 404 (not found) or 400 (not SUBMITTED)
 */
async function receiveItems(merchantId, poId, items) {
    const { rows } = await db.query(
        'SELECT id, status FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
        [poId, merchantId]
    );
    if (rows.length === 0) {
        const err = new Error('Purchase order not found');
        err.statusCode = 404;
        throw err;
    }
    if (rows[0].status !== 'SUBMITTED') {
        const err = new Error(`Purchase order is not in SUBMITTED status (current: ${rows[0].status})`);
        err.statusCode = 400;
        throw err;
    }

    await db.transaction(async (client) => {
        await updateLineItemQuantities(client, poId, items, merchantId);
        await syncVendorCosts(client, poId, items, merchantId);
        const status = await determinePOStatus(client, poId, merchantId);
        if (status === 'RECEIVED') {
            await client.query(
                "UPDATE purchase_orders SET status = 'RECEIVED', actual_delivery_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND merchant_id = $2",
                [poId, merchantId]
            );
        } else {
            await client.query(
                "UPDATE purchase_orders SET status = 'PARTIAL', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND merchant_id = $2",
                [poId, merchantId]
            );
        }
    });

    await flagExpiryItems(poId, items, merchantId);

    const { rows: poRows } = await db.query(
        'SELECT * FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
        [poId, merchantId]
    );
    return poRows[0];
}

module.exports = { receiveItems };
