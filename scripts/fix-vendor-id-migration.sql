-- One-time fix: Migrate vendor IDs that changed when Square reassigned them
-- Production crash 2026-02-27 20:12:39 — vendor "Pet Science (Friday)" was
-- deleted/recreated in Square with a new ID, but FK references blocked deletion.
--
-- Run with:
--   set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f scripts/fix-vendor-id-migration.sql

-- ============================================================
-- PREVIEW: Show what will be migrated (read-only)
-- ============================================================

\echo '=== PREVIEW: Vendor ID migrations ==='

\echo ''
\echo '--- Vendor: Pet Science (Friday) ---'
\echo 'Old ID: a97edfac-e0aa-4b78-a404-8c9042242bc6  ->  New ID: LATIW2VUCIP7OUID'

SELECT 'vendors' AS table_name, COUNT(*) AS row_count
FROM vendors WHERE id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
UNION ALL
SELECT 'variation_vendors', COUNT(*)
FROM variation_vendors WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
UNION ALL
SELECT 'purchase_orders', COUNT(*)
FROM purchase_orders WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
UNION ALL
SELECT 'vendor_catalog_items', COUNT(*)
FROM vendor_catalog_items WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
UNION ALL
SELECT 'bundle_definitions', COUNT(*)
FROM bundle_definitions WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
UNION ALL
SELECT 'loyalty_offers', COUNT(*)
FROM loyalty_offers WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6';

\echo ''
\echo '--- Check if 22F42RDV2COTJR2H also needs migration ---'
SELECT id, name, merchant_id FROM vendors WHERE id = '22F42RDV2COTJR2H';
-- If this vendor exists with this exact ID, no migration needed.
-- If it does NOT exist, check if a vendor with the same name exists under a different ID:
SELECT 'missing_vendor_check' AS check_type, v.id AS existing_id, v.name
FROM vendors v
WHERE v.merchant_id = 3
  AND v.name IN (
    SELECT name FROM vendors WHERE id = '22F42RDV2COTJR2H'
  )
  AND v.id != '22F42RDV2COTJR2H';

\echo ''
\echo '=== END PREVIEW — Review above before proceeding ==='
\echo 'The transaction below will perform the actual migration.'
\echo ''

-- ============================================================
-- MIGRATION: Wrapped in a transaction for safety
-- ============================================================

BEGIN;

-- Step 1: Check if old vendor exists and new vendor does NOT yet exist
DO $$
DECLARE
    v_old_id TEXT := 'a97edfac-e0aa-4b78-a404-8c9042242bc6';
    v_new_id TEXT := 'LATIW2VUCIP7OUID';
    v_merchant_id INTEGER := 3;
    v_old_exists BOOLEAN;
    v_new_exists BOOLEAN;
BEGIN
    SELECT EXISTS(SELECT 1 FROM vendors WHERE id = v_old_id AND merchant_id = v_merchant_id) INTO v_old_exists;
    SELECT EXISTS(SELECT 1 FROM vendors WHERE id = v_new_id AND merchant_id = v_merchant_id) INTO v_new_exists;

    IF NOT v_old_exists THEN
        RAISE NOTICE 'Old vendor % does not exist — nothing to migrate', v_old_id;
        RETURN;
    END IF;

    IF v_new_exists THEN
        -- New ID already exists (maybe a partial previous fix) — migrate FKs and delete old
        RAISE NOTICE 'New vendor % already exists — migrating FK references only', v_new_id;

        UPDATE variation_vendors SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        RAISE NOTICE 'variation_vendors migrated: % rows', (SELECT COUNT(*) FROM variation_vendors WHERE vendor_id = v_new_id AND merchant_id = v_merchant_id);

        UPDATE vendor_catalog_items SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE purchase_orders SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE bundle_definitions SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE loyalty_offers SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;

        DELETE FROM vendors WHERE id = v_old_id AND merchant_id = v_merchant_id;
        RAISE NOTICE 'Deleted old vendor %', v_old_id;
    ELSE
        -- Standard case: insert new vendor row, migrate FKs, delete old
        INSERT INTO vendors (id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at)
        SELECT v_new_id, name, status, contact_name, contact_email, contact_phone, merchant_id, CURRENT_TIMESTAMP
        FROM vendors WHERE id = v_old_id AND merchant_id = v_merchant_id;

        UPDATE variation_vendors SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE vendor_catalog_items SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE purchase_orders SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE bundle_definitions SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;
        UPDATE loyalty_offers SET vendor_id = v_new_id WHERE vendor_id = v_old_id AND merchant_id = v_merchant_id;

        DELETE FROM vendors WHERE id = v_old_id AND merchant_id = v_merchant_id;

        RAISE NOTICE 'Migrated vendor "Pet Science (Friday)" from % to %', v_old_id, v_new_id;
    END IF;
END $$;

-- Step 2: Verify migration
\echo '=== POST-MIGRATION VERIFICATION ==='
SELECT id, name, merchant_id FROM vendors WHERE id = 'LATIW2VUCIP7OUID';
SELECT 'variation_vendors' AS tbl, COUNT(*) FROM variation_vendors WHERE vendor_id = 'LATIW2VUCIP7OUID'
UNION ALL
SELECT 'purchase_orders', COUNT(*) FROM purchase_orders WHERE vendor_id = 'LATIW2VUCIP7OUID'
UNION ALL
SELECT 'vendor_catalog_items', COUNT(*) FROM vendor_catalog_items WHERE vendor_id = 'LATIW2VUCIP7OUID'
UNION ALL
SELECT 'bundle_definitions', COUNT(*) FROM bundle_definitions WHERE vendor_id = 'LATIW2VUCIP7OUID'
UNION ALL
SELECT 'loyalty_offers', COUNT(*) FROM loyalty_offers WHERE vendor_id = 'LATIW2VUCIP7OUID';

-- Confirm old ID has zero references
SELECT 'old_id_remaining' AS check_type, COUNT(*) AS total
FROM (
    SELECT vendor_id FROM variation_vendors WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
    UNION ALL
    SELECT vendor_id FROM purchase_orders WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
    UNION ALL
    SELECT vendor_id FROM vendor_catalog_items WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
    UNION ALL
    SELECT vendor_id FROM bundle_definitions WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
    UNION ALL
    SELECT vendor_id FROM loyalty_offers WHERE vendor_id = 'a97edfac-e0aa-4b78-a404-8c9042242bc6'
) sub;

COMMIT;

\echo '=== Migration complete ==='
