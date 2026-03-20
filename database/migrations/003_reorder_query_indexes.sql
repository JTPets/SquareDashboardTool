BEGIN;

-- Migration 003: Add composite indexes to support optimized reorder query (PERF-6)
-- The reorder LATERAL JOINs filter by (variation_id, merchant_id) on variation_vendors
-- and (variation_id, merchant_id, period_days) on sales_velocity. Existing indexes
-- don't lead with this column combination.

-- Supports primary-vendor LATERAL JOIN: WHERE variation_id = v.id AND merchant_id = $2
-- Existing UNIQUE(variation_id, vendor_id, merchant_id) has vendor_id in the middle
CREATE INDEX IF NOT EXISTS idx_variation_vendors_var_merchant
    ON variation_vendors(variation_id, merchant_id);

-- Supports sales velocity LATERAL JOIN: WHERE variation_id = v.id AND merchant_id = $2 AND period_days IN (...)
-- Existing UNIQUE(variation_id, location_id, period_days, merchant_id) has location_id second
CREATE INDEX IF NOT EXISTS idx_sales_velocity_var_merchant_period
    ON sales_velocity(variation_id, merchant_id, period_days);

-- Supports pending PO correlated subquery: WHERE poi.variation_id = v.id AND poi.merchant_id = $2
-- Existing indexes are single-column on variation_id and merchant_id separately
CREATE INDEX IF NOT EXISTS idx_poi_var_merchant
    ON purchase_order_items(variation_id, merchant_id);

COMMIT;

COMMIT;
