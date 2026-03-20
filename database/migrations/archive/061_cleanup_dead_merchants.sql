-- Migration 061: Clean up dead merchants 1 and 2
--
-- Merchant 1: dead, pre-multi-tenant legacy
-- Merchant 2: dead, test account
-- Merchant 3: JT Pets (active, primary merchant)
--
-- Deletes all rows referencing merchant_id 1 or 2 across all tables,
-- then deletes the merchant records themselves.
-- Respects FK order: children first, then parents.

-- UP

DO $$
DECLARE
    dead_ids INTEGER[] := ARRAY[1, 2];
    total_deleted BIGINT := 0;
    tables_touched INTEGER := 0;
    row_count BIGINT;
BEGIN
    RAISE NOTICE 'Starting dead merchant cleanup for merchant IDs: 1, 2';
    RAISE NOTICE '=========================================================';

    -- Verify merchants 1 and 2 exist
    SELECT COUNT(*) INTO row_count FROM merchants WHERE id = ANY(dead_ids);
    IF row_count = 0 THEN
        RAISE NOTICE 'No merchants found with IDs 1 or 2 — nothing to clean up';
        RETURN;
    END IF;
    RAISE NOTICE 'Found % merchant(s) to delete', row_count;

    -- ==================== DELIVERY MODULE (deepest children first) ====================

    -- delivery_pod depends on delivery_orders (FK cascade), delete explicitly for logging
    DELETE FROM delivery_pod WHERE delivery_order_id IN (
        SELECT id FROM delivery_orders WHERE merchant_id = ANY(dead_ids)
    );
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'delivery_pod: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM delivery_route_tokens WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'delivery_route_tokens: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM delivery_audit_log WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'delivery_audit_log: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM delivery_orders WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'delivery_orders: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM delivery_routes WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'delivery_routes: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM delivery_settings WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'delivery_settings: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== LOYALTY MODULE (children first) ====================

    DELETE FROM loyalty_customer_summary WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_customer_summary: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_audit_logs WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_audit_logs: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_redemptions WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_redemptions: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_rewards WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_rewards: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_purchase_events WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_purchase_events: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_qualifying_variations WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_qualifying_variations: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_settings WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_settings: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM loyalty_offers WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'loyalty_offers: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== EXPIRY DISCOUNT MODULE ====================

    DELETE FROM variation_discount_status WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'variation_discount_status: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM expiry_discount_audit_log WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'expiry_discount_audit_log: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM expiry_discount_tiers WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'expiry_discount_tiers: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM expiry_discount_settings WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'expiry_discount_settings: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== INVENTORY / CATALOG (children before parents) ====================

    DELETE FROM purchase_order_items WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'purchase_order_items: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM purchase_orders WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'purchase_orders: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM bundle_definitions WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'bundle_definitions: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM committed_inventory WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'committed_inventory: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM variation_expiration WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'variation_expiration: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM variation_vendors WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'variation_vendors: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM variation_location_settings WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'variation_location_settings: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM sales_velocity WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'sales_velocity: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM inventory_counts WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'inventory_counts: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM count_history WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'count_history: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM count_queue_priority WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'count_queue_priority: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM count_queue_daily WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'count_queue_daily: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM count_sessions WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'count_sessions: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM vendor_catalog_items WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'vendor_catalog_items: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM images WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'images: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM variations WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'variations: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM items WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'items: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM categories WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'categories: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM item_brands WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'item_brands: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM brands WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'brands: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM category_taxonomy_mapping WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'category_taxonomy_mapping: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== GMC MODULE ====================

    DELETE FROM gmc_feed_history WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'gmc_feed_history: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM gmc_settings WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'gmc_settings: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== VENDOR / LOCATION / SYNC ====================

    DELETE FROM vendors WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'vendors: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM locations WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'locations: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM sync_history WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'sync_history: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== WEBHOOK / USER-MERCHANT LINK ====================

    DELETE FROM webhook_events WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'webhook_events: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    DELETE FROM user_merchants WHERE merchant_id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'user_merchants: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    -- ==================== FINALLY: DELETE MERCHANT RECORDS ====================

    DELETE FROM merchants WHERE id = ANY(dead_ids);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    IF row_count > 0 THEN
        RAISE NOTICE 'merchants: deleted % rows', row_count;
        total_deleted := total_deleted + row_count;
        tables_touched := tables_touched + 1;
    END IF;

    RAISE NOTICE '=========================================================';
    RAISE NOTICE 'Cleaned up % orphaned rows across % tables for dead merchants 1, 2', total_deleted, tables_touched;
END $$;

-- DOWN (rollback)
-- Cannot undo data deletion. Dead merchants 1, 2 were pre-multi-tenant legacy accounts
-- with no real data. If restoration is needed, restore from backup.
