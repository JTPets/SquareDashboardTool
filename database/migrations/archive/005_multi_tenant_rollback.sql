-- =============================================================================
-- Rollback: 005_multi_tenant.sql
-- WARNING: This will remove all multi-tenant data and revert to single-tenant
-- =============================================================================

BEGIN;

-- Drop merchant_id columns from all tables (in reverse order)
ALTER TABLE sync_history DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE auth_audit_log DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE gmc_feed_history DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE gmc_settings DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE item_brands DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE category_taxonomy_mapping DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE brands DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE expiry_discount_settings DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE expiry_discount_audit_log DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE variation_discount_status DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE expiry_discount_tiers DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE variation_expiration DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE count_sessions DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE count_queue_daily DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE count_queue_priority DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE count_history DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE variation_location_settings DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE sales_velocity DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE purchase_order_items DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE purchase_orders DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE vendor_catalog_items DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE variation_vendors DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE vendors DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE inventory_counts DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE images DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE variations DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE items DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE categories DROP COLUMN IF EXISTS merchant_id;
ALTER TABLE locations DROP COLUMN IF EXISTS merchant_id;

-- Drop new tables (in dependency order)
DROP TABLE IF EXISTS oauth_states CASCADE;
DROP TABLE IF EXISTS merchant_invitations CASCADE;
DROP TABLE IF EXISTS user_merchants CASCADE;
DROP TABLE IF EXISTS merchants CASCADE;

-- Notify completion
DO $$
BEGIN
    RAISE NOTICE 'Rollback of migration 005_multi_tenant completed';
    RAISE NOTICE 'All merchant_id columns and multi-tenant tables have been removed';
END $$;

COMMIT;
