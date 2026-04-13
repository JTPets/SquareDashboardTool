/**
 * Checkbox Defaults Service — Reorder Tier 1: Smart Checkbox Defaults
 *
 * Pure computation; no DB calls.
 * Determines the default checked state and reason for each reorder suggestion.
 *
 * Rule priority (first match wins):
 * 1. final_suggested_qty === 0    → unchecked (nothing to order)
 * 2. active_discount_tier != null → unchecked (expiry discount already active)
 * 3. !is_primary_vendor
 *      AND current_stock === 0
 *      AND pending_po_quantity === 0 → checked (out of stock, nothing incoming — can't wait)
 * 4. !is_primary_vendor           → unchecked (cheaper vendor available)
 * 5. hasExpiryRisk()              → unchecked (would overstock expiring item)
 * 6. default                      → checked
 */

'use strict';

/**
 * @param {object} item  - A reorder suggestion row from processSuggestionRows()
 * @returns {boolean}    - true if this item carries expiry risk post-reorder
 */
function hasExpiryRisk(item, merchantConfig) {
    if (item.does_not_expire || item.days_until_expiry == null) return false;
    if ((item.daily_avg_quantity || 0) <= 0) return false;

    const totalStock = (item.current_stock || 0) + (item.final_suggested_qty || 0);
    const daysToClear = totalStock / item.daily_avg_quantity;
    const expiryBuffer = merchantConfig.expiryRiskBufferDays ?? 0;

    return daysToClear > (item.days_until_expiry - expiryBuffer);
}

/**
 * Apply smart checkbox defaults to an array of reorder suggestions.
 *
 * @param {object[]} items          - Output of processSuggestionRows() (after image resolution)
 * @param {object}   merchantConfig - Merchant-level settings; supports expiryRiskBufferDays
 * @returns {object[]}              - Same items, each spread with default_checked + default_reason
 */
function calculateCheckboxDefaults(items, merchantConfig = {}) {
    return items.map(item => {
        let checked;
        let reason;

        if ((item.final_suggested_qty || 0) === 0) {
            checked = false;
            reason = 'zero_qty';
        } else if (item.active_discount_tier != null) {
            checked = false;
            reason = 'expiry_discount_active';
        } else if (!item.is_primary_vendor
                && (item.current_stock || 0) === 0
                && (item.pending_po_quantity || 0) === 0) {
            checked = true;
            reason = 'zero_stock_no_order';
        } else if (!item.is_primary_vendor) {
            checked = false;
            reason = 'cheaper_vendor_available';
        } else if (hasExpiryRisk(item, merchantConfig)) {
            checked = false;
            reason = 'expiry_risk';
        } else {
            checked = true;
            reason = 'default';
        }

        return { ...item, default_checked: checked, default_reason: reason };
    });
}

module.exports = { calculateCheckboxDefaults };
