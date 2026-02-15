/**
 * Vendor Dashboard Service
 *
 * Business logic for the vendor dashboard: computes vendor stats
 * (OOS count, reorder count, pending PO value, last ordered) and
 * derives a status for each vendor in a single query.
 *
 * OOS definition aligned to main dashboard (inventory-service.js):
 *   ic.quantity = 0 where state = 'IN_STOCK', is_deleted = FALSE.
 *   No velocity filter, no committed subtraction, no discontinued filter.
 *
 * Reorder count aligned to reorder suggestions (analytics.js):
 *   Excludes items where pending PO covers the need or available >= stock_alert_max.
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

// Status priority order (for sorting)
const STATUS_PRIORITY = {
    has_oos: 0,
    below_min: 1,
    ready: 2,
    needs_order: 3,
    ok: 4
};

/**
 * Compute vendor status from stats.
 * @param {object} vendor - vendor row with computed stats
 * @returns {string} one of: has_oos, below_min, ready, needs_order, ok
 */
function computeStatus(vendor) {
    const oosCount = parseInt(vendor.oos_count) || 0;
    const reorderCount = parseInt(vendor.reorder_count) || 0;
    const reorderValue = parseInt(vendor.reorder_value) || 0;
    const costedCount = parseInt(vendor.costed_reorder_count) || 0;
    const minimumOrderAmount = parseInt(vendor.minimum_order_amount) || 0;

    if (oosCount > 0) return 'has_oos';
    // Only compare value vs minimum when we have cost data
    if (reorderCount > 0 && costedCount > 0 && minimumOrderAmount > 0 && reorderValue < minimumOrderAmount) return 'below_min';
    if (reorderCount > 0 && costedCount > 0 && minimumOrderAmount > 0 && reorderValue >= minimumOrderAmount) return 'ready';
    if (reorderCount > 0) return 'needs_order';
    return 'ok';
}

/**
 * Format a vendor row from the query result into the API response shape.
 */
function formatVendorRow(row, defaultSupplyDays) {
    return {
        id: row.id,
        name: row.name,
        schedule_type: row.schedule_type || 'anytime',
        order_day: row.order_day,
        receive_day: row.receive_day,
        lead_time_days: row.lead_time_days != null ? parseInt(row.lead_time_days) : null,
        minimum_order_amount: row.minimum_order_amount != null ? parseInt(row.minimum_order_amount) : 0,
        payment_method: row.payment_method,
        payment_terms: row.payment_terms,
        contact_email: row.contact_email,
        order_method: row.order_method,
        notes: row.notes,
        default_supply_days: row.default_supply_days != null ? parseInt(row.default_supply_days) : defaultSupplyDays,
        total_items: parseInt(row.total_items) || 0,
        oos_count: parseInt(row.oos_count) || 0,
        reorder_count: parseInt(row.reorder_count) || 0,
        reorder_value: parseInt(row.reorder_value) || 0,
        costed_reorder_count: parseInt(row.costed_reorder_count) || 0,
        pending_po_value: parseInt(row.pending_po_value) || 0,
        last_ordered_at: row.last_ordered_at || null,
        status: computeStatus(row)
    };
}

/**
 * Get all vendors with dashboard stats for a merchant.
 * Includes a synthetic "No Vendor Assigned" row for unlinked items.
 *
 * @param {number} merchantId
 * @returns {Promise<object[]>} vendors with stats and computed status
 */
async function getVendorDashboard(merchantId) {
    const merchantSettings = await db.getMerchantSettings(merchantId);
    const defaultSupplyDays = merchantSettings.default_supply_days ||
        parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45');
    const safetyDays = merchantSettings.reorder_safety_days ??
        parseInt(process.env.REORDER_SAFETY_DAYS || '7');
    const reorderThreshold = defaultSupplyDays + safetyDays;

    // --- Real vendors query ---
    const result = await db.query(`
        SELECT
            ve.id,
            ve.name,
            ve.schedule_type,
            ve.order_day,
            ve.receive_day,
            ve.lead_time_days,
            ve.minimum_order_amount,
            ve.payment_method,
            ve.payment_terms,
            ve.contact_email,
            ve.order_method,
            ve.notes,
            ve.default_supply_days,
            -- Total items linked to this vendor
            COALESCE(item_stats.total_items, 0) AS total_items,
            -- OOS: quantity = 0, aligned to main dashboard (no velocity filter)
            COALESCE(item_stats.oos_count, 0) AS oos_count,
            -- Reorder count: excludes items covered by pending POs or at/above max
            COALESCE(item_stats.reorder_count, 0) AS reorder_count,
            -- Reorder value: estimated cost of items needing reorder (unit cost sum)
            COALESCE(item_stats.reorder_value, 0) AS reorder_value,
            -- How many reorder items have cost data
            COALESCE(item_stats.costed_reorder_count, 0) AS costed_reorder_count,
            -- Pending PO value: sum of draft/submitted PO totals
            COALESCE(po_stats.pending_po_value, 0) AS pending_po_value,
            -- Last ordered: most recent submitted/completed PO
            po_stats.last_ordered_at
        FROM vendors ve
        LEFT JOIN LATERAL (
            SELECT
                COUNT(DISTINCT vv.variation_id) AS total_items,

                -- OOS: quantity = 0 with an actual inventory record
                -- Guard: ic must exist (LEFT JOIN can produce NULL rows)
                COUNT(DISTINCT CASE
                    WHEN ic.catalog_object_id IS NOT NULL
                         AND COALESCE(ic.quantity, 0) = 0
                    THEN vv.variation_id
                END) AS oos_count,

                -- Reorder count: items needing reorder after PO subtraction
                COUNT(DISTINCT CASE
                    WHEN (
                        -- Out of available stock
                        (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                        -- Below stock alert min
                        OR (COALESCE(vls.stock_alert_min, var.stock_alert_min) IS NOT NULL
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                                <= COALESCE(vls.stock_alert_min, var.stock_alert_min))
                        -- Will stockout within threshold
                        OR (sv.daily_avg_quantity > 0
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                                / sv.daily_avg_quantity < $2)
                    )
                    -- Exclude items at/above stock_alert_max (analytics.js post-filter)
                    AND (COALESCE(vls.stock_alert_max, var.stock_alert_max) IS NULL
                         OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                            < COALESCE(vls.stock_alert_max, var.stock_alert_max))
                    -- Exclude items where pending POs fully cover the need
                    AND (
                        COALESCE((
                            SELECT SUM(poi.quantity_ordered - COALESCE(poi.received_quantity, 0))
                            FROM purchase_order_items poi
                            JOIN purchase_orders po ON poi.purchase_order_id = po.id
                                AND po.merchant_id = $1
                            WHERE poi.variation_id = var.id
                              AND poi.merchant_id = $1
                              AND po.status NOT IN ('RECEIVED', 'CANCELLED')
                              AND (poi.quantity_ordered - COALESCE(poi.received_quantity, 0)) > 0
                        ), 0) = 0
                        OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                    )
                    AND COALESCE(var.is_deleted, FALSE) = FALSE
                    AND var.discontinued = FALSE
                    THEN vv.variation_id
                END) AS reorder_count,

                -- Reorder value: sum of unit cost for items needing reorder
                COALESCE(SUM(CASE
                    WHEN (
                        (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                        OR (COALESCE(vls.stock_alert_min, var.stock_alert_min) IS NOT NULL
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                                <= COALESCE(vls.stock_alert_min, var.stock_alert_min))
                        OR (sv.daily_avg_quantity > 0
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                                / sv.daily_avg_quantity < $2)
                    )
                    AND (COALESCE(vls.stock_alert_max, var.stock_alert_max) IS NULL
                         OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                            < COALESCE(vls.stock_alert_max, var.stock_alert_max))
                    AND (
                        COALESCE((
                            SELECT SUM(poi.quantity_ordered - COALESCE(poi.received_quantity, 0))
                            FROM purchase_order_items poi
                            JOIN purchase_orders po ON poi.purchase_order_id = po.id
                                AND po.merchant_id = $1
                            WHERE poi.variation_id = var.id
                              AND poi.merchant_id = $1
                              AND po.status NOT IN ('RECEIVED', 'CANCELLED')
                              AND (poi.quantity_ordered - COALESCE(poi.received_quantity, 0)) > 0
                        ), 0) = 0
                        OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                    )
                    AND COALESCE(var.is_deleted, FALSE) = FALSE
                    AND var.discontinued = FALSE
                    AND vv.unit_cost_money IS NOT NULL
                    AND vv.unit_cost_money > 0
                    THEN vv.unit_cost_money
                    ELSE 0
                END), 0) AS reorder_value,

                -- Costed item count: how many reorder items have cost data
                COUNT(DISTINCT CASE
                    WHEN (
                        (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                        OR (COALESCE(vls.stock_alert_min, var.stock_alert_min) IS NOT NULL
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                                <= COALESCE(vls.stock_alert_min, var.stock_alert_min))
                        OR (sv.daily_avg_quantity > 0
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                                / sv.daily_avg_quantity < $2)
                    )
                    AND (COALESCE(vls.stock_alert_max, var.stock_alert_max) IS NULL
                         OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                            < COALESCE(vls.stock_alert_max, var.stock_alert_max))
                    AND (
                        COALESCE((
                            SELECT SUM(poi.quantity_ordered - COALESCE(poi.received_quantity, 0))
                            FROM purchase_order_items poi
                            JOIN purchase_orders po ON poi.purchase_order_id = po.id
                                AND po.merchant_id = $1
                            WHERE poi.variation_id = var.id
                              AND poi.merchant_id = $1
                              AND po.status NOT IN ('RECEIVED', 'CANCELLED')
                              AND (poi.quantity_ordered - COALESCE(poi.received_quantity, 0)) > 0
                        ), 0) = 0
                        OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                    )
                    AND COALESCE(var.is_deleted, FALSE) = FALSE
                    AND var.discontinued = FALSE
                    AND vv.unit_cost_money IS NOT NULL
                    AND vv.unit_cost_money > 0
                    THEN vv.variation_id
                END) AS costed_reorder_count
            FROM variation_vendors vv
            JOIN variations var ON vv.variation_id = var.id AND var.merchant_id = $1
            JOIN items i ON var.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON var.id = ic.catalog_object_id AND ic.merchant_id = $1
                AND ic.state = 'IN_STOCK'
            LEFT JOIN inventory_counts ic_c ON var.id = ic_c.catalog_object_id AND ic_c.merchant_id = $1
                AND ic_c.state = 'RESERVED_FOR_SALE'
                AND ic_c.location_id = ic.location_id
            LEFT JOIN sales_velocity sv ON var.id = sv.variation_id AND sv.period_days = 91
                AND sv.merchant_id = $1
                AND (sv.location_id = ic.location_id OR (sv.location_id IS NULL AND ic.location_id IS NULL))
            LEFT JOIN variation_location_settings vls ON var.id = vls.variation_id
                AND vls.merchant_id = $1 AND ic.location_id = vls.location_id
            WHERE vv.vendor_id = ve.id
              AND vv.merchant_id = $1
              AND COALESCE(var.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
        ) item_stats ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                COALESCE(SUM(CASE WHEN po.status IN ('DRAFT', 'SUBMITTED')
                    THEN po.total_cents ELSE 0 END), 0) AS pending_po_value,
                MAX(CASE WHEN po.status IN ('SUBMITTED', 'RECEIVED')
                    THEN po.order_date ELSE NULL END) AS last_ordered_at
            FROM purchase_orders po
            WHERE po.vendor_id = ve.id AND po.merchant_id = $1
        ) po_stats ON TRUE
        WHERE ve.merchant_id = $1
          AND ve.status = 'ACTIVE'
        ORDER BY ve.name
    `, [merchantId, reorderThreshold]);

    const vendors = result.rows.map(row => formatVendorRow(row, defaultSupplyDays));

    // --- Unassigned items (no vendor linked) ---
    const unassignedResult = await db.query(`
        SELECT
            COUNT(DISTINCT v.id) AS total_items,
            COUNT(DISTINCT CASE
                WHEN ic.catalog_object_id IS NOT NULL
                     AND COALESCE(ic.quantity, 0) = 0
                THEN v.id
            END) AS oos_count,
            COUNT(DISTINCT CASE
                WHEN (
                    (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                    OR (COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                        AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                            <= COALESCE(vls.stock_alert_min, v.stock_alert_min))
                    OR (sv.daily_avg_quantity > 0
                        AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                            / sv.daily_avg_quantity < $2)
                )
                AND (COALESCE(vls.stock_alert_max, v.stock_alert_max) IS NULL
                     OR (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0))
                        < COALESCE(vls.stock_alert_max, v.stock_alert_max))
                AND COALESCE(v.is_deleted, FALSE) = FALSE
                AND v.discontinued = FALSE
                THEN v.id
            END) AS reorder_count
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $1
            AND ic.state = 'IN_STOCK'
        LEFT JOIN inventory_counts ic_c ON v.id = ic_c.catalog_object_id AND ic_c.merchant_id = $1
            AND ic_c.state = 'RESERVED_FOR_SALE'
            AND ic_c.location_id = ic.location_id
        LEFT JOIN sales_velocity sv ON v.id = sv.variation_id AND sv.period_days = 91
            AND sv.merchant_id = $1
            AND (sv.location_id = ic.location_id OR (sv.location_id IS NULL AND ic.location_id IS NULL))
        LEFT JOIN variation_location_settings vls ON v.id = vls.variation_id
            AND vls.merchant_id = $1 AND ic.location_id = vls.location_id
        WHERE v.merchant_id = $1
          AND COALESCE(v.is_deleted, FALSE) = FALSE
          AND COALESCE(i.is_deleted, FALSE) = FALSE
          AND NOT EXISTS (
              SELECT 1 FROM variation_vendors vv
              WHERE vv.variation_id = v.id AND vv.merchant_id = $1
          )
    `, [merchantId, reorderThreshold]);

    const ua = unassignedResult.rows[0];
    const unassignedTotal = parseInt(ua.total_items) || 0;

    if (unassignedTotal > 0) {
        vendors.push(formatVendorRow({
            id: '__unassigned__',
            name: 'No Vendor Assigned',
            schedule_type: null,
            order_day: null,
            receive_day: null,
            lead_time_days: null,
            minimum_order_amount: 0,
            payment_method: null,
            payment_terms: null,
            contact_email: null,
            order_method: null,
            notes: null,
            default_supply_days: null,
            total_items: ua.total_items,
            oos_count: ua.oos_count,
            reorder_count: ua.reorder_count,
            reorder_value: 0,
            costed_reorder_count: 0,
            pending_po_value: 0,
            last_ordered_at: null
        }, defaultSupplyDays));
    }

    // --- Global OOS: deduplicated count matching main dashboard (INNER JOIN) ---
    const globalOosResult = await db.query(`
        SELECT COUNT(DISTINCT v.id) AS oos_count
        FROM inventory_counts ic
        JOIN variations v ON ic.catalog_object_id = v.id AND v.merchant_id = $1
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        WHERE ic.state = 'IN_STOCK'
          AND ic.merchant_id = $1
          AND COALESCE(ic.quantity, 0) = 0
          AND COALESCE(v.is_deleted, FALSE) = FALSE
          AND COALESCE(i.is_deleted, FALSE) = FALSE
    `, [merchantId]);

    const globalOosCount = parseInt(globalOosResult.rows[0].oos_count) || 0;

    logger.info('Vendor dashboard loaded', {
        merchantId,
        vendorCount: vendors.length,
        unassignedItems: unassignedTotal,
        globalOos: globalOosCount,
        actionNeeded: vendors.filter(v => v.status !== 'ok').length
    });

    return { vendors, global_oos_count: globalOosCount };
}

/**
 * Update vendor settings (local-only fields).
 *
 * @param {string} vendorId
 * @param {number} merchantId
 * @param {object} settings
 * @returns {Promise<object>} updated vendor row
 */
async function updateVendorSettings(vendorId, merchantId, settings) {
    // Verify vendor belongs to this merchant
    const vendorCheck = await db.query(
        'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
        [vendorId, merchantId]
    );
    if (vendorCheck.rows.length === 0) {
        return null;
    }

    const allowedFields = [
        'schedule_type', 'order_day', 'receive_day', 'lead_time_days',
        'minimum_order_amount', 'payment_method', 'payment_terms',
        'contact_email', 'order_method', 'default_supply_days', 'notes'
    ];

    const setClauses = [];
    const params = [vendorId, merchantId];

    for (const field of allowedFields) {
        if (settings[field] !== undefined) {
            params.push(settings[field]);
            setClauses.push(`${field} = $${params.length}`);
        }
    }

    if (setClauses.length === 0) {
        // Nothing to update — return current vendor
        const current = await db.query(
            'SELECT * FROM vendors WHERE id = $1 AND merchant_id = $2',
            [vendorId, merchantId]
        );
        return current.rows[0];
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    const result = await db.query(
        `UPDATE vendors SET ${setClauses.join(', ')} WHERE id = $1 AND merchant_id = $2 RETURNING *`,
        params
    );

    logger.info('Vendor settings updated', {
        merchantId,
        vendorId,
        fields: Object.keys(settings).filter(k => allowedFields.includes(k))
    });

    return result.rows[0];
}

module.exports = {
    getVendorDashboard,
    updateVendorSettings,
    computeStatus,
    STATUS_PRIORITY
};
