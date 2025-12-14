-- ========================================
-- MIGRATION: Google Merchant Center Feed Support
-- ========================================
-- Run this migration to add Google Merchant Center feed tables
-- Usage: psql -d your_database -f 003_google_merchant_center.sql

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
    ('website_base_url', 'https://jtpets.ca', 'Base URL for product links'),
    ('product_url_pattern', '/product/{slug}/{variation_id}', 'URL pattern for products'),
    ('default_condition', 'new', 'Default product condition'),
    ('default_availability', 'in_stock', 'Default availability when stock > 0'),
    ('currency', 'CAD', 'Default currency code'),
    ('feed_title', 'JT Pets Product Feed', 'Feed title for GMC'),
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

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Google Merchant Center migration completed successfully!';
    RAISE NOTICE 'Created tables: brands, google_taxonomy, category_taxonomy_mapping, item_brands, gmc_settings, gmc_feed_history';
END $$;
