-- Migration: 026_optimize_indexes.sql
-- Description: Add composite indexes with merchant_id as leading column for multi-tenant query optimization
-- Created: 2026-01-26
--
-- Problem: Existing indexes don't have merchant_id as leading column, causing
-- full table scans on multi-tenant queries where merchant_id is always in WHERE clause.
--
-- Note: Using CONCURRENTLY for online index creation (doesn't block writes)
-- Note: Cannot use CONCURRENTLY inside a transaction block, so no BEGIN/COMMIT

-- ============================================================================
-- VARIATIONS TABLE - Most queried table
-- ============================================================================

-- Drop existing single-column indexes that will be replaced
DROP INDEX IF EXISTS idx_variations_sku;
DROP INDEX IF EXISTS idx_variations_item_id;

-- Create optimized composite indexes (merchant_id first for partition pruning)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_variations_merchant_sku
    ON variations(merchant_id, sku);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_variations_merchant_item
    ON variations(merchant_id, item_id);

-- Covering index for common lookups (avoids heap fetch for name/item_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_variations_merchant_sku_covering
    ON variations(merchant_id, sku) INCLUDE (id, name, item_id);

-- ============================================================================
-- ITEMS TABLE
-- ============================================================================

-- Composite index for Square ID lookups (common in sync operations)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_merchant_square
    ON items(merchant_id, square_id);

-- Composite index for category filtering
DROP INDEX IF EXISTS idx_items_category;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_merchant_category
    ON items(merchant_id, category_id);

-- ============================================================================
-- INVENTORY_COUNTS TABLE
-- ============================================================================

-- Drop existing index that doesn't include merchant_id
DROP INDEX IF EXISTS idx_inventory_variation_location;

-- Composite index for inventory lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_merchant_variation
    ON inventory_counts(merchant_id, variation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_merchant_variation_location
    ON inventory_counts(merchant_id, catalog_object_id, location_id);

-- ============================================================================
-- SALES_VELOCITY TABLE
-- ============================================================================

-- Drop existing index
DROP INDEX IF EXISTS idx_sales_velocity_variation_period;

-- Composite index for velocity lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_velocity_merchant_var
    ON sales_velocity(merchant_id, variation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_velocity_merchant_var_period
    ON sales_velocity(merchant_id, variation_id, period_days);

-- ============================================================================
-- SYNC_HISTORY TABLE
-- ============================================================================

-- Composite index for sync status lookups (merchant_id + sync_type is unique)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_history_merchant_type
    ON sync_history(merchant_id, sync_type);

-- ============================================================================
-- PURCHASE_ORDERS TABLE
-- ============================================================================

-- Composite indexes for purchase order queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_purchase_orders_merchant_status
    ON purchase_orders(merchant_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_purchase_orders_merchant_date
    ON purchase_orders(merchant_id, order_date DESC);

-- ============================================================================
-- VARIATION_EXPIRATION TABLE
-- ============================================================================

-- Composite index for expiration lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_var_expiration_merchant_variation
    ON variation_expiration(merchant_id, variation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_var_expiration_merchant_date
    ON variation_expiration(merchant_id, expiration_date);

-- ============================================================================
-- VENDORS TABLE
-- ============================================================================

-- Composite index for vendor lookups by Square ID
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendors_merchant_square
    ON vendors(merchant_id, square_vendor_id);

-- ============================================================================
-- COUNT_HISTORY TABLE
-- ============================================================================

-- Composite index for count history lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_count_history_merchant_catalog
    ON count_history(merchant_id, catalog_object_id);

-- ============================================================================
-- CATEGORIES TABLE
-- ============================================================================

-- Composite index for category lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_categories_merchant_square
    ON categories(merchant_id, square_id);

-- ============================================================================
-- WEBHOOK_EVENTS TABLE (for idempotency checks)
-- ============================================================================

-- Composite index for duplicate event detection
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_events_square_id
    ON webhook_events(square_event_id) WHERE square_event_id IS NOT NULL;

-- ============================================================================
-- Analyze tables to update statistics after index changes
-- ============================================================================

ANALYZE variations;
ANALYZE items;
ANALYZE inventory_counts;
ANALYZE sales_velocity;
ANALYZE sync_history;
ANALYZE purchase_orders;
ANALYZE variation_expiration;
ANALYZE vendors;
ANALYZE count_history;
ANALYZE categories;
