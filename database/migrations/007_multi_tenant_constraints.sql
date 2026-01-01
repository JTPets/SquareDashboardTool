-- ========================================
-- MIGRATION: Update unique constraints for multi-tenant
-- ========================================
-- This migration updates unique constraints to include merchant_id for proper
-- multi-tenant data isolation. Run this AFTER 005_multi_tenant.sql
-- Usage: psql -d your_database -f 007_multi_tenant_constraints.sql

-- ----------------------------------------
-- 1. count_history - change from UNIQUE(catalog_object_id) to UNIQUE(catalog_object_id, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    -- Drop old constraint if it exists
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'count_history_catalog_object_id_key'
    ) THEN
        ALTER TABLE count_history DROP CONSTRAINT count_history_catalog_object_id_key;
        RAISE NOTICE 'Dropped old count_history unique constraint';
    END IF;
END $$;

-- Add new composite unique constraint
ALTER TABLE count_history DROP CONSTRAINT IF EXISTS count_history_catalog_merchant_unique;
ALTER TABLE count_history ADD CONSTRAINT count_history_catalog_merchant_unique
    UNIQUE(catalog_object_id, merchant_id);

-- ----------------------------------------
-- 2. count_sessions - add UNIQUE(session_date, merchant_id)
-- ----------------------------------------
ALTER TABLE count_sessions DROP CONSTRAINT IF EXISTS count_sessions_date_merchant_unique;
ALTER TABLE count_sessions ADD CONSTRAINT count_sessions_date_merchant_unique
    UNIQUE(session_date, merchant_id);

-- ----------------------------------------
-- 3. count_queue_daily - change from UNIQUE(catalog_object_id, batch_date) to include merchant_id
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'count_queue_daily_catalog_object_id_batch_date_key'
    ) THEN
        ALTER TABLE count_queue_daily DROP CONSTRAINT count_queue_daily_catalog_object_id_batch_date_key;
        RAISE NOTICE 'Dropped old count_queue_daily unique constraint';
    END IF;
END $$;

ALTER TABLE count_queue_daily DROP CONSTRAINT IF EXISTS count_queue_daily_catalog_batch_merchant_unique;
ALTER TABLE count_queue_daily ADD CONSTRAINT count_queue_daily_catalog_batch_merchant_unique
    UNIQUE(catalog_object_id, batch_date, merchant_id);

-- ----------------------------------------
-- 4. inventory_counts - change from UNIQUE(catalog_object_id, location_id, state) to include merchant_id
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inventory_counts_catalog_object_id_location_id_state_key'
    ) THEN
        ALTER TABLE inventory_counts DROP CONSTRAINT inventory_counts_catalog_object_id_location_id_state_key;
        RAISE NOTICE 'Dropped old inventory_counts unique constraint';
    END IF;
END $$;

ALTER TABLE inventory_counts DROP CONSTRAINT IF EXISTS inventory_counts_catalog_location_state_merchant_unique;
ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_catalog_location_state_merchant_unique
    UNIQUE(catalog_object_id, location_id, state, merchant_id);

-- ----------------------------------------
-- 5. brands - change from UNIQUE(name) to UNIQUE(name, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'brands_name_key'
    ) THEN
        ALTER TABLE brands DROP CONSTRAINT brands_name_key;
        RAISE NOTICE 'Dropped old brands unique constraint';
    END IF;
END $$;

ALTER TABLE brands DROP CONSTRAINT IF EXISTS brands_name_merchant_unique;
ALTER TABLE brands ADD CONSTRAINT brands_name_merchant_unique
    UNIQUE(name, merchant_id);

-- ----------------------------------------
-- 6. category_taxonomy_mapping - change from UNIQUE(category_id) to UNIQUE(category_id, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'category_taxonomy_mapping_category_id_key'
    ) THEN
        ALTER TABLE category_taxonomy_mapping DROP CONSTRAINT category_taxonomy_mapping_category_id_key;
        RAISE NOTICE 'Dropped old category_taxonomy_mapping unique constraint';
    END IF;
END $$;

ALTER TABLE category_taxonomy_mapping DROP CONSTRAINT IF EXISTS category_taxonomy_mapping_category_merchant_unique;
ALTER TABLE category_taxonomy_mapping ADD CONSTRAINT category_taxonomy_mapping_category_merchant_unique
    UNIQUE(category_id, merchant_id);

-- ----------------------------------------
-- 7. item_brands - change from UNIQUE(item_id) to UNIQUE(item_id, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'item_brands_item_id_key'
    ) THEN
        ALTER TABLE item_brands DROP CONSTRAINT item_brands_item_id_key;
        RAISE NOTICE 'Dropped old item_brands unique constraint';
    END IF;
END $$;

ALTER TABLE item_brands DROP CONSTRAINT IF EXISTS item_brands_item_merchant_unique;
ALTER TABLE item_brands ADD CONSTRAINT item_brands_item_merchant_unique
    UNIQUE(item_id, merchant_id);

-- ----------------------------------------
-- 8. gmc_settings - change from UNIQUE(setting_key) to UNIQUE(setting_key, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'gmc_settings_setting_key_key'
    ) THEN
        ALTER TABLE gmc_settings DROP CONSTRAINT gmc_settings_setting_key_key;
        RAISE NOTICE 'Dropped old gmc_settings unique constraint';
    END IF;
END $$;

ALTER TABLE gmc_settings DROP CONSTRAINT IF EXISTS gmc_settings_key_merchant_unique;
ALTER TABLE gmc_settings ADD CONSTRAINT gmc_settings_key_merchant_unique
    UNIQUE(setting_key, merchant_id);

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Multi-tenant constraint migration completed successfully!';
    RAISE NOTICE 'Updated unique constraints on: count_history, count_sessions, count_queue_daily,';
    RAISE NOTICE 'inventory_counts, brands, category_taxonomy_mapping, item_brands, gmc_settings';
END $$;
