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
