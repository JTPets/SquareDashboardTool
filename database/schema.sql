-- JTPets Inventory Management System - Database Schema
-- PostgreSQL 14+

-- Drop existing tables (in reverse order of dependencies)
DROP TABLE IF EXISTS purchase_order_items CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS variation_location_settings CASCADE;
DROP TABLE IF EXISTS sales_velocity CASCADE;
DROP TABLE IF EXISTS inventory_counts CASCADE;
DROP TABLE IF EXISTS variation_vendors CASCADE;
DROP TABLE IF EXISTS variation_expiration CASCADE;
DROP TABLE IF EXISTS variations CASCADE;
DROP TABLE IF EXISTS items CASCADE;
DROP TABLE IF EXISTS images CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
DROP TABLE IF EXISTS locations CASCADE;
DROP TABLE IF EXISTS sync_history CASCADE;

-- Create tables

-- 1. Sync history tracking for smart sync optimization
CREATE TABLE sync_history (
    id SERIAL PRIMARY KEY,
    sync_type TEXT NOT NULL,  -- 'catalog', 'vendors', 'inventory', 'sales_91d', 'sales_182d', 'sales_365d'
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    status TEXT DEFAULT 'running',  -- 'running', 'success', 'failed'
    records_synced INTEGER DEFAULT 0,
    error_message TEXT,
    duration_seconds INTEGER
);

-- 2. Store locations from Square
CREATE TABLE locations (
    id TEXT PRIMARY KEY,
    name TEXT,
    square_location_id TEXT UNIQUE,
    active BOOLEAN DEFAULT TRUE,
    address TEXT,
    timezone TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Vendor/supplier information
CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    lead_time_days INTEGER DEFAULT 7,
    default_supply_days INTEGER DEFAULT 45,
    minimum_order_amount DECIMAL(10,2),
    payment_terms TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Product categories from Square
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Product images from Square
CREATE TABLE images (
    id TEXT PRIMARY KEY,
    name TEXT,
    url TEXT,
    caption TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Items (products) from Square catalog
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category_id TEXT,
    category_name TEXT,
    product_type TEXT,
    taxable BOOLEAN DEFAULT FALSE,
    visibility TEXT,
    present_at_all_locations BOOLEAN DEFAULT TRUE,
    present_at_location_ids JSONB,
    absent_at_location_ids JSONB,
    modifier_list_info JSONB,
    item_options JSONB,
    images JSONB,
    available_online BOOLEAN DEFAULT FALSE,
    available_for_pickup BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- 7. Item variations (SKUs) from Square catalog with JTPets extensions
CREATE TABLE variations (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    name TEXT,
    sku TEXT,
    upc TEXT,
    price_money INTEGER,
    currency TEXT DEFAULT 'CAD',
    pricing_type TEXT,
    track_inventory BOOLEAN DEFAULT TRUE,
    inventory_alert_type TEXT,
    inventory_alert_threshold INTEGER,
    present_at_all_locations BOOLEAN DEFAULT TRUE,
    present_at_location_ids JSONB,
    absent_at_location_ids JSONB,
    item_option_values JSONB,
    custom_attributes JSONB,
    images JSONB,
    -- JTPets custom fields
    case_pack_quantity INTEGER,
    stock_alert_min INTEGER,
    stock_alert_max INTEGER,
    preferred_stock_level INTEGER,
    shelf_location TEXT,
    bin_location TEXT,
    reorder_multiple INTEGER,
    discontinued BOOLEAN DEFAULT FALSE,
    discontinue_date DATE,
    replacement_variation_id TEXT,
    supplier_item_number TEXT,
    last_cost_cents INTEGER,
    last_cost_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY (replacement_variation_id) REFERENCES variations(id) ON DELETE SET NULL
);

-- 8. Vendor information for variations (pricing, vendor codes)
CREATE TABLE variation_vendors (
    id SERIAL PRIMARY KEY,
    variation_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    vendor_code TEXT,
    unit_cost_money INTEGER,
    currency TEXT DEFAULT 'CAD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    UNIQUE(variation_id, vendor_id)
);

-- 9. Current inventory counts from Square
CREATE TABLE inventory_counts (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    state TEXT NOT NULL,
    quantity INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    UNIQUE(catalog_object_id, location_id, state)
);

-- 10. Sales velocity calculations for demand forecasting
CREATE TABLE sales_velocity (
    id SERIAL PRIMARY KEY,
    variation_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    period_days INTEGER NOT NULL,
    total_quantity_sold DECIMAL(10,2) DEFAULT 0,
    total_revenue_cents INTEGER DEFAULT 0,
    period_start_date TIMESTAMP NOT NULL,
    period_end_date TIMESTAMP NOT NULL,
    daily_avg_quantity DECIMAL(10,4) DEFAULT 0,
    daily_avg_revenue_cents DECIMAL(10,2) DEFAULT 0,
    weekly_avg_quantity DECIMAL(10,4) DEFAULT 0,
    monthly_avg_quantity DECIMAL(10,4) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    UNIQUE(variation_id, location_id, period_days)
);

-- 11. Location-specific settings for variations
CREATE TABLE variation_location_settings (
    id SERIAL PRIMARY KEY,
    variation_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    stock_alert_min INTEGER,
    stock_alert_max INTEGER,
    preferred_stock_level INTEGER,
    shelf_location TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    UNIQUE(variation_id, location_id)
);

-- 12. Purchase orders for inventory ordering
CREATE TABLE purchase_orders (
    id SERIAL PRIMARY KEY,
    po_number TEXT UNIQUE NOT NULL,
    vendor_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    status TEXT DEFAULT 'DRAFT',
    supply_days_override INTEGER,
    order_date DATE DEFAULT CURRENT_DATE,
    expected_delivery_date DATE,
    actual_delivery_date DATE,
    subtotal_cents INTEGER DEFAULT 0,
    tax_cents INTEGER DEFAULT 0,
    shipping_cents INTEGER DEFAULT 0,
    total_cents INTEGER DEFAULT 0,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT
);

-- 13. Line items for purchase orders
CREATE TABLE purchase_order_items (
    id SERIAL PRIMARY KEY,
    purchase_order_id INTEGER NOT NULL,
    variation_id TEXT NOT NULL,
    quantity_override DECIMAL(10,2),
    quantity_ordered DECIMAL(10,2) NOT NULL,
    unit_cost_cents INTEGER NOT NULL,
    total_cost_cents INTEGER NOT NULL,
    received_quantity DECIMAL(10,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE RESTRICT
);

-- Create indexes for performance

-- Sync history lookups
CREATE INDEX idx_sync_history_type_completed ON sync_history(sync_type, completed_at DESC);

-- Variations lookups
CREATE INDEX idx_variations_sku ON variations(sku);
CREATE INDEX idx_variations_item_id ON variations(item_id);
CREATE INDEX idx_variations_discontinued ON variations(discontinued);

-- Inventory lookups
CREATE INDEX idx_inventory_variation_location ON inventory_counts(catalog_object_id, location_id);
CREATE INDEX idx_inventory_location ON inventory_counts(location_id);

-- Sales velocity lookups
CREATE INDEX idx_sales_velocity_variation_period ON sales_velocity(variation_id, period_days);
CREATE INDEX idx_sales_velocity_location ON sales_velocity(location_id);

-- Vendor relationships
CREATE INDEX idx_variation_vendors_variation ON variation_vendors(variation_id);
CREATE INDEX idx_variation_vendors_vendor ON variation_vendors(vendor_id);

-- Purchase orders
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_vendor ON purchase_orders(vendor_id);
CREATE INDEX idx_purchase_orders_location ON purchase_orders(location_id);
CREATE INDEX idx_purchase_orders_date ON purchase_orders(order_date);
CREATE INDEX idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_items_variation ON purchase_order_items(variation_id);

-- Items lookups
CREATE INDEX idx_items_category ON items(category_id);

-- Comments for documentation
COMMENT ON TABLE sync_history IS 'Tracks sync operations for smart sync optimization';
COMMENT ON TABLE locations IS 'Store locations synchronized from Square';
COMMENT ON TABLE vendors IS 'Suppliers and vendors for purchasing inventory';
COMMENT ON TABLE categories IS 'Product categories from Square catalog';
COMMENT ON TABLE images IS 'Product images from Square catalog';
COMMENT ON TABLE items IS 'Products from Square catalog';
COMMENT ON TABLE variations IS 'Product variations (SKUs) with JTPets inventory extensions';
COMMENT ON TABLE variation_vendors IS 'Vendor pricing and codes for each variation';
COMMENT ON TABLE inventory_counts IS 'Current inventory levels synchronized from Square';
COMMENT ON TABLE sales_velocity IS 'Sales velocity calculations for demand forecasting';
COMMENT ON TABLE variation_location_settings IS 'Location-specific inventory settings';
COMMENT ON TABLE purchase_orders IS 'Purchase orders for inventory replenishment';
COMMENT ON TABLE purchase_order_items IS 'Line items for purchase orders';

COMMENT ON COLUMN variations.case_pack_quantity IS 'Number of units per case for ordering full cases';
COMMENT ON COLUMN variations.stock_alert_min IS 'Minimum stock level trigger for reordering';
COMMENT ON COLUMN variations.stock_alert_max IS 'Maximum stock level to avoid overstocking';
COMMENT ON COLUMN variations.preferred_stock_level IS 'Target stock level for optimal inventory';
COMMENT ON COLUMN variations.reorder_multiple IS 'Constraint for order quantities (e.g., must order in multiples of 6)';
COMMENT ON COLUMN sales_velocity.daily_avg_quantity IS 'Average units sold per day over the period';
COMMENT ON COLUMN sales_velocity.period_days IS 'Number of days in the calculation period (91, 182, or 365)';
COMMENT ON COLUMN purchase_orders.supply_days_override IS 'Override default supply days for this specific order';

-- Grant permissions (adjust as needed for your setup)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO jtpets_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jtpets_user;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'JTPets Inventory System schema created successfully!';
    RAISE NOTICE 'Tables created: 13';
    RAISE NOTICE 'Indexes created: 19';
END $$;

-- ========================================
-- MIGRATION: Add soft delete tracking
-- ========================================
-- This migration adds support for soft deletes with automatic inventory zeroing

-- Add deleted tracking columns to items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Add deleted tracking columns to variations table  
ALTER TABLE variations ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE variations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Create indexes for efficient filtering of non-deleted items
CREATE INDEX IF NOT EXISTS idx_items_not_deleted ON items(is_deleted) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_variations_not_deleted ON variations(is_deleted) WHERE is_deleted = FALSE;

-- Add comments
COMMENT ON COLUMN items.is_deleted IS 'Soft delete flag - when TRUE, item is deleted in Square';
COMMENT ON COLUMN items.deleted_at IS 'Timestamp when item was marked as deleted';
COMMENT ON COLUMN variations.is_deleted IS 'Soft delete flag - when TRUE, variation is deleted in Square';
COMMENT ON COLUMN variations.deleted_at IS 'Timestamp when variation was marked as deleted';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Soft delete migration completed successfully!';
    RAISE NOTICE 'Added is_deleted and deleted_at columns to items and variations';
    RAISE NOTICE 'Created indexes for non-deleted items filtering';
END $$;

-- ========================================
-- MIGRATION: Add expiration date tracking
-- ========================================
-- This migration adds support for product expiration dates

-- Create variation_expiration table for tracking product expiration dates
CREATE TABLE IF NOT EXISTS variation_expiration (
    variation_id TEXT PRIMARY KEY REFERENCES variations(id) ON DELETE CASCADE,
    expiration_date TIMESTAMPTZ,
    does_not_expire BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient expiration queries
CREATE INDEX IF NOT EXISTS idx_variation_expiration_date
    ON variation_expiration(expiration_date)
    WHERE expiration_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_variation_does_not_expire
    ON variation_expiration(does_not_expire)
    WHERE does_not_expire = TRUE;

-- Add comments
COMMENT ON TABLE variation_expiration IS 'Product expiration dates for perishable items';
COMMENT ON COLUMN variation_expiration.expiration_date IS 'Expiration date for this product variation';
COMMENT ON COLUMN variation_expiration.does_not_expire IS 'Flag for products that never expire';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Expiration tracking migration completed successfully!';
    RAISE NOTICE 'Created variation_expiration table with indexes';
END $$;
