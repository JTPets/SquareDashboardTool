-- ========================================
-- MIGRATION: Fix multi-tenant unique constraints
-- ========================================
-- This migration adds merchant_id to the unique constraints for:
--   1. sales_velocity
--   2. variation_location_settings
--   3. variation_vendors
-- These were missed in 007_multi_tenant_constraints.sql and cause ON CONFLICT
-- to fail silently, resulting in "No data" for sales velocity and sync errors.
-- Usage: psql -d your_database -f 018_sales_velocity_constraint.sql

-- ----------------------------------------
-- 1. Fix sales_velocity unique constraint
-- ----------------------------------------
DO $$
BEGIN
    -- Drop old constraint if it exists (original name from schema.sql)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sales_velocity_variation_id_location_id_period_days_key'
    ) THEN
        ALTER TABLE sales_velocity DROP CONSTRAINT sales_velocity_variation_id_location_id_period_days_key;
        RAISE NOTICE 'Dropped old sales_velocity unique constraint';
    END IF;

    -- Also drop ensureSchema-created constraint if it exists (different name)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sales_velocity_var_loc_period_merchant_unique'
    ) THEN
        ALTER TABLE sales_velocity DROP CONSTRAINT sales_velocity_var_loc_period_merchant_unique;
        RAISE NOTICE 'Dropped ensureSchema sales_velocity constraint';
    END IF;
END $$;

-- Add new unique constraint including merchant_id
ALTER TABLE sales_velocity DROP CONSTRAINT IF EXISTS sales_velocity_variation_location_period_merchant_unique;
ALTER TABLE sales_velocity ADD CONSTRAINT sales_velocity_variation_location_period_merchant_unique
    UNIQUE(variation_id, location_id, period_days, merchant_id);

-- Add index for merchant_id if not already present
CREATE INDEX IF NOT EXISTS idx_sales_velocity_merchant ON sales_velocity(merchant_id);

-- ----------------------------------------
-- 2. Fix variation_location_settings unique constraint
-- ----------------------------------------
DO $$
BEGIN
    -- Drop old constraint if it exists (original name from schema.sql)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variation_location_settings_variation_id_location_id_key'
    ) THEN
        ALTER TABLE variation_location_settings DROP CONSTRAINT variation_location_settings_variation_id_location_id_key;
        RAISE NOTICE 'Dropped old variation_location_settings unique constraint';
    END IF;

    -- Also drop ensureSchema-created constraint if it exists (different name)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variation_location_settings_var_loc_merchant_unique'
    ) THEN
        ALTER TABLE variation_location_settings DROP CONSTRAINT variation_location_settings_var_loc_merchant_unique;
        RAISE NOTICE 'Dropped ensureSchema variation_location_settings constraint';
    END IF;
END $$;

-- Add new unique constraint including merchant_id
ALTER TABLE variation_location_settings DROP CONSTRAINT IF EXISTS variation_location_settings_variation_location_merchant_unique;
ALTER TABLE variation_location_settings ADD CONSTRAINT variation_location_settings_variation_location_merchant_unique
    UNIQUE(variation_id, location_id, merchant_id);

-- Add index for merchant_id if not already present
CREATE INDEX IF NOT EXISTS idx_variation_location_settings_merchant ON variation_location_settings(merchant_id);

-- ----------------------------------------
-- 3. Fix variation_vendors unique constraint
-- ----------------------------------------
DO $$
BEGIN
    -- Drop old constraint if it exists (original name from schema.sql)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variation_vendors_variation_id_vendor_id_key'
    ) THEN
        ALTER TABLE variation_vendors DROP CONSTRAINT variation_vendors_variation_id_vendor_id_key;
        RAISE NOTICE 'Dropped old variation_vendors unique constraint';
    END IF;

    -- Also drop ensureSchema-created constraint if it exists (different name)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variation_vendors_var_vendor_merchant_unique'
    ) THEN
        ALTER TABLE variation_vendors DROP CONSTRAINT variation_vendors_var_vendor_merchant_unique;
        RAISE NOTICE 'Dropped ensureSchema variation_vendors constraint';
    END IF;
END $$;

-- Add new unique constraint including merchant_id
ALTER TABLE variation_vendors DROP CONSTRAINT IF EXISTS variation_vendors_variation_vendor_merchant_unique;
ALTER TABLE variation_vendors ADD CONSTRAINT variation_vendors_variation_vendor_merchant_unique
    UNIQUE(variation_id, vendor_id, merchant_id);

-- Add index for merchant_id if not already present
CREATE INDEX IF NOT EXISTS idx_variation_vendors_merchant ON variation_vendors(merchant_id);

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Multi-tenant constraint migration completed successfully!';
    RAISE NOTICE 'Updated unique constraints for: sales_velocity, variation_location_settings, variation_vendors';
    RAISE NOTICE 'Sales velocity sync and vendor sync will now work correctly.';
END $$;
