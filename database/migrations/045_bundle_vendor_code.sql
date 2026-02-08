-- Migration 045: Add vendor_code to bundle_definitions
-- Allows storing the vendor's product code for the bundle as a case/set order
-- Since Square doesn't support vendor info for bundles, we track it locally

ALTER TABLE bundle_definitions ADD COLUMN IF NOT EXISTS vendor_code TEXT;

COMMENT ON COLUMN bundle_definitions.vendor_code IS 'Vendor product code for ordering the bundle as a case/set';
