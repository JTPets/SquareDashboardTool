-- Migration: 027_fix_index_columns.sql
-- Description: Fix column names for indexes that failed in 026
-- Created: 2026-01-26
--
-- Fixes errors from 026 where column names were incorrect:
-- - items.square_id -> items.id (already the Square ID)
-- - inventory_counts.variation_id -> inventory_counts.catalog_object_id
-- - vendors.square_vendor_id -> vendors.id (already the Square vendor ID)
-- - categories.square_id -> categories.id (already the Square ID)

-- ============================================================================
-- INVENTORY_COUNTS TABLE - Fix column name
-- ============================================================================

-- Composite index for inventory lookups by variation (catalog_object_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_merchant_catalog_obj
    ON inventory_counts(merchant_id, catalog_object_id);

-- ============================================================================
-- Note: items, vendors, categories tables use TEXT id as primary key
-- which is already the Square ID. No additional index needed since
-- primary key already provides fast lookup by id.
--
-- For merchant-scoped lookups, we can add composite indexes if needed:
-- ============================================================================

-- Items: merchant + id for scoped lookups (useful for batch operations)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_merchant_id
    ON items(merchant_id, id);

-- Vendors: merchant + id for scoped lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendors_merchant_id
    ON vendors(merchant_id, id);

-- Categories: merchant + id for scoped lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_categories_merchant_id
    ON categories(merchant_id, id);

-- ============================================================================
-- Analyze affected tables
-- ============================================================================

ANALYZE inventory_counts;
ANALYZE items;
ANALYZE vendors;
ANALYZE categories;
