BEGIN;

-- Migration 015: vendor_catalog_items deduplication
--
-- Problem: UNIQUE(vendor_id, vendor_item_number, import_batch_id) allowed the
-- same product to accumulate a new row for every import batch, causing thousands
-- of duplicates (e.g. UPC 815260005012 appearing 5× from the same vendor).
--
-- Fix: change the uniqueness guarantee to (merchant_id, vendor_id, vendor_item_number)
-- so re-importing the same vendor catalog UPSERTs existing rows instead of
-- appending new ones. import_batch_id is updated in-place to the latest batch.
--
-- Step 1: collapse duplicates — keep the best row per (merchant_id, vendor_id,
--         vendor_item_number): prefer matched rows, break ties by newest id.
-- Step 2: drop old constraint, add new one.

-- Step 1: for each duplicate group, update the "keeper" row with the latest
-- import_batch_id, then delete the extras.

-- 1a. For each group, identify the keeper (matched first, then highest id)
--     and update it to carry the newest import_batch_id in the group.
WITH ranked AS (
    SELECT
        id,
        import_batch_id,
        imported_at,
        ROW_NUMBER() OVER (
            PARTITION BY merchant_id, vendor_id, vendor_item_number
            ORDER BY (matched_variation_id IS NOT NULL) DESC, id DESC
        ) AS rn,
        FIRST_VALUE(import_batch_id) OVER (
            PARTITION BY merchant_id, vendor_id, vendor_item_number
            ORDER BY imported_at DESC, id DESC
        ) AS latest_batch_id
    FROM vendor_catalog_items
),
keepers AS (
    SELECT id, latest_batch_id FROM ranked WHERE rn = 1
)
UPDATE vendor_catalog_items vci
SET    import_batch_id = k.latest_batch_id,
       updated_at      = NOW()
FROM   keepers k
WHERE  vci.id = k.id
  AND  vci.import_batch_id IS DISTINCT FROM k.latest_batch_id;

-- 1b. Delete duplicate rows (all non-keeper rows in groups with count > 1).
DELETE FROM vendor_catalog_items
WHERE id NOT IN (
    SELECT DISTINCT ON (merchant_id, vendor_id, vendor_item_number) id
    FROM vendor_catalog_items
    ORDER BY merchant_id, vendor_id, vendor_item_number,
             (matched_variation_id IS NOT NULL) DESC,
             id DESC
);

-- Step 2: swap unique constraints.
ALTER TABLE vendor_catalog_items
    DROP CONSTRAINT IF EXISTS vendor_catalog_items_vendor_id_vendor_item_number_import_batc_key;

ALTER TABLE vendor_catalog_items
    ADD CONSTRAINT vendor_catalog_items_merchant_vendor_item_unique
    UNIQUE (merchant_id, vendor_id, vendor_item_number);

-- Add a composite index that supports the new conflict target quickly.
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_dedup
    ON vendor_catalog_items (merchant_id, vendor_id, vendor_item_number);

COMMIT;
