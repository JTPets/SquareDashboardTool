-- Migration 030: Fix duplicate vendors
--
-- Problem: Race condition in findOrCreateVendor() allowed creating duplicate
-- vendors with the same name but different IDs.
--
-- Solution:
-- 1. Merge duplicate vendors (keep oldest by created_at)
-- 2. Update all foreign key references to point to kept vendor
-- 3. Delete duplicate vendors
-- 4. Add unique constraint to prevent future duplicates

BEGIN;

-- Step 1: Create a temporary table identifying duplicates and which to keep
CREATE TEMP TABLE vendor_duplicates AS
WITH ranked_vendors AS (
    SELECT
        id,
        name,
        merchant_id,
        created_at,
        LOWER(TRIM(name)) as normalized_name,
        ROW_NUMBER() OVER (
            PARTITION BY merchant_id, LOWER(TRIM(name))
            ORDER BY created_at ASC, id ASC
        ) as rn
    FROM vendors
    WHERE merchant_id IS NOT NULL
),
duplicate_groups AS (
    SELECT
        merchant_id,
        normalized_name,
        COUNT(*) as cnt
    FROM ranked_vendors
    GROUP BY merchant_id, normalized_name
    HAVING COUNT(*) > 1
)
SELECT
    rv.id as vendor_id,
    rv.name,
    rv.merchant_id,
    rv.normalized_name,
    rv.rn,
    FIRST_VALUE(rv.id) OVER (
        PARTITION BY rv.merchant_id, rv.normalized_name
        ORDER BY rv.created_at ASC, rv.id ASC
    ) as keep_vendor_id
FROM ranked_vendors rv
JOIN duplicate_groups dg
    ON rv.merchant_id = dg.merchant_id
    AND rv.normalized_name = dg.normalized_name;

-- Log what we're about to merge (for debugging)
DO $$
DECLARE
    dup_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO dup_count FROM vendor_duplicates WHERE vendor_id != keep_vendor_id;
    RAISE NOTICE 'Found % duplicate vendor records to merge', dup_count;
END $$;

-- Step 2: Update variation_vendors to point to kept vendor
UPDATE variation_vendors vv
SET vendor_id = vd.keep_vendor_id
FROM vendor_duplicates vd
WHERE vv.vendor_id = vd.vendor_id
  AND vd.vendor_id != vd.keep_vendor_id;

-- Handle any unique constraint violations by deleting duplicate mappings
DELETE FROM variation_vendors vv1
USING variation_vendors vv2
WHERE vv1.ctid < vv2.ctid
  AND vv1.variation_id = vv2.variation_id
  AND vv1.vendor_id = vv2.vendor_id
  AND vv1.merchant_id = vv2.merchant_id;

-- Step 3: Update purchase_orders to point to kept vendor
UPDATE purchase_orders po
SET vendor_id = vd.keep_vendor_id
FROM vendor_duplicates vd
WHERE po.vendor_id = vd.vendor_id
  AND vd.vendor_id != vd.keep_vendor_id;

-- Step 4: Update vendor_catalog_items to point to kept vendor
UPDATE vendor_catalog_items vci
SET vendor_id = vd.keep_vendor_id
FROM vendor_duplicates vd
WHERE vci.vendor_id = vd.vendor_id
  AND vd.vendor_id != vd.keep_vendor_id;

-- Handle unique constraint violations in vendor_catalog_items
-- (same vendor_id, vendor_item_number, import_batch_id)
-- Keep the most recent one
DELETE FROM vendor_catalog_items vci1
USING vendor_catalog_items vci2
WHERE vci1.id < vci2.id
  AND vci1.vendor_id = vci2.vendor_id
  AND vci1.vendor_item_number = vci2.vendor_item_number
  AND vci1.import_batch_id = vci2.import_batch_id;

-- Step 5: Delete duplicate vendors (keep only the first one per name+merchant)
DELETE FROM vendors v
USING vendor_duplicates vd
WHERE v.id = vd.vendor_id
  AND vd.vendor_id != vd.keep_vendor_id;

-- Step 6: Add unique constraint on merchant_id + normalized name
-- First create a function for the constraint if it doesn't exist
CREATE OR REPLACE FUNCTION vendor_name_normalized(name TEXT)
RETURNS TEXT AS $$
BEGIN
    RETURN LOWER(TRIM(name));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create unique index using the normalized name
-- This prevents duplicates even with different casing or leading/trailing spaces
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_merchant_name_unique
ON vendors (merchant_id, vendor_name_normalized(name))
WHERE merchant_id IS NOT NULL;

-- Clean up temp table
DROP TABLE IF EXISTS vendor_duplicates;

COMMIT;
