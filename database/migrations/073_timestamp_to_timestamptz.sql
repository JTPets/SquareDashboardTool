-- Migration 073: Convert all bare TIMESTAMP columns to TIMESTAMPTZ (DB-7)
-- The project uses America/Toronto timezone. Bare TIMESTAMP loses timezone info,
-- causing silent bugs when the server timezone differs from the database timezone.
-- PostgreSQL treats existing TIMESTAMP values as UTC during conversion (no data loss).
-- 66 columns across 31 tables.

BEGIN;

-- sync_history
ALTER TABLE sync_history ALTER COLUMN started_at TYPE TIMESTAMPTZ;
ALTER TABLE sync_history ALTER COLUMN completed_at TYPE TIMESTAMPTZ;

-- locations
ALTER TABLE locations ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE locations ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- vendors
ALTER TABLE vendors ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE vendors ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- categories
ALTER TABLE categories ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- images
ALTER TABLE images ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- items
ALTER TABLE items ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE items ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
ALTER TABLE items ALTER COLUMN deleted_at TYPE TIMESTAMPTZ;

-- variations
ALTER TABLE variations ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE variations ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
ALTER TABLE variations ALTER COLUMN deleted_at TYPE TIMESTAMPTZ;

-- variation_vendors
ALTER TABLE variation_vendors ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE variation_vendors ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- inventory_counts
ALTER TABLE inventory_counts ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- sales_velocity
ALTER TABLE sales_velocity ALTER COLUMN period_start_date TYPE TIMESTAMPTZ;
ALTER TABLE sales_velocity ALTER COLUMN period_end_date TYPE TIMESTAMPTZ;
ALTER TABLE sales_velocity ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- variation_location_settings
ALTER TABLE variation_location_settings ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE variation_location_settings ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- purchase_orders
ALTER TABLE purchase_orders ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE purchase_orders ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- purchase_order_items
ALTER TABLE purchase_order_items ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- count_history
ALTER TABLE count_history ALTER COLUMN last_counted_date TYPE TIMESTAMPTZ;
ALTER TABLE count_history ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- count_queue_priority
ALTER TABLE count_queue_priority ALTER COLUMN added_date TYPE TIMESTAMPTZ;
ALTER TABLE count_queue_priority ALTER COLUMN completed_date TYPE TIMESTAMPTZ;

-- count_queue_daily
ALTER TABLE count_queue_daily ALTER COLUMN added_date TYPE TIMESTAMPTZ;
ALTER TABLE count_queue_daily ALTER COLUMN completed_date TYPE TIMESTAMPTZ;

-- count_sessions
ALTER TABLE count_sessions ALTER COLUMN started_at TYPE TIMESTAMPTZ;
ALTER TABLE count_sessions ALTER COLUMN completed_at TYPE TIMESTAMPTZ;

-- vendor_catalog_items
ALTER TABLE vendor_catalog_items ALTER COLUMN imported_at TYPE TIMESTAMPTZ;
ALTER TABLE vendor_catalog_items ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- brands
ALTER TABLE brands ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE brands ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- google_taxonomy
ALTER TABLE google_taxonomy ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- category_taxonomy_mapping
ALTER TABLE category_taxonomy_mapping ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE category_taxonomy_mapping ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- item_brands
ALTER TABLE item_brands ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- gmc_settings
ALTER TABLE gmc_settings ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- gmc_feed_history
ALTER TABLE gmc_feed_history ALTER COLUMN generated_at TYPE TIMESTAMPTZ;

-- promo_codes
ALTER TABLE promo_codes ALTER COLUMN valid_from TYPE TIMESTAMPTZ;
ALTER TABLE promo_codes ALTER COLUMN valid_until TYPE TIMESTAMPTZ;
ALTER TABLE promo_codes ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE promo_codes ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- subscribers
ALTER TABLE subscribers ALTER COLUMN trial_start_date TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN trial_end_date TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN subscription_start_date TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN subscription_end_date TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN next_billing_date TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN canceled_at TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE subscribers ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- subscription_payments
ALTER TABLE subscription_payments ALTER COLUMN billing_period_start TYPE TIMESTAMPTZ;
ALTER TABLE subscription_payments ALTER COLUMN billing_period_end TYPE TIMESTAMPTZ;
ALTER TABLE subscription_payments ALTER COLUMN refunded_at TYPE TIMESTAMPTZ;
ALTER TABLE subscription_payments ALTER COLUMN created_at TYPE TIMESTAMPTZ;

-- subscription_events
ALTER TABLE subscription_events ALTER COLUMN processed_at TYPE TIMESTAMPTZ;

-- subscription_plans
ALTER TABLE subscription_plans ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE subscription_plans ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- promo_code_uses
ALTER TABLE promo_code_uses ALTER COLUMN used_at TYPE TIMESTAMPTZ;

-- loyalty_customers
ALTER TABLE loyalty_customers ALTER COLUMN first_seen_at TYPE TIMESTAMPTZ;
ALTER TABLE loyalty_customers ALTER COLUMN last_updated_at TYPE TIMESTAMPTZ;
ALTER TABLE loyalty_customers ALTER COLUMN last_order_at TYPE TIMESTAMPTZ;

COMMIT;
