-- Migration 043: Fix bundle_definitions.vendor_id column type
-- Changes vendor_id from INTEGER to TEXT to match vendors.id (TEXT PRIMARY KEY)
-- The vendors table uses Square vendor IDs (text strings) as primary keys,
-- so the FK must be TEXT, not INTEGER.

BEGIN;

-- Step 1: Change column type to TEXT (idempotent - no-op if already TEXT)
ALTER TABLE bundle_definitions ALTER COLUMN vendor_id TYPE TEXT USING vendor_id::TEXT;

-- Step 2: Drop existing FK constraint if present, then re-add
-- (handles re-running after partial failure)
ALTER TABLE bundle_definitions
    DROP CONSTRAINT IF EXISTS fk_bundle_definitions_vendor;

ALTER TABLE bundle_definitions
    ADD CONSTRAINT fk_bundle_definitions_vendor
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;

COMMIT;
