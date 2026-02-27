-- Square Dashboard Addon Tool - Database Schema
-- PostgreSQL 14+

-- Drop existing tables (in reverse order of dependencies)

-- Delivery module tables (drop first due to FK dependencies)
DROP TABLE IF EXISTS delivery_route_tokens CASCADE;
DROP TABLE IF EXISTS delivery_audit_log CASCADE;
DROP TABLE IF EXISTS delivery_pod CASCADE;
DROP TABLE IF EXISTS delivery_orders CASCADE;
DROP TABLE IF EXISTS delivery_routes CASCADE;
DROP TABLE IF EXISTS delivery_settings CASCADE;

-- Loyalty module tables
DROP TABLE IF EXISTS loyalty_customer_summary CASCADE;
DROP TABLE IF EXISTS loyalty_audit_logs CASCADE;
DROP TABLE IF EXISTS loyalty_redemptions CASCADE;
DROP TABLE IF EXISTS loyalty_rewards CASCADE;
DROP TABLE IF EXISTS loyalty_purchase_events CASCADE;
DROP TABLE IF EXISTS loyalty_qualifying_variations CASCADE;
DROP TABLE IF EXISTS loyalty_offers CASCADE;
DROP TABLE IF EXISTS loyalty_settings CASCADE;

-- Subscription tables
DROP TABLE IF EXISTS subscription_events CASCADE;
DROP TABLE IF EXISTS subscription_payments CASCADE;
DROP TABLE IF EXISTS subscribers CASCADE;
DROP TABLE IF EXISTS subscription_plans CASCADE;

-- Core tables
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
DROP TABLE IF EXISTS user_merchants CASCADE;
DROP TABLE IF EXISTS merchant_invitations CASCADE;
DROP TABLE IF EXISTS oauth_states CASCADE;
DROP TABLE IF EXISTS merchants CASCADE;
DROP TABLE IF EXISTS password_reset_tokens CASCADE;
DROP TABLE IF EXISTS auth_audit_log CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Create tables

-- ==================== FOUNDATIONAL TABLES (must be created FIRST) ====================
-- These tables are referenced by many other tables via foreign keys

-- 0a. Users table - authentication and user management
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'readonly')),
    is_active BOOLEAN DEFAULT TRUE,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ DEFAULT NOW(),
    terms_accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_active ON users(is_active) WHERE is_active = TRUE;

-- 0b. Merchants table - multi-tenant support, stores Square OAuth credentials
CREATE TABLE merchants (
    id SERIAL PRIMARY KEY,
    square_merchant_id TEXT UNIQUE NOT NULL,
    business_name TEXT NOT NULL,
    business_email TEXT,
    square_access_token TEXT NOT NULL,
    square_refresh_token TEXT,
    square_token_expires_at TIMESTAMPTZ,
    square_token_scopes TEXT[],
    subscription_status TEXT DEFAULT 'trial',
    subscription_plan_id INTEGER,
    trial_ends_at TIMESTAMPTZ,
    subscription_ends_at TIMESTAMPTZ,
    timezone TEXT DEFAULT 'America/New_York',
    currency TEXT DEFAULT 'USD',
    settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,
    custom_attributes_initialized_at TIMESTAMPTZ DEFAULT NULL,
    CONSTRAINT valid_subscription_status CHECK (
        subscription_status IN ('trial', 'active', 'cancelled', 'expired', 'suspended')
    )
);

CREATE INDEX idx_merchants_square_id ON merchants(square_merchant_id);
CREATE INDEX idx_merchants_subscription ON merchants(subscription_status, is_active);
CREATE INDEX idx_merchants_active ON merchants(is_active) WHERE is_active = TRUE;

-- ==================== CORE APPLICATION TABLES ====================

-- 1. Sync history tracking for smart sync optimization
CREATE TABLE sync_history (
    id SERIAL PRIMARY KEY,
    sync_type TEXT NOT NULL,  -- 'catalog', 'vendors', 'inventory', 'sales_91d', 'sales_182d', 'sales_365d'
    merchant_id INTEGER REFERENCES merchants(id),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,  -- Simple timestamp for last sync
    status TEXT DEFAULT 'running',  -- 'running', 'success', 'failed'
    records_synced INTEGER DEFAULT 0,
    error_message TEXT,
    duration_seconds INTEGER,
    last_delta_timestamp TEXT,   -- Square's latest_time from SearchCatalogObjects (for delta sync begin_time)
    last_catalog_version TEXT,   -- Webhook catalog version updated_at (for dedup)
    UNIQUE(sync_type, merchant_id)
);

-- 2. Store locations from Square
CREATE TABLE locations (
    id TEXT PRIMARY KEY,
    name TEXT,
    square_location_id TEXT UNIQUE,
    active BOOLEAN DEFAULT TRUE,
    address TEXT,
    timezone TEXT,
    phone_number TEXT,
    business_email TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
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
    merchant_id INTEGER REFERENCES merchants(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Helper function for vendor name normalization (case-insensitive, trimmed)
CREATE OR REPLACE FUNCTION vendor_name_normalized(name TEXT)
RETURNS TEXT AS $$
BEGIN
    RETURN LOWER(TRIM(name));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Unique constraint on vendor name per merchant (prevents duplicates)
CREATE UNIQUE INDEX idx_vendors_merchant_name_unique
ON vendors (merchant_id, vendor_name_normalized(name))
WHERE merchant_id IS NOT NULL;

-- 4. Product categories from Square
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    merchant_id INTEGER REFERENCES merchants(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Product images from Square
CREATE TABLE images (
    id TEXT PRIMARY KEY,
    name TEXT,
    url TEXT,
    caption TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
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
    merchant_id INTEGER REFERENCES merchants(id),
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
    merchant_id INTEGER REFERENCES merchants(id),
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
    merchant_id INTEGER REFERENCES merchants(id),
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    UNIQUE(variation_id, vendor_id, merchant_id)
);

-- 9. Current inventory counts from Square
CREATE TABLE inventory_counts (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    state TEXT NOT NULL,
    quantity INTEGER DEFAULT 0,
    merchant_id INTEGER REFERENCES merchants(id),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    UNIQUE(catalog_object_id, location_id, state, merchant_id)
);

-- 9b. Committed inventory per-invoice tracking (BACKLOG-10)
-- Tracks line items from open invoices for incremental committed inventory updates.
-- The RESERVED_FOR_SALE aggregate in inventory_counts is rebuilt from this table.
CREATE TABLE committed_inventory (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    square_invoice_id TEXT NOT NULL,
    square_order_id TEXT,
    catalog_object_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    invoice_status TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, square_invoice_id, catalog_object_id, location_id)
);

CREATE INDEX idx_committed_inv_merchant ON committed_inventory(merchant_id);
CREATE INDEX idx_committed_inv_status ON committed_inventory(merchant_id, invoice_status);
CREATE INDEX idx_committed_inv_variation ON committed_inventory(merchant_id, catalog_object_id);

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
    merchant_id INTEGER REFERENCES merchants(id),
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    UNIQUE(variation_id, location_id, period_days, merchant_id)
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
    merchant_id INTEGER REFERENCES merchants(id),
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    UNIQUE(variation_id, location_id, merchant_id)
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
    merchant_id INTEGER REFERENCES merchants(id),
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
    merchant_id INTEGER REFERENCES merchants(id),
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

-- Multi-tenant merchant_id indexes (from migration 005)
CREATE INDEX IF NOT EXISTS idx_locations_merchant ON locations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_categories_merchant ON categories(merchant_id);
CREATE INDEX IF NOT EXISTS idx_items_merchant ON items(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variations_merchant ON variations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_images_merchant ON images(merchant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_merchant ON inventory_counts(merchant_id);
CREATE INDEX IF NOT EXISTS idx_vendors_merchant ON vendors(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variation_vendors_merchant ON variation_vendors(merchant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_merchant ON purchase_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_merchant ON purchase_order_items(merchant_id);
CREATE INDEX IF NOT EXISTS idx_sales_velocity_merchant ON sales_velocity(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variation_location_settings_merchant ON variation_location_settings(merchant_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_merchant ON sync_history(merchant_id);

-- Multi-tenant composite indexes (from migration 005)
CREATE INDEX IF NOT EXISTS idx_items_merchant_deleted ON items(merchant_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_variations_merchant_item ON variations(merchant_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_merchant_location ON inventory_counts(merchant_id, location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_merchant_location_state ON inventory_counts(merchant_id, location_id, state);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_merchant_status ON purchase_orders(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_velocity_merchant_location ON sales_velocity(merchant_id, location_id);
CREATE INDEX IF NOT EXISTS idx_vendors_merchant_name ON vendors(merchant_id, name);
CREATE INDEX IF NOT EXISTS idx_categories_merchant_name ON categories(merchant_id, name);

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
    variation_id TEXT NOT NULL REFERENCES variations(id) ON DELETE CASCADE,
    expiration_date TIMESTAMPTZ,
    does_not_expire BOOLEAN DEFAULT FALSE,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (variation_id, merchant_id)
);

-- Create indexes for efficient expiration queries
CREATE INDEX IF NOT EXISTS idx_variation_expiration_date
    ON variation_expiration(expiration_date)
    WHERE expiration_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_variation_does_not_expire
    ON variation_expiration(does_not_expire)
    WHERE does_not_expire = TRUE;
CREATE INDEX IF NOT EXISTS idx_variation_expiration_merchant ON variation_expiration(merchant_id);

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
    catalog_object_id TEXT NOT NULL,
    last_counted_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counted_by TEXT,
    is_accurate BOOLEAN DEFAULT NULL,
    actual_quantity INTEGER DEFAULT NULL,
    expected_quantity INTEGER DEFAULT NULL,
    variance INTEGER DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    merchant_id INTEGER REFERENCES merchants(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE,
    UNIQUE(catalog_object_id, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_count_history_catalog_id ON count_history(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_history_last_counted ON count_history(last_counted_date DESC);
CREATE INDEX IF NOT EXISTS idx_count_history_accuracy ON count_history(is_accurate) WHERE is_accurate = FALSE;
CREATE INDEX IF NOT EXISTS idx_count_history_merchant ON count_history(merchant_id);

-- Table for priority queue ("Send Now" items)
CREATE TABLE IF NOT EXISTS count_queue_priority (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    added_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_by TEXT,
    notes TEXT,
    completed BOOLEAN DEFAULT FALSE,
    completed_date TIMESTAMP,
    merchant_id INTEGER REFERENCES merchants(id),
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_count_queue_catalog_id ON count_queue_priority(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_completed ON count_queue_priority(completed) WHERE completed = FALSE;
CREATE INDEX IF NOT EXISTS idx_count_queue_priority_merchant ON count_queue_priority(merchant_id);

-- Table for daily batch queue (accumulates uncompleted items)
CREATE TABLE IF NOT EXISTS count_queue_daily (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    batch_date DATE NOT NULL DEFAULT CURRENT_DATE,
    added_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed BOOLEAN DEFAULT FALSE,
    completed_date TIMESTAMP,
    notes TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE,
    UNIQUE(catalog_object_id, batch_date, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_count_queue_daily_catalog_id ON count_queue_daily(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_batch_date ON count_queue_daily(batch_date DESC);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_completed ON count_queue_daily(completed) WHERE completed = FALSE;
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_merchant ON count_queue_daily(merchant_id);

-- Table to track count sessions for reporting
CREATE TABLE IF NOT EXISTS count_sessions (
    id SERIAL PRIMARY KEY,
    session_date DATE NOT NULL DEFAULT CURRENT_DATE,
    items_expected INTEGER NOT NULL DEFAULT 0,
    items_completed INTEGER NOT NULL DEFAULT 0,
    completion_rate DECIMAL(5,2),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    notes TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
    UNIQUE(session_date, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_count_sessions_date ON count_sessions(session_date DESC);
CREATE INDEX IF NOT EXISTS idx_count_sessions_merchant ON count_sessions(merchant_id);

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
    -- Multi-tenant support
    merchant_id INTEGER REFERENCES merchants(id),
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
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_items_merchant ON vendor_catalog_items(merchant_id);

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
    name TEXT NOT NULL,
    logo_url TEXT,
    website TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, merchant_id)
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
    merchant_id INTEGER REFERENCES merchants(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_id, merchant_id)
);

-- 4. Item/Variation brand assignments
CREATE TABLE IF NOT EXISTS item_brands (
    id SERIAL PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    merchant_id INTEGER REFERENCES merchants(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(item_id, merchant_id)
);

-- 5. GMC Feed Settings
CREATE TABLE IF NOT EXISTS gmc_settings (
    id SERIAL PRIMARY KEY,
    setting_key TEXT NOT NULL,
    setting_value TEXT,
    description TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(setting_key, merchant_id)
);

-- Note: Default GMC settings are now inserted per-merchant during OAuth flow

-- 6. GMC Feed Generation History
CREATE TABLE IF NOT EXISTS gmc_feed_history (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER REFERENCES merchants(id),
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_products INTEGER,
    products_with_errors INTEGER DEFAULT 0,
    tsv_file_path TEXT,
    google_sheet_url TEXT,
    duration_seconds INTEGER,
    status TEXT DEFAULT 'success',
    error_message TEXT
);

-- Index for efficient per-merchant history queries
CREATE INDEX IF NOT EXISTS idx_gmc_feed_history_merchant ON gmc_feed_history(merchant_id, generated_at DESC);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_google_taxonomy_parent ON google_taxonomy(parent_id);
CREATE INDEX IF NOT EXISTS idx_google_taxonomy_name ON google_taxonomy(name);
CREATE INDEX IF NOT EXISTS idx_category_taxonomy_category ON category_taxonomy_mapping(category_id);
CREATE INDEX IF NOT EXISTS idx_item_brands_item ON item_brands(item_id);
CREATE INDEX IF NOT EXISTS idx_item_brands_brand ON item_brands(brand_id);
CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);

-- Multi-tenant merchant_id indexes for GMC tables (from migration 005)
CREATE INDEX IF NOT EXISTS idx_brands_merchant ON brands(merchant_id);
CREATE INDEX IF NOT EXISTS idx_category_taxonomy_mapping_merchant ON category_taxonomy_mapping(merchant_id);
CREATE INDEX IF NOT EXISTS idx_item_brands_merchant ON item_brands(merchant_id);
CREATE INDEX IF NOT EXISTS idx_gmc_settings_merchant ON gmc_settings(merchant_id);

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

-- ========================================
-- MIGRATION: Expiry-Aware Discount System
-- ========================================
-- Configurable discount tiers based on product expiration dates
-- Integrates with Square item-level discount objects

-- 1. Configurable discount tier rules
CREATE TABLE IF NOT EXISTS expiry_discount_tiers (
    id SERIAL PRIMARY KEY,
    tier_code TEXT NOT NULL,                   -- e.g., 'AUTO50', 'AUTO25', 'REVIEW', 'EXPIRED'
    tier_name TEXT NOT NULL,                   -- Human-readable name
    min_days_to_expiry INTEGER,                -- Minimum days (inclusive), NULL = no minimum
    max_days_to_expiry INTEGER,                -- Maximum days (inclusive), NULL = no maximum
    discount_percent DECIMAL(5,2) DEFAULT 0,   -- Discount percentage (0-100)
    is_auto_apply BOOLEAN DEFAULT FALSE,       -- Whether to auto-apply discount in Square
    requires_review BOOLEAN DEFAULT FALSE,     -- Whether items need manual review
    square_discount_id TEXT,                   -- Square catalog discount object ID (once created)
    color_code TEXT DEFAULT '#6b7280',         -- Color for UI display (hex)
    priority INTEGER DEFAULT 0,                -- Higher = evaluated first (for overlapping ranges)
    is_active BOOLEAN DEFAULT TRUE,
    merchant_id INTEGER REFERENCES merchants(id), -- Multi-tenant support
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tier_code, merchant_id)             -- Same tier codes allowed per merchant
);

-- 2. Track which variations are currently in which tier
CREATE TABLE IF NOT EXISTS variation_discount_status (
    variation_id TEXT NOT NULL REFERENCES variations(id) ON DELETE CASCADE,
    current_tier_id INTEGER REFERENCES expiry_discount_tiers(id) ON DELETE SET NULL,
    days_until_expiry INTEGER,                 -- Cached calculation
    original_price_cents INTEGER,              -- Price before any discount
    discounted_price_cents INTEGER,            -- Price after discount (if applied)
    discount_applied_at TIMESTAMPTZ,           -- When discount was applied in Square
    last_evaluated_at TIMESTAMPTZ DEFAULT NOW(),
    needs_pull BOOLEAN DEFAULT FALSE,          -- Flag for expired items needing removal
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (variation_id, merchant_id)
);

-- 3. Audit log for all discount changes
CREATE TABLE IF NOT EXISTS expiry_discount_audit_log (
    id SERIAL PRIMARY KEY,
    variation_id TEXT NOT NULL,
    action TEXT NOT NULL,                      -- 'TIER_ASSIGNED', 'DISCOUNT_APPLIED', 'DISCOUNT_REMOVED', 'FLAGGED_FOR_PULL'
    old_tier_id INTEGER,
    new_tier_id INTEGER,
    old_price_cents INTEGER,
    new_price_cents INTEGER,
    days_until_expiry INTEGER,
    square_sync_status TEXT,                   -- 'PENDING', 'SUCCESS', 'FAILED'
    square_error_message TEXT,
    triggered_by TEXT DEFAULT 'SYSTEM',        -- 'SYSTEM', 'MANUAL', 'CRON'
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Settings for the expiry discount system
CREATE TABLE IF NOT EXISTS expiry_discount_settings (
    id SERIAL PRIMARY KEY,
    setting_key TEXT NOT NULL,
    setting_value TEXT,
    description TEXT,
    merchant_id INTEGER REFERENCES merchants(id),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(setting_key, merchant_id)
);

-- Note: Default tier configurations and settings are now created per-merchant
-- by ensureMerchantTiers() in utils/expiry-discount.js when a merchant first
-- accesses the expiry discounts page. This ensures proper multi-tenant isolation.

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_variation_discount_status_tier ON variation_discount_status(current_tier_id);
CREATE INDEX IF NOT EXISTS idx_variation_discount_status_needs_pull ON variation_discount_status(needs_pull) WHERE needs_pull = TRUE;
CREATE INDEX IF NOT EXISTS idx_expiry_discount_audit_variation ON expiry_discount_audit_log(variation_id);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_audit_created ON expiry_discount_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_tiers_active ON expiry_discount_tiers(is_active, priority DESC);

-- Multi-tenant merchant_id indexes for expiry discount tables (from migration 005)
CREATE INDEX IF NOT EXISTS idx_expiry_discount_tiers_merchant ON expiry_discount_tiers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variation_discount_status_merchant ON variation_discount_status(merchant_id);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_audit_log_merchant ON expiry_discount_audit_log(merchant_id);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_settings_merchant ON expiry_discount_settings(merchant_id);

-- Comments for documentation
COMMENT ON TABLE expiry_discount_tiers IS 'Configurable discount tiers based on days until product expiration';
COMMENT ON TABLE variation_discount_status IS 'Current discount status for each variation based on expiry date';
COMMENT ON TABLE expiry_discount_audit_log IS 'Audit trail of all discount tier changes and Square sync events';
COMMENT ON TABLE expiry_discount_settings IS 'System settings for expiry discount automation';

COMMENT ON COLUMN expiry_discount_tiers.min_days_to_expiry IS 'Minimum days until expiry (inclusive) - NULL means no lower bound';
COMMENT ON COLUMN expiry_discount_tiers.max_days_to_expiry IS 'Maximum days until expiry (inclusive) - NULL means no upper bound';
COMMENT ON COLUMN expiry_discount_tiers.square_discount_id IS 'Square catalog ID for the discount object (created via API)';
COMMENT ON COLUMN variation_discount_status.needs_pull IS 'Flag indicating item is expired and should be removed from shelf';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Expiry Discount System migration completed successfully!';
    RAISE NOTICE 'Created tables: expiry_discount_tiers, variation_discount_status, expiry_discount_audit_log, expiry_discount_settings';
    RAISE NOTICE 'Default tiers: EXPIRED, AUTO50, AUTO25, REVIEW, OK';
END $$;

-- ========================================
-- MIGRATION: Add review tracking to expiration
-- ========================================
-- Allows marking items as reviewed so they don't reappear in the review filter

ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

COMMENT ON COLUMN variation_expiration.reviewed_at IS 'When the item was last reviewed for expiry status';
COMMENT ON COLUMN variation_expiration.reviewed_by IS 'Who reviewed the item';

-- Index for efficient filtering of reviewed items
CREATE INDEX IF NOT EXISTS idx_variation_expiration_reviewed
    ON variation_expiration(reviewed_at)
    WHERE reviewed_at IS NOT NULL;

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Review tracking migration completed successfully!';
    RAISE NOTICE 'Added reviewed_at and reviewed_by columns to variation_expiration';
END $$;

-- ========================================
-- MIGRATION: Add merchant_id to GMC feed history
-- ========================================
-- Fixes multi-tenant data isolation for feed generation tracking

ALTER TABLE gmc_feed_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

CREATE INDEX IF NOT EXISTS idx_gmc_feed_history_merchant
    ON gmc_feed_history(merchant_id, generated_at DESC);

COMMENT ON COLUMN gmc_feed_history.merchant_id IS 'Merchant ID for multi-tenant feed history isolation';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'GMC feed history multi-tenant migration completed successfully!';
    RAISE NOTICE 'Added merchant_id column to gmc_feed_history table';
END $$;

-- ========================================
-- MIGRATION: Subscription Management
-- ========================================
-- Adds tables for managing customer subscriptions via Square Subscriptions API
-- Originally from 004_subscriptions.sql

-- Subscribers table - tracks each subscriber/tenant
CREATE TABLE IF NOT EXISTS subscribers (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    business_name TEXT,
    square_customer_id TEXT UNIQUE,
    square_subscription_id TEXT UNIQUE,

    -- Subscription status
    subscription_status TEXT DEFAULT 'trial', -- trial, active, canceled, expired, past_due
    subscription_plan TEXT DEFAULT 'monthly', -- monthly, annual

    -- Pricing (in cents)
    price_cents INTEGER NOT NULL DEFAULT 999, -- $9.99 default

    -- Important dates
    trial_start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    trial_end_date TIMESTAMP, -- 30 days from start
    subscription_start_date TIMESTAMP,
    subscription_end_date TIMESTAMP,
    next_billing_date TIMESTAMP,
    canceled_at TIMESTAMP,

    -- Payment info
    card_brand TEXT, -- VISA, MASTERCARD, etc
    card_last_four TEXT,
    card_id TEXT, -- Square card on file ID

    -- Intro pricing flag
    is_intro_pricing BOOLEAN DEFAULT TRUE,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription payments history
CREATE TABLE IF NOT EXISTS subscription_payments (
    id SERIAL PRIMARY KEY,
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    square_payment_id TEXT UNIQUE,
    square_invoice_id TEXT,

    -- Payment details
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'CAD',
    status TEXT NOT NULL, -- completed, failed, refunded, pending

    -- Payment type
    payment_type TEXT DEFAULT 'subscription', -- subscription, refund, one_time
    billing_period_start TIMESTAMP,
    billing_period_end TIMESTAMP,

    -- Refund tracking
    refund_amount_cents INTEGER,
    refund_reason TEXT,
    refunded_at TIMESTAMP,

    -- Metadata
    receipt_url TEXT,
    failure_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription events log (for debugging and audit)
CREATE TABLE IF NOT EXISTS subscription_events (
    id SERIAL PRIMARY KEY,
    subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, -- subscription.created, payment.completed, subscription.canceled, etc
    event_data JSONB,
    square_event_id TEXT,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription plans configuration
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    plan_key TEXT NOT NULL UNIQUE, -- monthly, annual
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL,
    billing_frequency TEXT NOT NULL, -- MONTHLY, ANNUAL
    square_plan_id TEXT, -- Square catalog subscription plan ID
    is_active BOOLEAN DEFAULT TRUE,
    is_intro_pricing BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default subscription plans (intro pricing)
INSERT INTO subscription_plans (plan_key, name, description, price_cents, billing_frequency, is_intro_pricing) VALUES
    ('monthly', 'Monthly Plan (Intro)', 'Full feature access - billed monthly. Introductory pricing for early adopters!', 2999, 'MONTHLY', TRUE),
    ('annual', 'Annual Plan (Intro)', 'Full feature access - billed annually. Save $60/year! Introductory pricing for early adopters!', 29999, 'ANNUAL', TRUE)
ON CONFLICT (plan_key) DO UPDATE SET
    price_cents = EXCLUDED.price_cents,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;

-- Indexes for subscriptions
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(subscription_status);
CREATE INDEX IF NOT EXISTS idx_subscribers_square_customer ON subscribers(square_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_square_subscription ON subscribers(square_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscriber ON subscription_payments(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX IF NOT EXISTS idx_subscription_events_subscriber ON subscription_events(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_type ON subscription_events(event_type);

-- Comments for subscriptions
COMMENT ON TABLE subscribers IS 'Tracks all subscribers to Square Dashboard Addon Tool with their subscription status';
COMMENT ON TABLE subscription_payments IS 'Payment history for all subscription transactions';
COMMENT ON TABLE subscription_events IS 'Audit log of all subscription-related events from Square webhooks';
COMMENT ON TABLE subscription_plans IS 'Available subscription plans with pricing';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Subscription management migration completed successfully!';
    RAISE NOTICE 'Created tables: subscribers, subscription_payments, subscription_events, subscription_plans';
END $$;

-- ========================================
-- MIGRATION: Delivery Scheduler Component
-- ========================================
-- Adds tables for the delivery scheduling system
-- Originally from 008_delivery_scheduler.sql

-- 1. delivery_orders - Delivery order queue
CREATE TABLE IF NOT EXISTS delivery_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_order_id VARCHAR(255),  -- null for manual orders
    customer_name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    address_lat DECIMAL(10, 8),  -- geocoded latitude
    address_lng DECIMAL(11, 8),  -- geocoded longitude
    geocoded_at TIMESTAMPTZ,     -- null = needs geocoding
    phone VARCHAR(50),
    notes TEXT,
    status VARCHAR(50) DEFAULT 'pending' CHECK (
        status IN ('pending', 'active', 'skipped', 'delivered', 'completed')
    ),
    route_id UUID,               -- reference to delivery_routes
    route_position INTEGER,      -- sequence in generated route
    route_date DATE,
    square_synced_at TIMESTAMPTZ,  -- when synced to Square as completed
    square_order_state VARCHAR(50),  -- Square order state (DRAFT, OPEN, COMPLETED, CANCELED)
    needs_customer_refresh BOOLEAN DEFAULT FALSE,  -- TRUE when ingested with incomplete customer data
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient merchant-filtered queries
CREATE INDEX IF NOT EXISTS idx_delivery_orders_merchant_status
    ON delivery_orders(merchant_id, status);

-- Index for route date queries
CREATE INDEX IF NOT EXISTS idx_delivery_orders_route_date
    ON delivery_orders(merchant_id, route_date);

-- UNIQUE index for Square order lookups (prevents duplicate delivery orders from racing webhooks)
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_orders_square_order
    ON delivery_orders(square_order_id, merchant_id)
    WHERE square_order_id IS NOT NULL;

-- Index for pending orders needing geocoding
CREATE INDEX IF NOT EXISTS idx_delivery_orders_needs_geocoding
    ON delivery_orders(merchant_id, geocoded_at)
    WHERE geocoded_at IS NULL;

-- Index for orders needing customer refresh (DRAFT orders with incomplete data)
CREATE INDEX IF NOT EXISTS idx_delivery_orders_needs_refresh
    ON delivery_orders(merchant_id, needs_customer_refresh)
    WHERE needs_customer_refresh = TRUE;

COMMENT ON TABLE delivery_orders IS 'Delivery order queue with status tracking and route assignment';
COMMENT ON COLUMN delivery_orders.status IS 'pending=ready for route, active=on current route, skipped=driver skipped, delivered=POD captured, completed=synced to Square';

-- 2. delivery_pod - Proof of Delivery photos
CREATE TABLE IF NOT EXISTS delivery_pod (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_order_id UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
    photo_path TEXT NOT NULL,       -- relative path to storage
    original_filename VARCHAR(255),
    file_size_bytes INTEGER,
    mime_type VARCHAR(100),
    captured_at TIMESTAMPTZ DEFAULT NOW(),
    latitude DECIMAL(10, 8),        -- GPS coords if available
    longitude DECIMAL(11, 8),
    expires_at TIMESTAMPTZ,         -- for auto-purge based on retention setting
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for order lookups
CREATE INDEX IF NOT EXISTS idx_delivery_pod_order
    ON delivery_pod(delivery_order_id);

-- Index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_delivery_pod_expires
    ON delivery_pod(expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON TABLE delivery_pod IS 'Proof of delivery photos with GPS metadata and retention tracking';

-- 3. delivery_settings - Per-merchant configuration
CREATE TABLE IF NOT EXISTS delivery_settings (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    start_address TEXT,
    start_address_lat DECIMAL(10, 8),
    start_address_lng DECIMAL(11, 8),
    end_address TEXT,
    end_address_lat DECIMAL(10, 8),
    end_address_lng DECIMAL(11, 8),
    same_day_cutoff TIME DEFAULT '17:00',
    pod_retention_days INTEGER DEFAULT 180,
    auto_ingest_ready_orders BOOLEAN DEFAULT TRUE,
    openrouteservice_api_key TEXT,  -- optional, uses default if null
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT delivery_settings_merchant_unique UNIQUE(merchant_id)
);

COMMENT ON TABLE delivery_settings IS 'Per-merchant delivery scheduler configuration';
COMMENT ON COLUMN delivery_settings.same_day_cutoff IS 'Orders marked ready after this time go to next day';
COMMENT ON COLUMN delivery_settings.auto_ingest_ready_orders IS 'Automatically ingest Square orders when status = ready';

-- 4. delivery_routes - Route history for auditing
CREATE TABLE IF NOT EXISTS delivery_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    route_date DATE NOT NULL,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generated_by INTEGER REFERENCES users(id),  -- user who generated the route
    total_stops INTEGER NOT NULL DEFAULT 0,
    total_distance_km DECIMAL(10, 2),
    estimated_duration_min INTEGER,
    started_at TIMESTAMPTZ,        -- when driver started route
    finished_at TIMESTAMPTZ,       -- when route was marked finished
    status VARCHAR(50) DEFAULT 'active' CHECK (
        status IN ('active', 'finished', 'cancelled')
    ),
    route_geometry TEXT,           -- GeoJSON from routing API (optional)
    waypoint_order TEXT[],         -- ordered array of delivery_order IDs
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for merchant route lookups
CREATE INDEX IF NOT EXISTS idx_delivery_routes_merchant_date
    ON delivery_routes(merchant_id, route_date);

-- Index for active route queries
CREATE INDEX IF NOT EXISTS idx_delivery_routes_active
    ON delivery_routes(merchant_id, status)
    WHERE status = 'active';

COMMENT ON TABLE delivery_routes IS 'Route generation history with optimization metrics';

-- 5. delivery_audit_log - Audit trail for key actions
CREATE TABLE IF NOT EXISTS delivery_audit_log (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,  -- route_generated, order_completed, order_skipped, etc.
    delivery_order_id UUID REFERENCES delivery_orders(id) ON DELETE SET NULL,
    route_id UUID REFERENCES delivery_routes(id) ON DELETE SET NULL,
    details JSONB,                 -- additional context
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for merchant audit queries
CREATE INDEX IF NOT EXISTS idx_delivery_audit_merchant
    ON delivery_audit_log(merchant_id, created_at DESC);

COMMENT ON TABLE delivery_audit_log IS 'Audit trail for delivery-related actions';

-- Add foreign key for route_id in delivery_orders (after delivery_routes exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'delivery_orders_route_id_fkey'
    ) THEN
        ALTER TABLE delivery_orders
        ADD CONSTRAINT delivery_orders_route_id_fkey
        FOREIGN KEY (route_id) REFERENCES delivery_routes(id) ON DELETE SET NULL;
        RAISE NOTICE 'Added route_id foreign key constraint';
    END IF;
END $$;

-- Create function for updating updated_at timestamp
CREATE OR REPLACE FUNCTION update_delivery_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for delivery_orders
DROP TRIGGER IF EXISTS delivery_orders_updated_at ON delivery_orders;
CREATE TRIGGER delivery_orders_updated_at
    BEFORE UPDATE ON delivery_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_delivery_orders_updated_at();

-- Create trigger for delivery_settings
DROP TRIGGER IF EXISTS delivery_settings_updated_at ON delivery_settings;
CREATE TRIGGER delivery_settings_updated_at
    BEFORE UPDATE ON delivery_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_delivery_orders_updated_at();

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Delivery Scheduler migration completed successfully!';
    RAISE NOTICE 'Created tables: delivery_orders, delivery_pod, delivery_settings, delivery_routes, delivery_audit_log';
END $$;

-- ========================================
-- MIGRATION: Square Loyalty Addon (Frequent Buyer Program)
-- ========================================
-- Implements vendor-defined frequent buyer programs (Astro-style loyalty)
-- where customers earn free items after purchasing a defined quantity.
-- Originally from 010_loyalty_program.sql
--
-- BUSINESS RULES (NON-NEGOTIABLE):
-- - One loyalty offer = one brand + one size group
-- - Qualifying purchases must match explicit variation IDs
-- - NEVER mix sizes to earn or redeem
-- - Rolling time window from first qualifying purchase
-- - Full redemption only (no partials, no substitutions)
-- - Reward is always 1 free unit of same size group

-- 1. loyalty_offers - Defines frequent buyer program offers
CREATE TABLE IF NOT EXISTS loyalty_offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,

    -- Offer identification
    offer_name VARCHAR(255) NOT NULL,
    brand_name VARCHAR(255) NOT NULL,
    size_group VARCHAR(100) NOT NULL,  -- e.g., '12oz', '1lb', 'small'

    -- Earning rules
    required_quantity INTEGER NOT NULL CHECK (required_quantity > 0),  -- e.g., 12 (buy 12 get 1)
    reward_quantity INTEGER NOT NULL DEFAULT 1 CHECK (reward_quantity = 1),  -- Always 1 free unit

    -- Time window (rolling from first qualifying purchase)
    window_months INTEGER NOT NULL DEFAULT 12 CHECK (window_months > 0),  -- e.g., 12 or 18 months

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Metadata
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES users(id),

    -- Prevent duplicate offers for same brand+size per merchant
    CONSTRAINT loyalty_offers_unique_brand_size UNIQUE(merchant_id, brand_name, size_group)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_offers_merchant ON loyalty_offers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_offers_brand ON loyalty_offers(merchant_id, brand_name);
CREATE INDEX IF NOT EXISTS idx_loyalty_offers_active ON loyalty_offers(merchant_id, is_active) WHERE is_active = TRUE;

COMMENT ON TABLE loyalty_offers IS 'Frequent buyer program offers: one per brand + size group';
COMMENT ON COLUMN loyalty_offers.required_quantity IS 'Number of units customer must purchase to earn reward (e.g., 12)';
COMMENT ON COLUMN loyalty_offers.reward_quantity IS 'Always 1 - one free unit of same size group';
COMMENT ON COLUMN loyalty_offers.window_months IS 'Rolling time window in months from first qualifying purchase';

-- 2. loyalty_qualifying_variations - Maps Square variations to offers
CREATE TABLE IF NOT EXISTS loyalty_qualifying_variations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Square catalog reference
    variation_id TEXT NOT NULL,  -- Square variation ID
    item_id TEXT,  -- Square item ID (for display purposes)
    item_name TEXT,  -- Cached item name
    variation_name TEXT,  -- Cached variation name (e.g., "12oz Bag")
    sku TEXT,  -- Cached SKU

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate variation mappings
    CONSTRAINT loyalty_qualifying_vars_unique UNIQUE(merchant_id, offer_id, variation_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_qual_vars_merchant ON loyalty_qualifying_variations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_qual_vars_offer ON loyalty_qualifying_variations(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_qual_vars_variation ON loyalty_qualifying_variations(merchant_id, variation_id);

COMMENT ON TABLE loyalty_qualifying_variations IS 'Maps Square variation IDs to loyalty offers - ONLY these variations qualify';
COMMENT ON COLUMN loyalty_qualifying_variations.variation_id IS 'Square variation ID that qualifies for this offer';

-- 3. loyalty_purchase_events - Records qualifying purchases
CREATE TABLE IF NOT EXISTS loyalty_purchase_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Customer reference (Square customer ID)
    square_customer_id TEXT NOT NULL,

    -- Order reference
    square_order_id TEXT NOT NULL,
    square_location_id TEXT,

    -- Purchase details
    variation_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity != 0),  -- Can be negative for refunds
    unit_price_cents INTEGER,  -- Price at time of purchase (for audit)

    -- Purchase timestamp (from Square order)
    purchased_at TIMESTAMPTZ NOT NULL,

    -- Window tracking (calculated)
    window_start_date DATE,  -- First qualifying purchase date for this customer+offer
    window_end_date DATE,    -- When this purchase will expire from window

    -- Linking to reward if this event contributed to an earned reward
    reward_id UUID,  -- Set when this purchase is locked into an earned reward

    -- Refund tracking
    is_refund BOOLEAN NOT NULL DEFAULT FALSE,
    original_event_id UUID REFERENCES loyalty_purchase_events(id),  -- For refund linking

    -- Idempotency
    idempotency_key TEXT NOT NULL,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate events (idempotency)
    CONSTRAINT loyalty_purchase_events_idempotent UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_merchant ON loyalty_purchase_events(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_offer ON loyalty_purchase_events(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_customer ON loyalty_purchase_events(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_customer_offer ON loyalty_purchase_events(merchant_id, square_customer_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_order ON loyalty_purchase_events(merchant_id, square_order_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_window ON loyalty_purchase_events(merchant_id, offer_id, square_customer_id, window_end_date);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_unlocked ON loyalty_purchase_events(merchant_id, offer_id, square_customer_id, reward_id) WHERE reward_id IS NULL;

COMMENT ON TABLE loyalty_purchase_events IS 'Records all qualifying purchases and refunds for loyalty tracking';
COMMENT ON COLUMN loyalty_purchase_events.quantity IS 'Positive for purchases, negative for refunds';
COMMENT ON COLUMN loyalty_purchase_events.reward_id IS 'Set when this purchase is locked into an earned reward';
COMMENT ON COLUMN loyalty_purchase_events.window_end_date IS 'Date when this purchase expires from the rolling window';

-- 4. loyalty_rewards - Tracks earned and redeemed rewards
-- State machine: in_progress -> earned -> redeemed | revoked
CREATE TABLE IF NOT EXISTS loyalty_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Customer reference
    square_customer_id TEXT NOT NULL,

    -- Reward state machine
    -- in_progress: Customer is working towards this reward
    -- earned: Customer has met requirements, reward is available
    -- redeemed: Reward has been used
    -- revoked: Reward was invalidated (e.g., due to refunds)
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (
        status IN ('in_progress', 'earned', 'redeemed', 'revoked')
    ),

    -- Progress tracking (for in_progress rewards)
    current_quantity INTEGER NOT NULL DEFAULT 0,  -- Current qualifying purchases
    required_quantity INTEGER NOT NULL,  -- Snapshot of offer requirement at time of creation

    -- Window dates
    window_start_date DATE NOT NULL,  -- First qualifying purchase date
    window_end_date DATE NOT NULL,    -- Window expiration date

    -- State timestamps
    earned_at TIMESTAMPTZ,
    redeemed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,

    -- Redemption details (when status = 'redeemed')
    redemption_id UUID,  -- Links to loyalty_redemptions
    redemption_order_id TEXT,  -- Square order ID where reward was redeemed

    -- Revocation reason (when status = 'revoked')
    revocation_reason TEXT,

    -- Vendor credit submission tracking (for redeemed rewards)
    vendor_credit_status VARCHAR(20) DEFAULT NULL CHECK (
        vendor_credit_status IS NULL OR vendor_credit_status IN ('SUBMITTED', 'CREDITED', 'DENIED')
    ),
    vendor_credit_submitted_at TIMESTAMPTZ,
    vendor_credit_resolved_at TIMESTAMPTZ,
    vendor_credit_notes TEXT,

    -- Square discount cap (cents) — tracks maximum_amount_money on the DISCOUNT object
    discount_amount_cents INTEGER DEFAULT NULL,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Only one in_progress reward per customer+offer at a time
    CONSTRAINT loyalty_rewards_one_in_progress UNIQUE(merchant_id, offer_id, square_customer_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_merchant ON loyalty_rewards(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_offer ON loyalty_rewards(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer ON loyalty_rewards(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer_offer ON loyalty_rewards(merchant_id, square_customer_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_status ON loyalty_rewards(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_earned ON loyalty_rewards(merchant_id, square_customer_id, status) WHERE status = 'earned';
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_in_progress ON loyalty_rewards(merchant_id, square_customer_id, status) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_vendor_credit_status ON loyalty_rewards(merchant_id, vendor_credit_status) WHERE vendor_credit_status IS NOT NULL;

COMMENT ON TABLE loyalty_rewards IS 'Tracks reward progress and state: in_progress -> earned -> redeemed | revoked';
COMMENT ON COLUMN loyalty_rewards.status IS 'State machine: in_progress (accumulating), earned (available), redeemed (used), revoked (invalidated)';
COMMENT ON COLUMN loyalty_rewards.current_quantity IS 'Count of qualifying purchases within the rolling window';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_status IS 'Vendor credit submission status: SUBMITTED, CREDITED, or DENIED';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_submitted_at IS 'Timestamp when reward was submitted for vendor credit';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_resolved_at IS 'Timestamp when vendor credit was credited or denied';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_notes IS 'Notes about vendor credit (invoice number, denial reason, etc.)';

-- 5. loyalty_redemptions - Records reward redemptions
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    reward_id UUID NOT NULL REFERENCES loyalty_rewards(id) ON DELETE RESTRICT,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE RESTRICT,

    -- Customer reference
    square_customer_id TEXT NOT NULL,

    -- Redemption method
    redemption_type VARCHAR(50) NOT NULL CHECK (
        redemption_type IN ('order_discount', 'manual_admin', 'auto_detected')
    ),

    -- Square order reference
    square_order_id TEXT,  -- May be null for manual redemptions
    square_location_id TEXT,

    -- What was redeemed
    redeemed_variation_id TEXT,  -- The variation given free
    redeemed_item_name TEXT,
    redeemed_variation_name TEXT,
    redeemed_value_cents INTEGER,  -- Value of the free item

    -- Square integration
    square_discount_id TEXT,  -- If applied via Square discount

    -- Admin info (for manual redemptions)
    redeemed_by_user_id INTEGER REFERENCES users(id),
    admin_notes TEXT,

    -- Metadata
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_merchant ON loyalty_redemptions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_reward ON loyalty_redemptions(reward_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_customer ON loyalty_redemptions(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_order ON loyalty_redemptions(merchant_id, square_order_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_date ON loyalty_redemptions(merchant_id, redeemed_at);

COMMENT ON TABLE loyalty_redemptions IS 'Records all reward redemptions with full audit trail';
COMMENT ON COLUMN loyalty_redemptions.redemption_type IS 'How the redemption was processed: order_discount, manual_admin, auto_detected';

-- 6. loyalty_audit_logs - Full audit trail
CREATE TABLE IF NOT EXISTS loyalty_audit_logs (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,

    -- What happened
    action VARCHAR(100) NOT NULL,  -- PURCHASE_RECORDED, REFUND_PROCESSED, REWARD_EARNED, REWARD_REDEEMED, REWARD_REVOKED, etc.

    -- References (nullable - depending on action)
    offer_id UUID REFERENCES loyalty_offers(id) ON DELETE SET NULL,
    reward_id UUID REFERENCES loyalty_rewards(id) ON DELETE SET NULL,
    purchase_event_id UUID REFERENCES loyalty_purchase_events(id) ON DELETE SET NULL,
    redemption_id UUID REFERENCES loyalty_redemptions(id) ON DELETE SET NULL,

    -- Customer
    square_customer_id TEXT,

    -- Order reference
    square_order_id TEXT,

    -- State change details
    old_state VARCHAR(50),
    new_state VARCHAR(50),
    old_quantity INTEGER,
    new_quantity INTEGER,

    -- Context
    triggered_by VARCHAR(50) NOT NULL DEFAULT 'SYSTEM',  -- SYSTEM, WEBHOOK, MANUAL, ADMIN
    user_id INTEGER REFERENCES users(id),

    -- Additional details (JSON for flexibility)
    details JSONB,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_audit_merchant ON loyalty_audit_logs(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_customer ON loyalty_audit_logs(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_offer ON loyalty_audit_logs(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_reward ON loyalty_audit_logs(reward_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_action ON loyalty_audit_logs(merchant_id, action);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_created ON loyalty_audit_logs(merchant_id, created_at DESC);

COMMENT ON TABLE loyalty_audit_logs IS 'Complete audit trail for all loyalty program actions';

-- 7. loyalty_settings - Per-merchant configuration
CREATE TABLE IF NOT EXISTS loyalty_settings (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT loyalty_settings_unique UNIQUE(merchant_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_settings_merchant ON loyalty_settings(merchant_id);

COMMENT ON TABLE loyalty_settings IS 'Per-merchant loyalty program configuration';

-- 8. loyalty_customer_summary - Materialized customer state (for performance)
CREATE TABLE IF NOT EXISTS loyalty_customer_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_customer_id TEXT NOT NULL,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Current progress
    current_quantity INTEGER NOT NULL DEFAULT 0,
    required_quantity INTEGER NOT NULL,

    -- Window info
    window_start_date DATE,
    window_end_date DATE,

    -- Reward status
    has_earned_reward BOOLEAN NOT NULL DEFAULT FALSE,
    earned_reward_id UUID REFERENCES loyalty_rewards(id),

    -- Totals
    total_lifetime_purchases INTEGER NOT NULL DEFAULT 0,
    total_rewards_earned INTEGER NOT NULL DEFAULT 0,
    total_rewards_redeemed INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    last_purchase_at TIMESTAMPTZ,
    last_reward_earned_at TIMESTAMPTZ,
    last_reward_redeemed_at TIMESTAMPTZ,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT loyalty_customer_summary_unique UNIQUE(merchant_id, square_customer_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_merchant ON loyalty_customer_summary(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_customer ON loyalty_customer_summary(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_offer ON loyalty_customer_summary(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_earned ON loyalty_customer_summary(merchant_id, has_earned_reward) WHERE has_earned_reward = TRUE;

COMMENT ON TABLE loyalty_customer_summary IS 'Denormalized customer loyalty status for quick lookups';

-- Create update trigger for loyalty updated_at columns
CREATE OR REPLACE FUNCTION update_loyalty_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
DROP TRIGGER IF EXISTS loyalty_offers_updated_at ON loyalty_offers;
CREATE TRIGGER loyalty_offers_updated_at
    BEFORE UPDATE ON loyalty_offers
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_qualifying_variations_updated_at ON loyalty_qualifying_variations;
CREATE TRIGGER loyalty_qualifying_variations_updated_at
    BEFORE UPDATE ON loyalty_qualifying_variations
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_purchase_events_updated_at ON loyalty_purchase_events;
CREATE TRIGGER loyalty_purchase_events_updated_at
    BEFORE UPDATE ON loyalty_purchase_events
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_rewards_updated_at ON loyalty_rewards;
CREATE TRIGGER loyalty_rewards_updated_at
    BEFORE UPDATE ON loyalty_rewards
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_customer_summary_updated_at ON loyalty_customer_summary;
CREATE TRIGGER loyalty_customer_summary_updated_at
    BEFORE UPDATE ON loyalty_customer_summary
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

COMMENT ON TABLE loyalty_settings IS 'Expected settings: auto_detect_redemptions (true/false), send_receipt_messages (true/false)';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Loyalty Program migration completed successfully!';
    RAISE NOTICE 'Created tables:';
    RAISE NOTICE '  - loyalty_offers (defines frequent buyer programs)';
    RAISE NOTICE '  - loyalty_qualifying_variations (maps Square variations to offers)';
    RAISE NOTICE '  - loyalty_purchase_events (tracks qualifying purchases)';
    RAISE NOTICE '  - loyalty_rewards (tracks reward state: in_progress -> earned -> redeemed | revoked)';
    RAISE NOTICE '  - loyalty_redemptions (records redemption details)';
    RAISE NOTICE '  - loyalty_audit_logs (complete audit trail)';
    RAISE NOTICE '  - loyalty_settings (per-merchant configuration)';
    RAISE NOTICE '  - loyalty_customer_summary (denormalized customer status)';
END $$;

-- ========================================
-- MIGRATION: Delivery Route Tokens
-- ========================================
-- Adds token-based access for sharing delivery routes with contract drivers
-- Originally from 021_delivery_route_tokens.sql

-- Route share tokens for contract driver access
CREATE TABLE IF NOT EXISTS delivery_route_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    token VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    driver_name VARCHAR(255),  -- Optional: track who used the token
    driver_notes TEXT
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_route_tokens_token ON delivery_route_tokens(token);

-- Index for finding tokens by route
CREATE INDEX IF NOT EXISTS idx_route_tokens_route ON delivery_route_tokens(route_id);

-- Index for merchant's tokens
CREATE INDEX IF NOT EXISTS idx_route_tokens_merchant ON delivery_route_tokens(merchant_id, status);

-- Only one active token per route at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_tokens_active_route
ON delivery_route_tokens(route_id)
WHERE status = 'active';

COMMENT ON TABLE delivery_route_tokens IS 'Shareable tokens for contract drivers to access delivery routes without authentication';
COMMENT ON COLUMN delivery_route_tokens.token IS 'Unique URL-safe token for route access';
COMMENT ON COLUMN delivery_route_tokens.status IS 'active=usable, used=route finished, expired=past expiry, revoked=manually cancelled';

-- Success message for migration
DO $$
BEGIN
    RAISE NOTICE 'Delivery Route Tokens migration completed successfully!';
    RAISE NOTICE 'Created table: delivery_route_tokens';
END $$;

-- ========================================
-- MIGRATION: Bundle Support for Reorder System
-- ========================================
-- Square has no API support for bundles. We build our own relationship layer.
-- Bundle availability = MIN(child_stock / qty_per_bundle) across all children.

CREATE TABLE IF NOT EXISTS bundle_definitions (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    bundle_variation_id TEXT NOT NULL,
    bundle_item_id TEXT,
    bundle_item_name TEXT NOT NULL,
    bundle_variation_name TEXT,
    bundle_sku TEXT,
    bundle_cost_cents INTEGER NOT NULL,
    bundle_sell_price_cents INTEGER,
    vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
    vendor_code TEXT,
    is_active BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, bundle_variation_id)
);

CREATE TABLE IF NOT EXISTS bundle_components (
    id SERIAL PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES bundle_definitions(id) ON DELETE CASCADE,
    child_variation_id TEXT NOT NULL,
    child_item_id TEXT,
    quantity_in_bundle INTEGER NOT NULL DEFAULT 1,
    child_item_name TEXT,
    child_variation_name TEXT,
    child_sku TEXT,
    individual_cost_cents INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(bundle_id, child_variation_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_defs_merchant ON bundle_definitions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_defs_vendor ON bundle_definitions(merchant_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bundle_defs_variation ON bundle_definitions(bundle_variation_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_child ON bundle_components(child_variation_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle ON bundle_components(bundle_id);

COMMENT ON TABLE bundle_definitions IS 'Parent bundle items - Square has no API support for bundles, so we track relationships locally';
COMMENT ON TABLE bundle_components IS 'Child items within a bundle, with quantity per bundle';

-- ========================================
-- FINAL: Schema creation complete
-- ========================================
DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE 'Square Dashboard Addon Tool - Schema Complete';
    RAISE NOTICE '============================================';
    RAISE NOTICE 'Core tables: 13';
    RAISE NOTICE 'Subscription tables: 4';
    RAISE NOTICE 'Delivery tables: 6';
    RAISE NOTICE 'Loyalty tables: 8';
    RAISE NOTICE 'Bundle tables: 2';
    RAISE NOTICE 'Total tables: 33+';
    RAISE NOTICE '============================================';
END $$;
