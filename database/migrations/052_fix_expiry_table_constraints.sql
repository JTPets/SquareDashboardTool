-- ========================================
-- MIGRATION 052: Fix expiry table PK constraints for multi-tenant
-- ========================================
-- Migration 007 updated unique constraints on many tables for multi-tenant
-- but missed variation_expiration and variation_discount_status, which kept
-- single-column PKs (variation_id only). Code uses ON CONFLICT (variation_id,
-- merchant_id), which requires a matching unique constraint — all upserts to
-- these tables silently fail without this fix.
--
-- Affected write paths:
--   services/catalog/inventory-service.js:434   (saveExpirations)
--   services/catalog/inventory-service.js:546   (markExpirationsReviewed)
--   services/square/api.js:1390                 (sync expiry from Square)
--   services/expiry/discount-service.js:267     (evaluateAllVariations)
--
-- Usage: psql -d your_database -f 052_fix_expiry_table_constraints.sql

-- ----------------------------------------
-- 1. Backfill NULL merchant_id rows
-- ----------------------------------------
-- Use the same legacy merchant lookup as migration 005
DO $$
DECLARE
    legacy_id INTEGER;
    null_count INTEGER;
BEGIN
    -- Find the legacy/default merchant
    SELECT id INTO legacy_id FROM merchants ORDER BY id LIMIT 1;

    IF legacy_id IS NULL THEN
        RAISE NOTICE 'No merchants found — skipping NULL backfill';
    ELSE
        -- Backfill variation_expiration
        SELECT COUNT(*) INTO null_count
        FROM variation_expiration WHERE merchant_id IS NULL;
        IF null_count > 0 THEN
            UPDATE variation_expiration SET merchant_id = legacy_id WHERE merchant_id IS NULL;
            RAISE NOTICE 'Backfilled % variation_expiration rows with merchant_id=%', null_count, legacy_id;
        ELSE
            RAISE NOTICE 'variation_expiration: no NULL merchant_id rows';
        END IF;

        -- Backfill variation_discount_status
        SELECT COUNT(*) INTO null_count
        FROM variation_discount_status WHERE merchant_id IS NULL;
        IF null_count > 0 THEN
            UPDATE variation_discount_status SET merchant_id = legacy_id WHERE merchant_id IS NULL;
            RAISE NOTICE 'Backfilled % variation_discount_status rows with merchant_id=%', null_count, legacy_id;
        ELSE
            RAISE NOTICE 'variation_discount_status: no NULL merchant_id rows';
        END IF;
    END IF;
END $$;

-- ----------------------------------------
-- 2. Make merchant_id NOT NULL (required for composite PK)
-- ----------------------------------------
ALTER TABLE variation_expiration ALTER COLUMN merchant_id SET NOT NULL;
ALTER TABLE variation_discount_status ALTER COLUMN merchant_id SET NOT NULL;

-- ----------------------------------------
-- 3. variation_expiration — PK from (variation_id) to (variation_id, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variation_expiration_pkey'
          AND conrelid = 'variation_expiration'::regclass
    ) THEN
        ALTER TABLE variation_expiration DROP CONSTRAINT variation_expiration_pkey;
        RAISE NOTICE 'Dropped old variation_expiration single-column PK';
    END IF;
END $$;

ALTER TABLE variation_expiration
    ADD CONSTRAINT variation_expiration_pkey PRIMARY KEY (variation_id, merchant_id);

-- ----------------------------------------
-- 4. variation_discount_status — PK from (variation_id) to (variation_id, merchant_id)
-- ----------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variation_discount_status_pkey'
          AND conrelid = 'variation_discount_status'::regclass
    ) THEN
        ALTER TABLE variation_discount_status DROP CONSTRAINT variation_discount_status_pkey;
        RAISE NOTICE 'Dropped old variation_discount_status single-column PK';
    END IF;
END $$;

ALTER TABLE variation_discount_status
    ADD CONSTRAINT variation_discount_status_pkey PRIMARY KEY (variation_id, merchant_id);

-- ----------------------------------------
-- 5. Verify
-- ----------------------------------------
DO $$
DECLARE
    ve_cols TEXT;
    vds_cols TEXT;
BEGIN
    SELECT string_agg(a.attname, ', ' ORDER BY array_position(i.indkey, a.attnum))
    INTO ve_cols
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'variation_expiration'::regclass AND i.indisprimary;

    SELECT string_agg(a.attname, ', ' ORDER BY array_position(i.indkey, a.attnum))
    INTO vds_cols
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'variation_discount_status'::regclass AND i.indisprimary;

    RAISE NOTICE 'variation_expiration PK columns: %', ve_cols;
    RAISE NOTICE 'variation_discount_status PK columns: %', vds_cols;

    IF ve_cols != 'variation_id, merchant_id' THEN
        RAISE EXCEPTION 'variation_expiration PK mismatch — expected (variation_id, merchant_id), got (%)', ve_cols;
    END IF;
    IF vds_cols != 'variation_id, merchant_id' THEN
        RAISE EXCEPTION 'variation_discount_status PK mismatch — expected (variation_id, merchant_id), got (%)', vds_cols;
    END IF;

    RAISE NOTICE 'Migration 052 completed successfully!';
    RAISE NOTICE 'Updated PKs: variation_expiration, variation_discount_status → (variation_id, merchant_id)';
END $$;
