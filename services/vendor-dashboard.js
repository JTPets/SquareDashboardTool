/**
 * Vendor Dashboard Service
 *
 * Business logic for the vendor dashboard: computes vendor stats
 * (OOS count, reorder count, pending PO value, last ordered) and
 * derives a status for each vendor in a single query.
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
    const pendingPoValue = parseInt(vendor.pending_po_value) || 0;
    const minimumOrderAmount = parseInt(vendor.minimum_order_amount) || 0;

    if (oosCount > 0) return 'has_oos';
    if (reorderCount > 0 && pendingPoValue > 0 && minimumOrderAmount > 0 && pendingPoValue < minimumOrderAmount) return 'below_min';
    if (reorderCount > 0 && minimumOrderAmount > 0 && pendingPoValue >= minimumOrderAmount) return 'ready';
    if (reorderCount > 0) return 'needs_order';
    return 'ok';
}

/**
 * Get all vendors with dashboard stats for a merchant.
 * Single query — no N+1.
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
            -- OOS count: available <= 0 AND weekly sales velocity > 0.08 (exclude dead stock)
            COALESCE(item_stats.oos_count, 0) AS oos_count,
            -- Reorder count: items that need reordering
            COALESCE(item_stats.reorder_count, 0) AS reorder_count,
            -- Pending PO value: sum of draft/submitted PO totals
            COALESCE(po_stats.pending_po_value, 0) AS pending_po_value,
            -- Last ordered: most recent submitted/completed PO
            po_stats.last_ordered_at
        FROM vendors ve
        LEFT JOIN LATERAL (
            SELECT
                COUNT(DISTINCT vv.variation_id) AS total_items,
                COUNT(DISTINCT CASE
                    WHEN (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                         AND COALESCE(sv.weekly_avg_quantity, 0) > 0.08
                    THEN vv.variation_id
                END) AS oos_count,
                COUNT(DISTINCT CASE
                    WHEN (
                        (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= 0
                        OR (COALESCE(vls.stock_alert_min, var.stock_alert_min) IS NOT NULL
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) <= COALESCE(vls.stock_alert_min, var.stock_alert_min))
                        OR (sv.daily_avg_quantity > 0
                            AND (COALESCE(ic.quantity, 0) - COALESCE(ic_c.quantity, 0)) / sv.daily_avg_quantity < $2)
                    )
                    AND COALESCE(var.is_deleted, FALSE) = FALSE
                    AND var.discontinued = FALSE
                    THEN vv.variation_id
                END) AS reorder_count
            FROM variation_vendors vv
            JOIN variations var ON vv.variation_id = var.id AND var.merchant_id = $1
            JOIN items i ON var.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON var.id = ic.catalog_object_id AND ic.merchant_id = $1
                AND ic.state = 'IN_STOCK'
            LEFT JOIN inventory_counts ic_c ON var.id = ic_c.catalog_object_id AND ic_c.merchant_id = $1
                AND ic_c.state = 'RESERVED_FOR_SALE'
                AND ic_c.location_id = ic.location_id
            LEFT JOIN sales_velocity sv ON var.id = sv.variation_id AND sv.period_days = 91 AND sv.merchant_id = $1
                AND (sv.location_id = ic.location_id OR (sv.location_id IS NULL AND ic.location_id IS NULL))
            LEFT JOIN variation_location_settings vls ON var.id = vls.variation_id AND vls.merchant_id = $1
                AND ic.location_id = vls.location_id
            WHERE vv.vendor_id = ve.id
              AND vv.merchant_id = $1
              AND COALESCE(var.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND var.discontinued = FALSE
        ) item_stats ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                COALESCE(SUM(CASE WHEN po.status IN ('DRAFT', 'SUBMITTED') THEN po.total_cents ELSE 0 END), 0) AS pending_po_value,
                MAX(CASE WHEN po.status IN ('SUBMITTED', 'RECEIVED') THEN po.order_date ELSE NULL END) AS last_ordered_at
            FROM purchase_orders po
            WHERE po.vendor_id = ve.id AND po.merchant_id = $1
        ) po_stats ON TRUE
        WHERE ve.merchant_id = $1
          AND ve.status = 'ACTIVE'
        ORDER BY ve.name
    `, [merchantId, reorderThreshold]);

    const vendors = result.rows.map(row => ({
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
        pending_po_value: parseInt(row.pending_po_value) || 0,
        last_ordered_at: row.last_ordered_at || null,
        status: computeStatus(row)
    }));

    logger.info('Vendor dashboard loaded', {
        merchantId,
        vendorCount: vendors.length,
        actionNeeded: vendors.filter(v => v.status !== 'ok').length
    });

    return vendors;
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
