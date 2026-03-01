-- Migration 060: Add NOT NULL constraints to merchant_id on core tables
--
-- Defense-in-depth: prevents orphaned rows if application code ever
-- inserts without merchant_id. All 25 tables listed had nullable
-- merchant_id REFERENCES merchants(id) without NOT NULL.
--
-- SAFETY: Each ALTER is wrapped in a DO block that first checks for NULL rows.
-- If any NULL rows exist, they are logged and the constraint is skipped for
-- that table (manual review required).

-- UP

DO $$
DECLARE
    null_count INTEGER;
    tables_with_nulls TEXT[] := '{}';
    t TEXT;
BEGIN
    -- Check all tables for NULL merchant_id rows before adding constraints
    -- Tables to constrain:
    RAISE NOTICE 'Checking for NULL merchant_id rows across 25 tables...';

    -- sync_history
    SELECT COUNT(*) INTO null_count FROM sync_history WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'sync_history has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'sync_history');
    ELSE
        ALTER TABLE sync_history ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'sync_history: NOT NULL constraint added';
    END IF;

    -- locations
    SELECT COUNT(*) INTO null_count FROM locations WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'locations has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'locations');
    ELSE
        ALTER TABLE locations ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'locations: NOT NULL constraint added';
    END IF;

    -- vendors
    SELECT COUNT(*) INTO null_count FROM vendors WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'vendors has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'vendors');
    ELSE
        ALTER TABLE vendors ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'vendors: NOT NULL constraint added';
    END IF;

    -- categories
    SELECT COUNT(*) INTO null_count FROM categories WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'categories has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'categories');
    ELSE
        ALTER TABLE categories ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'categories: NOT NULL constraint added';
    END IF;

    -- images
    SELECT COUNT(*) INTO null_count FROM images WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'images has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'images');
    ELSE
        ALTER TABLE images ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'images: NOT NULL constraint added';
    END IF;

    -- items
    SELECT COUNT(*) INTO null_count FROM items WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'items has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'items');
    ELSE
        ALTER TABLE items ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'items: NOT NULL constraint added';
    END IF;

    -- variations
    SELECT COUNT(*) INTO null_count FROM variations WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'variations has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'variations');
    ELSE
        ALTER TABLE variations ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'variations: NOT NULL constraint added';
    END IF;

    -- variation_vendors
    SELECT COUNT(*) INTO null_count FROM variation_vendors WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'variation_vendors has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'variation_vendors');
    ELSE
        ALTER TABLE variation_vendors ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'variation_vendors: NOT NULL constraint added';
    END IF;

    -- inventory_counts
    SELECT COUNT(*) INTO null_count FROM inventory_counts WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'inventory_counts has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'inventory_counts');
    ELSE
        ALTER TABLE inventory_counts ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'inventory_counts: NOT NULL constraint added';
    END IF;

    -- sales_velocity
    SELECT COUNT(*) INTO null_count FROM sales_velocity WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'sales_velocity has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'sales_velocity');
    ELSE
        ALTER TABLE sales_velocity ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'sales_velocity: NOT NULL constraint added';
    END IF;

    -- variation_location_settings
    SELECT COUNT(*) INTO null_count FROM variation_location_settings WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'variation_location_settings has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'variation_location_settings');
    ELSE
        ALTER TABLE variation_location_settings ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'variation_location_settings: NOT NULL constraint added';
    END IF;

    -- purchase_orders
    SELECT COUNT(*) INTO null_count FROM purchase_orders WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'purchase_orders has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'purchase_orders');
    ELSE
        ALTER TABLE purchase_orders ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'purchase_orders: NOT NULL constraint added';
    END IF;

    -- purchase_order_items
    SELECT COUNT(*) INTO null_count FROM purchase_order_items WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'purchase_order_items has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'purchase_order_items');
    ELSE
        ALTER TABLE purchase_order_items ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'purchase_order_items: NOT NULL constraint added';
    END IF;

    -- count_history
    SELECT COUNT(*) INTO null_count FROM count_history WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'count_history has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'count_history');
    ELSE
        ALTER TABLE count_history ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'count_history: NOT NULL constraint added';
    END IF;

    -- count_queue_priority
    SELECT COUNT(*) INTO null_count FROM count_queue_priority WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'count_queue_priority has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'count_queue_priority');
    ELSE
        ALTER TABLE count_queue_priority ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'count_queue_priority: NOT NULL constraint added';
    END IF;

    -- count_queue_daily
    SELECT COUNT(*) INTO null_count FROM count_queue_daily WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'count_queue_daily has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'count_queue_daily');
    ELSE
        ALTER TABLE count_queue_daily ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'count_queue_daily: NOT NULL constraint added';
    END IF;

    -- count_sessions
    SELECT COUNT(*) INTO null_count FROM count_sessions WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'count_sessions has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'count_sessions');
    ELSE
        ALTER TABLE count_sessions ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'count_sessions: NOT NULL constraint added';
    END IF;

    -- vendor_catalog_items
    SELECT COUNT(*) INTO null_count FROM vendor_catalog_items WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'vendor_catalog_items has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'vendor_catalog_items');
    ELSE
        ALTER TABLE vendor_catalog_items ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'vendor_catalog_items: NOT NULL constraint added';
    END IF;

    -- brands
    SELECT COUNT(*) INTO null_count FROM brands WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'brands has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'brands');
    ELSE
        ALTER TABLE brands ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'brands: NOT NULL constraint added';
    END IF;

    -- category_taxonomy_mapping
    SELECT COUNT(*) INTO null_count FROM category_taxonomy_mapping WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'category_taxonomy_mapping has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'category_taxonomy_mapping');
    ELSE
        ALTER TABLE category_taxonomy_mapping ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'category_taxonomy_mapping: NOT NULL constraint added';
    END IF;

    -- item_brands
    SELECT COUNT(*) INTO null_count FROM item_brands WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'item_brands has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'item_brands');
    ELSE
        ALTER TABLE item_brands ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'item_brands: NOT NULL constraint added';
    END IF;

    -- gmc_settings
    SELECT COUNT(*) INTO null_count FROM gmc_settings WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'gmc_settings has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'gmc_settings');
    ELSE
        ALTER TABLE gmc_settings ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'gmc_settings: NOT NULL constraint added';
    END IF;

    -- gmc_feed_history
    SELECT COUNT(*) INTO null_count FROM gmc_feed_history WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'gmc_feed_history has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'gmc_feed_history');
    ELSE
        ALTER TABLE gmc_feed_history ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'gmc_feed_history: NOT NULL constraint added';
    END IF;

    -- expiry_discount_tiers
    SELECT COUNT(*) INTO null_count FROM expiry_discount_tiers WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'expiry_discount_tiers has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'expiry_discount_tiers');
    ELSE
        ALTER TABLE expiry_discount_tiers ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'expiry_discount_tiers: NOT NULL constraint added';
    END IF;

    -- expiry_discount_settings
    SELECT COUNT(*) INTO null_count FROM expiry_discount_settings WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'expiry_discount_settings has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'expiry_discount_settings');
    ELSE
        ALTER TABLE expiry_discount_settings ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'expiry_discount_settings: NOT NULL constraint added';
    END IF;

    -- Summary
    IF array_length(tables_with_nulls, 1) IS NULL THEN
        RAISE NOTICE 'All 25 tables updated with NOT NULL constraint on merchant_id';
    ELSE
        RAISE WARNING 'Tables skipped due to NULL merchant_id rows: %', array_to_string(tables_with_nulls, ', ');
        RAISE WARNING 'Manual review required: assign orphaned rows to correct merchant or DELETE';
    END IF;
END $$;

-- DOWN (rollback) — removes NOT NULL constraints
-- Each ALTER is safe to run even if NOT NULL was never added (idempotent)
-- ALTER TABLE sync_history ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE locations ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE vendors ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE categories ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE images ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE items ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE variations ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE variation_vendors ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE inventory_counts ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE sales_velocity ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE variation_location_settings ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE purchase_orders ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE purchase_order_items ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE count_history ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE count_queue_priority ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE count_queue_daily ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE count_sessions ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE vendor_catalog_items ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE brands ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE category_taxonomy_mapping ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE item_brands ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE gmc_settings ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE gmc_feed_history ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE expiry_discount_tiers ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE expiry_discount_settings ALTER COLUMN merchant_id DROP NOT NULL;
