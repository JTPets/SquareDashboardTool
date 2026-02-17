/**
 * Reorder Math — Shared Reorder Quantity Calculation
 *
 * Single source of truth for reorder quantity and days-of-stock formulas.
 * Used by:
 *   - routes/analytics.js        (reorder suggestions page)
 *   - services/vendor-dashboard.js (vendor dashboard reorder value)
 *
 * Current effective formula (leadTimeDays and safetyDays default to 0):
 *   threshold = supplyDays * velocity
 *
 * Full formula (when vendor config is wired):
 *   threshold = (supplyDays + leadTimeDays + safetyDays) * velocity
 *
 * @todo BACKLOG-28 Wire vendor dashboard per-vendor config
 *       (lead_time_days, target_supply_days, safety_days) into
 *       reorder.html calculations via this function.
 */

'use strict';

/**
 * Calculate suggested reorder quantity for a variation.
 *
 * @param {object} params
 * @param {number} params.velocity        - Daily avg units sold (91-day window)
 * @param {number} params.supplyDays      - Target supply days (active now)
 * @param {number} [params.leadTimeDays=0]    - Vendor lead time in days.
 *     Defaults to 0 — not yet wired from vendor config.
 *     When wired, adds buffer for delivery wait time.
 * @param {number} [params.safetyDays=0]      - Safety stock buffer in days.
 *     Defaults to 0 here; callers pass merchant setting (typically 7).
 * @param {number} [params.reorderMultiple=1] - Round up to this multiple
 * @param {number} [params.casePack=1]        - Case pack size (round up to full cases)
 * @param {number} [params.stockAlertMin=0]   - Minimum stock floor
 * @param {number|null} [params.stockAlertMax=null] - Maximum stock cap (null = unlimited)
 * @param {number} [params.currentStock=0]    - Available stock (on_hand − committed)
 * @returns {number} Suggested order quantity (≥ 0)
 */
function calculateReorderQuantity({
    velocity,
    supplyDays,
    leadTimeDays = 0,
    safetyDays = 0,
    reorderMultiple = 1,
    casePack = 1,
    stockAlertMin = 0,
    stockAlertMax = null,
    currentStock = 0
}) {
    const threshold = supplyDays + leadTimeDays + safetyDays;

    let targetQty;

    // For items with no sales velocity, use minimum reorder quantities
    if (velocity <= 0) {
        if (casePack > 1) {
            targetQty = casePack; // Order at least 1 case
        } else if (reorderMultiple > 1) {
            targetQty = reorderMultiple;
        } else {
            targetQty = 1; // Default minimum order of 1 unit
        }
    } else {
        // velocity * threshold = supply worth of inventory
        targetQty = Math.ceil(velocity * threshold);
    }

    // Ensure we order enough to exceed stock_alert_min
    if (stockAlertMin > 0) {
        targetQty = Math.max(stockAlertMin + 1, targetQty);
    }

    // Calculate suggested quantity based on available stock
    let suggestedQty = Math.ceil(Math.max(0, targetQty - currentStock));

    // Round up to case pack
    if (casePack > 1) {
        suggestedQty = Math.ceil(suggestedQty / casePack) * casePack;
    }

    // Apply reorder multiple
    if (reorderMultiple > 1) {
        suggestedQty = Math.ceil(suggestedQty / reorderMultiple) * reorderMultiple;
    }

    // Cap at max stock level (null = unlimited)
    if (stockAlertMax !== null) {
        suggestedQty = Math.ceil(Math.min(suggestedQty, stockAlertMax - currentStock));
    } else {
        suggestedQty = Math.ceil(suggestedQty);
    }

    return Math.max(0, suggestedQty);
}

/**
 * Calculate days of stock remaining.
 *
 * @param {object} params
 * @param {number} params.currentStock - Available stock (on_hand − committed)
 * @param {number} params.velocity     - Daily avg units sold
 * @returns {number} Days of stock (0 if no stock, 999 if no velocity)
 */
function calculateDaysOfStock({ currentStock, velocity }) {
    if (currentStock <= 0) return 0;
    if (velocity <= 0) return 999;
    return Math.round((currentStock / velocity) * 10) / 10;
}

module.exports = {
    calculateReorderQuantity,
    calculateDaysOfStock
};
