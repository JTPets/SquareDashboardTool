-- ========================================
-- MIGRATION 022: Fix missing merchant_id columns
-- ========================================
-- HOTFIX: Several core tables were missing the merchant_id column
-- that is required for multi-tenant operation. This migration
-- adds the missing columns and backfills them from existing data.
--
-- Tables fixed:
--   - locations
--   - vendors
--   - categories
--   - images
--   - items
--   - variations
--   - purchase_orders
--   - purchase_order_items
--
-- Usage: psql -d your_database -f 022_fix_missing_merchant_id.sql
-- ========================================

BEGIN;

-- ----------------------------------------
-- 1. Add merchant_id to locations
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'locations' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE locations ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to locations table';
    ELSE
        RAISE NOTICE 'locations.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 2. Add merchant_id to vendors
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vendors' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE vendors ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to vendors table';
    ELSE
        RAISE NOTICE 'vendors.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 3. Add merchant_id to categories
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'categories' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE categories ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to categories table';
    ELSE
        RAISE NOTICE 'categories.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 4. Add merchant_id to images
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'images' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE images ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to images table';
    ELSE
        RAISE NOTICE 'images.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 5. Add merchant_id to items
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'items' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE items ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to items table';
    ELSE
        RAISE NOTICE 'items.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 6. Add merchant_id to variations
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'variations' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE variations ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to variations table';
    ELSE
        RAISE NOTICE 'variations.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 7. Add merchant_id to purchase_orders
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_orders' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE purchase_orders ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to purchase_orders table';
    ELSE
        RAISE NOTICE 'purchase_orders.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 8. Add merchant_id to purchase_order_items
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_order_items' AND column_name = 'merchant_id'
    ) THEN
        ALTER TABLE purchase_order_items ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
        RAISE NOTICE 'Added merchant_id to purchase_order_items table';
    ELSE
        RAISE NOTICE 'purchase_order_items.merchant_id already exists, skipping';
    END IF;
END $$;

-- ----------------------------------------
-- 9. Backfill merchant_id from existing data
-- ----------------------------------------
-- If there's only one merchant, assign all orphaned records to it
DO $$
DECLARE
    v_merchant_id INTEGER;
    v_merchant_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_merchant_count FROM merchants;

    IF v_merchant_count = 1 THEN
        SELECT id INTO v_merchant_id FROM merchants LIMIT 1;

        -- Backfill all tables
        UPDATE locations SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE vendors SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE categories SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE images SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE items SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE variations SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE purchase_orders SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;
        UPDATE purchase_order_items SET merchant_id = v_merchant_id WHERE merchant_id IS NULL;

        RAISE NOTICE 'Backfilled merchant_id = % for all orphaned records', v_merchant_id;
    ELSIF v_merchant_count > 1 THEN
        RAISE NOTICE 'Multiple merchants found - skipping automatic backfill';
        RAISE NOTICE 'You will need to manually assign merchant_id to orphaned records';
        RAISE NOTICE 'Example: UPDATE vendors SET merchant_id = X WHERE merchant_id IS NULL;';
    ELSE
        RAISE NOTICE 'No merchants found - skipping backfill';
    END IF;
END $$;

-- ----------------------------------------
-- 10. Create indexes for multi-tenant queries
-- ----------------------------------------
CREATE INDEX IF NOT EXISTS idx_locations_merchant ON locations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_vendors_merchant ON vendors(merchant_id);
CREATE INDEX IF NOT EXISTS idx_categories_merchant ON categories(merchant_id);
CREATE INDEX IF NOT EXISTS idx_images_merchant ON images(merchant_id);
CREATE INDEX IF NOT EXISTS idx_items_merchant ON items(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variations_merchant ON variations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_merchant ON purchase_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_merchant ON purchase_order_items(merchant_id);

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Migration 022 completed successfully!';
    RAISE NOTICE 'Added merchant_id to 8 tables:';
    RAISE NOTICE '  - locations';
    RAISE NOTICE '  - vendors';
    RAISE NOTICE '  - categories';
    RAISE NOTICE '  - images';
    RAISE NOTICE '  - items';
    RAISE NOTICE '  - variations';
    RAISE NOTICE '  - purchase_orders';
    RAISE NOTICE '  - purchase_order_items';
    RAISE NOTICE 'Created 8 indexes for multi-tenant queries';
    RAISE NOTICE '========================================';
END $$;

COMMIT;
