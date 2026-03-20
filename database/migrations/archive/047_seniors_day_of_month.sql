-- ========================================
-- MIGRATION: Add day_of_month to seniors config
-- ========================================
-- Makes the seniors discount day configurable per-tenant
-- (previously hardcoded to 1st of month in config/constants.js)

BEGIN;

ALTER TABLE seniors_discount_config
ADD COLUMN IF NOT EXISTS day_of_month INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN seniors_discount_config.day_of_month IS 'Day of month when seniors discount is active (1-28)';

DO $$
BEGIN
    RAISE NOTICE 'Migration 047: Added day_of_month to seniors_discount_config';
END $$;

COMMIT;
