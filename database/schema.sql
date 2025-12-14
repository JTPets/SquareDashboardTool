-- Square Dashboard Addon Tool - Database Schema
-- PostgreSQL 14+

-- Drop existing tables (in reverse order of dependencies)
DROP TABLE IF EXISTS purchase_order_items CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS count_sessions CASCADE;
DROP TABLE IF EXISTS count_queue_daily CASCADE;
DROP TABLE IF EXISTS count_queue_priority CASCADE;
DROP TABLE IF EXISTS count_history CASCADE;
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
    tax_ids JSONB,
    visibility TEXT,
    present_at_all_locations BOOLEAN DEFAULT TRUE,
    present_at_location_ids JSONB,
    absent_at_location_ids JSONB,
    modifier_list_info JSONB,
    item_options JSONB,
    images JSONB,
    available_online BOOLEAN DEFAULT FALSE,
    available_for_pickup BOOLEAN DEFAULT FALSE,
    seo_title TEXT,
    seo_description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- 7. Item variations (SKUs) from Square catalog with custom extensions
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
    -- Custom fields for inventory management
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
COMMENT ON TABLE variations IS 'Product variations (SKUs) with inventory extensions';
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
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Square Dashboard Addon Tool schema created successfully!';
    RAISE NOTICE 'Core tables created: 13';
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

-- Backfill existing rows with FALSE for is_deleted (for rows that existed before migration)
UPDATE items SET is_deleted = FALSE WHERE is_deleted IS NULL;
UPDATE variations SET is_deleted = FALSE WHERE is_deleted IS NULL;

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

-- ========================================
-- MIGRATION: Add Cycle Count System
-- ========================================
-- Tracks cycle counting history, priority queues, and daily batches

-- Table to track when each item was last counted
CREATE TABLE IF NOT EXISTS count_history (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL UNIQUE,
    last_counted_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counted_by TEXT,
    is_accurate BOOLEAN DEFAULT NULL,
    actual_quantity INTEGER DEFAULT NULL,
    expected_quantity INTEGER DEFAULT NULL,
    variance INTEGER DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_count_history_catalog_id ON count_history(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_history_last_counted ON count_history(last_counted_date DESC);
CREATE INDEX IF NOT EXISTS idx_count_history_accuracy ON count_history(is_accurate) WHERE is_accurate = FALSE;

-- Table for priority queue ("Send Now" items)
CREATE TABLE IF NOT EXISTS count_queue_priority (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    added_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_by TEXT,
    notes TEXT,
    completed BOOLEAN DEFAULT FALSE,
    completed_date TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_count_queue_catalog_id ON count_queue_priority(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_completed ON count_queue_priority(completed) WHERE completed = FALSE;

-- Table for daily batch queue (accumulates uncompleted items)
CREATE TABLE IF NOT EXISTS count_queue_daily (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    batch_date DATE NOT NULL DEFAULT CURRENT_DATE,
    added_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed BOOLEAN DEFAULT FALSE,
    completed_date TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE,
    UNIQUE(catalog_object_id, batch_date)
);

CREATE INDEX IF NOT EXISTS idx_count_queue_daily_catalog_id ON count_queue_daily(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_batch_date ON count_queue_daily(batch_date DESC);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_completed ON count_queue_daily(completed) WHERE completed = FALSE;

-- Table to track count sessions for reporting
CREATE TABLE IF NOT EXISTS count_sessions (
    id SERIAL PRIMARY KEY,
    session_date DATE NOT NULL DEFAULT CURRENT_DATE,
    items_expected INTEGER NOT NULL DEFAULT 0,
    items_completed INTEGER NOT NULL DEFAULT 0,
    completion_rate DECIMAL(5,2),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_count_sessions_date ON count_sessions(session_date DESC);

-- Comments for documentation
COMMENT ON TABLE count_history IS 'Tracks when each variation was last cycle counted';
COMMENT ON TABLE count_queue_priority IS 'Priority queue for immediate cycle count requests (Send Now)';
COMMENT ON TABLE count_queue_daily IS 'Daily batch queue for cycle counts - accumulates uncompleted items across days';
COMMENT ON TABLE count_sessions IS 'Tracks daily cycle count sessions and completion rates';

COMMENT ON COLUMN count_history.catalog_object_id IS 'Reference to variations.id';
COMMENT ON COLUMN count_history.last_counted_date IS 'Timestamp when item was last counted';
COMMENT ON COLUMN count_history.counted_by IS 'User/system that performed the count';
COMMENT ON COLUMN count_history.is_accurate IS 'Whether the physical count matched the system count';
COMMENT ON COLUMN count_history.actual_quantity IS 'The actual physical count performed by staff';
COMMENT ON COLUMN count_history.expected_quantity IS 'The system inventory count at time of cycle count';
COMMENT ON COLUMN count_history.variance IS 'Difference between actual and expected (actual - expected)';

COMMENT ON COLUMN count_queue_priority.catalog_object_id IS 'Reference to variations.id for priority counting';
COMMENT ON COLUMN count_queue_priority.added_by IS 'User who requested priority count';
COMMENT ON COLUMN count_queue_priority.completed IS 'Whether this priority item has been counted';

COMMENT ON COLUMN count_queue_daily.batch_date IS 'The date this item was added to the batch';
COMMENT ON COLUMN count_queue_daily.completed IS 'Whether this item has been counted';

COMMENT ON COLUMN count_sessions.items_expected IS 'Number of items expected to be counted';
COMMENT ON COLUMN count_sessions.items_completed IS 'Number of items actually counted';
COMMENT ON COLUMN count_sessions.completion_rate IS 'Percentage of expected items completed';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Cycle count system migration completed successfully!';
    RAISE NOTICE 'Created 4 new tables: count_history, count_queue_priority, count_queue_daily, count_sessions';
END $$;

-- ========================================
-- MIGRATION: Add SEO and tax fields
-- ========================================
-- Adds tax_ids, seo_title, and seo_description from Square API

-- Add tax_ids column to items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS tax_ids JSONB;

-- Add SEO fields to items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS seo_title TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS seo_description TEXT;

-- Add comments
COMMENT ON COLUMN items.tax_ids IS 'Array of tax IDs applied to this item from Square';
COMMENT ON COLUMN items.seo_title IS 'SEO page title from Square ecom_seo_data';
COMMENT ON COLUMN items.seo_description IS 'SEO page description from Square ecom_seo_data';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'SEO and tax fields migration completed successfully!';
    RAISE NOTICE 'Added columns: tax_ids, seo_title, seo_description to items table';
END $$;

-- ========================================
-- MIGRATION: Add Vendor Catalog Import System
-- ========================================
-- Stores imported vendor catalogs for rapid lookup and margin tracking

-- Create vendor_catalog_items table for storing imported vendor product catalogs
CREATE TABLE IF NOT EXISTS vendor_catalog_items (
    id SERIAL PRIMARY KEY,
    vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    vendor_name TEXT NOT NULL,                    -- Denormalized for quick lookup
    vendor_item_number TEXT NOT NULL,             -- Vendor's SKU/part number
    product_name TEXT NOT NULL,                   -- Product name from vendor
    upc TEXT,                                     -- UPC/GTIN for matching
    cost_cents INTEGER NOT NULL,                  -- Vendor cost in cents
    price_cents INTEGER,                          -- Suggested retail price in cents
    -- Calculated fields
    margin_percent DECIMAL(5,2),                  -- Calculated margin percentage
    -- Matching to our catalog
    matched_variation_id TEXT REFERENCES variations(id) ON DELETE SET NULL,
    match_method TEXT,                            -- How it was matched: 'upc', 'vendor_item_number', 'manual', null
    -- Import tracking
    import_batch_id TEXT,                         -- Groups items from same import
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Ensure unique vendor item per vendor per batch (allows updates)
    UNIQUE(vendor_id, vendor_item_number, import_batch_id)
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_vendor ON vendor_catalog_items(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_upc ON vendor_catalog_items(upc) WHERE upc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_vendor_item ON vendor_catalog_items(vendor_item_number);
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_matched ON vendor_catalog_items(matched_variation_id) WHERE matched_variation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_batch ON vendor_catalog_items(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_imported ON vendor_catalog_items(imported_at DESC);

-- Comments for documentation
COMMENT ON TABLE vendor_catalog_items IS 'Imported vendor product catalogs for lookup and margin tracking';
COMMENT ON COLUMN vendor_catalog_items.vendor_item_number IS 'Vendor SKU/part number for this product';
COMMENT ON COLUMN vendor_catalog_items.upc IS 'UPC/GTIN barcode for matching to our catalog';
COMMENT ON COLUMN vendor_catalog_items.cost_cents IS 'Vendor cost to us in cents';
COMMENT ON COLUMN vendor_catalog_items.price_cents IS 'Suggested retail price in cents';
COMMENT ON COLUMN vendor_catalog_items.margin_percent IS 'Calculated margin: ((price - cost) / price) * 100';
COMMENT ON COLUMN vendor_catalog_items.matched_variation_id IS 'Link to our catalog variation if matched';
COMMENT ON COLUMN vendor_catalog_items.match_method IS 'How the match was made: upc, vendor_item_number, manual';
COMMENT ON COLUMN vendor_catalog_items.import_batch_id IS 'Groups items from the same import operation';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Vendor catalog import migration completed successfully!';
    RAISE NOTICE 'Created vendor_catalog_items table with indexes';
END $$;

-- ========================================
-- MIGRATION: Google Merchant Center Feed Support
-- ========================================
-- This migration adds tables to support Google Merchant Center product feeds

-- 1. Brands table - store product brands
CREATE TABLE IF NOT EXISTS brands (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    logo_url TEXT,
    website TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Google Taxonomy - master list of Google product categories
CREATE TABLE IF NOT EXISTS google_taxonomy (
    id INTEGER PRIMARY KEY,  -- Google's taxonomy ID
    name TEXT NOT NULL,      -- Full path name like "Animals & Pet Supplies > Pet Supplies > Dog Supplies"
    parent_id INTEGER REFERENCES google_taxonomy(id),
    level INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Category to Google Taxonomy mapping
CREATE TABLE IF NOT EXISTS category_taxonomy_mapping (
    id SERIAL PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    google_taxonomy_id INTEGER NOT NULL REFERENCES google_taxonomy(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_id)
);

-- 4. Item/Variation brand assignments
CREATE TABLE IF NOT EXISTS item_brands (
    id SERIAL PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(item_id)
);

-- 5. GMC Feed Settings
CREATE TABLE IF NOT EXISTS gmc_settings (
    id SERIAL PRIMARY KEY,
    setting_key TEXT NOT NULL UNIQUE,
    setting_value TEXT,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default GMC settings
INSERT INTO gmc_settings (setting_key, setting_value, description) VALUES
    ('website_base_url', 'https://your-store-url.com', 'Base URL for product links'),
    ('product_url_pattern', '/product/{slug}/{variation_id}', 'URL pattern for products'),
    ('default_condition', 'new', 'Default product condition'),
    ('default_availability', 'in_stock', 'Default availability when stock > 0'),
    ('currency', 'CAD', 'Default currency code'),
    ('feed_title', 'Product Feed', 'Feed title for GMC'),
    ('adult_content', 'no', 'Default adult content flag'),
    ('is_bundle', 'no', 'Default bundle flag')
ON CONFLICT (setting_key) DO NOTHING;

-- 6. GMC Feed Generation History
CREATE TABLE IF NOT EXISTS gmc_feed_history (
    id SERIAL PRIMARY KEY,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_products INTEGER,
    products_with_errors INTEGER DEFAULT 0,
    tsv_file_path TEXT,
    google_sheet_url TEXT,
    duration_seconds INTEGER,
    status TEXT DEFAULT 'success',
    error_message TEXT
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_google_taxonomy_parent ON google_taxonomy(parent_id);
CREATE INDEX IF NOT EXISTS idx_google_taxonomy_name ON google_taxonomy(name);
CREATE INDEX IF NOT EXISTS idx_category_taxonomy_category ON category_taxonomy_mapping(category_id);
CREATE INDEX IF NOT EXISTS idx_item_brands_item ON item_brands(item_id);
CREATE INDEX IF NOT EXISTS idx_item_brands_brand ON item_brands(brand_id);
CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);

-- Comments for documentation
COMMENT ON TABLE brands IS 'Product brands for Google Merchant Center feeds';
COMMENT ON TABLE google_taxonomy IS 'Google Product Taxonomy categories for GMC feeds';
COMMENT ON TABLE category_taxonomy_mapping IS 'Maps Square categories to Google taxonomy';
COMMENT ON TABLE item_brands IS 'Associates items with brands for GMC feeds';
COMMENT ON TABLE gmc_settings IS 'Configuration settings for Google Merchant Center feed generation';
COMMENT ON TABLE gmc_feed_history IS 'History of GMC feed generations';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Google Merchant Center migration completed successfully!';
    RAISE NOTICE 'Created tables: brands, google_taxonomy, category_taxonomy_mapping, item_brands, gmc_settings, gmc_feed_history';
END $$;
