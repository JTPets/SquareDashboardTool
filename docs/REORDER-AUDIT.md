# Reorder Suggestions System Audit

## Surface Area

File: services/catalog/reorder-service.js
Lines: 819
Exports: getReorderSuggestions, buildMainQuery, processSuggestionRows, sortSuggestions, runBundleAnalysis, fetchOtherVendorItems

File: services/catalog/reorder-math.js
Lines: 108
Exports: calculateReorderQuantity, calculateDaysOfStock

File: routes/analytics.js (reorder-related routes only)
Routes:
- GET /api/reorder-suggestions — Calculate reorder suggestions based on sales velocity

File: public/reorder.html
Lines: 918

File: public/js/reorder.js
Lines: 2348

## Query Structure

Builder function: `buildMainQuery` (reorder-service.js:138)

### Base Table

`variations v` — one row per variation/location combination (via inventory_counts)

### JOINs

```
variations v
├─ JOIN items i                          ON v.item_id = i.id AND i.merchant_id = $2
│    (item name, category; filters out deleted items)
├─ LEFT JOIN variation_vendors vv        ON v.id = vv.variation_id AND vv.merchant_id = $2
│    (current vendor assignment: vendor_code, unit_cost — multi-row; filtered by vendor_id param)
├─ LEFT JOIN vendors ve                  ON vv.vendor_id = ve.id AND ve.merchant_id = $2
│    (vendor name, lead_time_days, default_supply_days)
├─ LEFT JOIN inventory_counts ic         ON v.id = ic.catalog_object_id AND ic.merchant_id = $2
│    AND ic.state = 'IN_STOCK'
│    (on-hand quantity per location; drives one row per location)
├─ LEFT JOIN LATERAL (sales_velocity)    WHERE variation_id = v.id AND merchant_id = $2
│    AND period_days IN (91, 182, 365)
│    AND location_id matches ic.location_id
│    → collapses 3 period rows into one via conditional aggregation
│    Columns: daily_avg_quantity, weekly_avg_91d, weekly_avg_182d, weekly_avg_365d
├─ LEFT JOIN inventory_counts ic_committed  ON v.id = ic_committed.catalog_object_id AND ic_committed.merchant_id = $2
│    AND ic_committed.state = 'RESERVED_FOR_SALE'
│    AND ic_committed.location_id = ic.location_id
│    (committed/reserved qty at same location)
├─ LEFT JOIN locations l                 ON ic.location_id = l.id AND l.merchant_id = $2
│    (location display name)
├─ LEFT JOIN variation_location_settings vls  ON v.id = vls.variation_id AND vls.merchant_id = $2
│    AND ic.location_id = vls.location_id
│    (per-location stock_alert_min/max overrides)
├─ LEFT JOIN variation_expiration vexp   ON v.id = vexp.variation_id AND vexp.merchant_id = $2
│    (expiration_date, does_not_expire flag)
└─ LEFT JOIN LATERAL (variation_vendors vv2 + vendors ve2)  WHERE vv2.variation_id = v.id AND vv2.merchant_id = $2
     ORDER BY unit_cost_money ASC, created_at ASC LIMIT 1
     → cheapest/earliest primary vendor (replaces 3 correlated subqueries)
     Columns: primary_vendor_id, primary_vendor_name, primary_vendor_cost
```

`pending_po_quantity` is a correlated subquery inline in SELECT:
`purchase_order_items poi JOIN purchase_orders po` — sums unreceived quantity for non-RECEIVED/CANCELLED POs.

### WHERE Clauses

Fixed filters (always applied):
- `v.merchant_id = $2`
- `v.discontinued = FALSE`
- `COALESCE(v.is_deleted, FALSE) = FALSE`
- `COALESCE(i.is_deleted, FALSE) = FALSE`

Reorder inclusion — OR of three conditions:
1. Available stock ≤ 0 (out of stock; available = on_hand − committed)
2. Available stock ≤ stock_alert_min (at or below alert threshold)
3. `daily_avg_quantity > 0` AND `available / daily_avg_quantity < $1 + COALESCE(ve.lead_time_days, 0)` — will stock out within `supply_days + safety_days + lead_time` days

Dynamic filters (appended if params present):
- `vendor_id = 'none'` → `vv.vendor_id IS NULL`
- `vendor_id` set → `vv.vendor_id = $N`
- `location_id` set → `ic.location_id = $N OR ic.location_id IS NULL`

### Aggregates / GROUP BY

None — no GROUP BY. The LATERAL join on `sales_velocity` uses `MAX(CASE WHEN period_days = N ...)` to pivot three period rows into one row without a GROUP BY on the outer query.

### Returned Columns

| Column | Source |
|--------|--------|
| variation_id | v.id |
| item_name | i.name |
| variation_name | v.name |
| sku | v.sku |
| images, item_images | v.images, i.images |
| category_name | i.category_name |
| location_id, location_name | ic.location_id, l.name |
| current_stock | COALESCE(ic.quantity, 0) |
| committed_quantity | COALESCE(ic_committed.quantity, 0) |
| available_quantity | current_stock − committed_quantity |
| daily_avg_quantity, weekly_avg_91d/182d/365d | LATERAL sv |
| expiration_date, does_not_expire, days_until_expiry | vexp |
| vendor_name, vendor_code, current_vendor_id, unit_cost_cents | ve, vv |
| primary_vendor_id/name/cost | LATERAL pv |
| pending_po_quantity | correlated subquery on purchase_order_items |
| case_pack_quantity, reorder_multiple, retail_price_cents | v |
| stock_alert_min, stock_alert_max, preferred_stock_level | COALESCE(vls, v) |
| lead_time_days, default_supply_days | ve |
| days_until_stockout | CASE on available / daily_avg |
| base_suggested_qty | daily_avg_quantity × $1 (supply_days + safety_days) |
| below_minimum | CASE on available vs stock_alert_min |
| variation_age_days | EXTRACT(DAY FROM NOW() − v.created_at) |

## Silent Exclusion Points

All four are `return null` inside `processSuggestionRows` (reorder-service.js:302), collected by `.filter(item => item !== null)` at line 445. One additional filter runs after the function returns.

---

**1. Line 322–324 — Already at or above stock_alert_max**

```javascript
if (stockAlertMax !== null && availableQty >= stockAlertMax) return null;
```

Why: Available stock already meets or exceeds the configured maximum; ordering more would overshoot the ceiling.
Intentional: YES — correct guard against over-ordering.
Note: `stockAlertMax` is `null` when no max is configured, so this check is skipped entirely for items with no max set. Items with `stock_alert_max = 0` set in the DB would suppress all suggestions for that item — but that's an unlikely config.

---

**2. Line 330–332 — Velocity/threshold recheck**

```javascript
const reorderThreshold = supplyDaysNum + leadTime + safetyDays;
const needsReorder = isOutOfStock || row.below_minimum || daysUntilStockout < reorderThreshold;
if (!needsReorder) return null;
```

Why: The SQL WHERE uses `$1 + COALESCE(ve.lead_time_days, 0)` where `$1 = supply_days + safety_days`. The JS recalculates with the same components. In theory these should agree, but the JS check acts as a safety net for any rows that slipped through.
Intentional: YES — defensive duplicate of the SQL filter.
Divergence risk: If `leadTime` parsed in JS (line 318: `parseInt(row.lead_time_days) || 0`) ever differs from the SQL `COALESCE(ve.lead_time_days, 0)` (e.g. due to type coercion differences), a row could pass the SQL filter but be silently dropped here. No known instance, but the dual calculation is a latent inconsistency.

---

**3. Line 376–378 — calculateReorderQuantity returned 0**

```javascript
if (finalQty <= 0) return null;
```

Why: `calculateReorderQuantity` (reorder-math.js) returned zero or negative after accounting for case-pack rounding, reorder multiples, and current available stock vs. max. This means the math determined nothing needs to be ordered.
Intentional: YES — no actionable suggestion to surface.
Note: This can silently drop an out-of-stock or below-minimum item if the math produces 0. For example, if `stock_alert_max` is very low and available stock already covers `supply_days` worth of demand even at zero, the result could be 0. Worth verifying `calculateReorderQuantity` handles the out-of-stock + no-velocity case explicitly.

---

**4. Line 393–395 — Pending PO already covers the order quantity**

```javascript
const adjustedQty = Math.max(0, finalQty - pendingPoQty);
if (adjustedQty <= 0 && !row.below_minimum) return null;
```

Why: Outstanding purchase orders already cover the full suggested quantity, and the item is not currently below its alert threshold. Nothing more needs to be ordered right now.
Intentional: YES — avoids duplicate ordering when a PO is already in flight.
Exception built-in: `below_minimum` items are exempt from this filter (comment at line 391: "Stock is below threshold right now and the PO may not arrive for days"). These still surface with `final_suggested_qty = 0` and `order_cost = 0`, which is correct for visibility but could confuse users who see a suggestion with nothing to order.

---

**5. Post-function filter — min_cost (getReorderSuggestions line 91–94)**

```javascript
if (min_cost) {
    filteredSuggestions = suggestions.filter(s => s.order_cost >= minCostNum);
}
```

Why: Caller-supplied query param drops suggestions below a cost threshold.
Intentional: YES — UI feature to hide trivial reorders.
Note: `order_cost` is based on `adjustedQty` (after PO deduction), so an item with a pending PO that reduces `adjustedQty` to 0 will have `order_cost = 0` and will be dropped by any non-zero `min_cost` filter — even if it was kept by exclusion point 4 above due to `below_minimum`. The `below_minimum` exemption in point 4 is effectively overridden by `min_cost > 0`.

---

### Exclusion Summary

| # | Location | Condition | Items affected |
|---|----------|-----------|----------------|
| 1 | line 322 | `availableQty >= stockAlertMax` | Items already overstocked |
| 2 | line 330 | `!needsReorder` (JS threshold recheck) | Rows that passed SQL but fail JS recalc |
| 3 | line 376 | `finalQty <= 0` | Items where math yields nothing to order |
| 4 | line 393 | `adjustedQty <= 0 && !below_minimum` | Items fully covered by pending POs |
| 5 | line 91 | `order_cost < min_cost` | Below cost threshold (caller param) |
