-- Migration 042: Bundle Support for Reorder System
-- Adds bundle definitions and components tables for managing parent-child
-- bundle relationships. Square's API has no bundle support, so we build
-- our own relationship layer.
--
-- Bundle availability is CALCULATED: MIN(child_stock / qty_per_bundle)
-- Bundle velocity correction: child_total_velocity = individual_velocity + SUM(bundle_velocity * qty_per_bundle)

-- ========================================
-- Bundle definitions (the parent bundle catalog item)
-- ========================================
CREATE TABLE IF NOT EXISTS bundle_definitions (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    bundle_variation_id TEXT NOT NULL,        -- Square variation_id of the BUNDLE catalog item
    bundle_item_id TEXT,                      -- Square item_id of the BUNDLE catalog item
    bundle_item_name TEXT NOT NULL,           -- e.g. "BCR Variety Pack - 2lb"
    bundle_variation_name TEXT,               -- Variation name if applicable
    bundle_sku TEXT,
    bundle_cost_cents INTEGER NOT NULL,       -- What tenant pays vendor for 1 bundle
    bundle_sell_price_cents INTEGER,          -- What tenant sells the bundle for
    vendor_id INTEGER,                        -- References vendors table
    is_active BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, bundle_variation_id)
);

-- ========================================
-- Bundle components (children inside the bundle)
-- ========================================
CREATE TABLE IF NOT EXISTS bundle_components (
    id SERIAL PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES bundle_definitions(id) ON DELETE CASCADE,
    child_variation_id TEXT NOT NULL,         -- Square variation_id of the component
    child_item_id TEXT,                       -- Square item_id of the component
    quantity_in_bundle INTEGER NOT NULL DEFAULT 1, -- How many of this child per 1 bundle
    child_item_name TEXT,                     -- Cached name for display
    child_variation_name TEXT,
    child_sku TEXT,
    individual_cost_cents INTEGER,            -- Cost when buying this child solo (not via bundle)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(bundle_id, child_variation_id)
);

-- ========================================
-- Indexes
-- ========================================
CREATE INDEX IF NOT EXISTS idx_bundle_defs_merchant ON bundle_definitions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_defs_vendor ON bundle_definitions(merchant_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bundle_defs_variation ON bundle_definitions(bundle_variation_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_child ON bundle_components(child_variation_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle ON bundle_components(bundle_id);

-- ========================================
-- Comments
-- ========================================
COMMENT ON TABLE bundle_definitions IS 'Parent bundle items - Square has no API support for bundles, so we track relationships locally';
COMMENT ON TABLE bundle_components IS 'Child items within a bundle, with quantity per bundle';
COMMENT ON COLUMN bundle_definitions.bundle_variation_id IS 'Square variation_id of the bundle catalog item';
COMMENT ON COLUMN bundle_definitions.bundle_cost_cents IS 'Wholesale cost for one complete bundle from vendor';
COMMENT ON COLUMN bundle_components.quantity_in_bundle IS 'How many units of this child are included in one bundle';
COMMENT ON COLUMN bundle_components.individual_cost_cents IS 'Cost when purchasing this child individually (not via bundle)';

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Bundle Support migration completed successfully!';
    RAISE NOTICE 'Created tables: bundle_definitions, bundle_components';
    RAISE NOTICE 'Created indexes: 5';
END $$;
