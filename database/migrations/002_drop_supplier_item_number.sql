-- Migration: Drop dead column supplier_item_number from variations (BACKLOG-89)
-- Vendor codes are stored in variation_vendors.vendor_code
-- This column had 0 populated rows across all merchants.

BEGIN;

ALTER TABLE variations DROP COLUMN IF EXISTS supplier_item_number;

COMMIT;
