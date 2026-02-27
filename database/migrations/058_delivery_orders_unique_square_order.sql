-- Migration: 058_delivery_orders_unique_square_order.sql
-- Date: 2026-02-27
-- Purpose: Add UNIQUE constraint on (square_order_id, merchant_id) to prevent
--          duplicate delivery orders from racing webhook events (P-10).
--
-- Background: Multiple order.updated webhooks for the same Square order can race
-- past both the in-memory event dedup (different event_ids) and the SELECT-then-INSERT
-- check in ingestSquareOrder(), creating duplicate delivery_orders rows.
-- A partial unique index is the authoritative database-level guard.

-- Drop the existing non-unique index (same name, non-unique)
DROP INDEX IF EXISTS idx_delivery_orders_square_order;

-- Create unique partial index — prevents duplicate rows for the same Square order per merchant
-- WHERE clause excludes NULL square_order_id (manual orders don't have one)
CREATE UNIQUE INDEX idx_delivery_orders_square_order
    ON delivery_orders(square_order_id, merchant_id)
    WHERE square_order_id IS NOT NULL;

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Migration 058: Created UNIQUE index idx_delivery_orders_square_order on delivery_orders(square_order_id, merchant_id)';
END $$;
