-- Migration: 038_backfill_cart_activity.sql
-- Purpose: Backfill existing DRAFT orders from delivery_orders to cart_activity, then remove from delivery_orders
-- Date: 2026-02-03
-- Note: Run this AFTER 037_cart_activity.sql

-- Backfill existing DRAFT orders to cart_activity
INSERT INTO cart_activity (
    merchant_id,
    square_order_id,
    square_customer_id,
    phone_last4,
    cart_total_cents,
    item_count,
    items_json,
    source_name,
    fulfillment_type,
    status,
    created_at,
    updated_at
)
SELECT
    merchant_id,
    square_order_id,
    square_customer_id,
    RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 4),
    CASE
        WHEN square_order_data->'totalMoney'->>'amount' IS NOT NULL
        THEN (square_order_data->'totalMoney'->>'amount')::integer
        ELSE NULL
    END,
    CASE
        WHEN square_order_data->'lineItems' IS NOT NULL
        THEN jsonb_array_length(square_order_data->'lineItems')
        ELSE 0
    END,
    square_order_data->'lineItems',
    COALESCE(square_order_data->'source'->>'name', 'Unknown'),
    'DELIVERY',
    'pending',
    created_at,
    updated_at
FROM delivery_orders
WHERE square_order_state = 'DRAFT'
  AND square_order_id IS NOT NULL
ON CONFLICT (merchant_id, square_order_id) DO NOTHING;

-- Delete DRAFT orders from delivery_orders after backfill
DELETE FROM delivery_orders
WHERE square_order_state = 'DRAFT';

-- Log the migration
DO $$
DECLARE
    cart_count INTEGER;
    deleted_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO cart_count FROM cart_activity WHERE status = 'pending';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RAISE NOTICE 'Backfill complete: % cart_activity records created', cart_count;
END $$;
