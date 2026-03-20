-- Migration: Add needs_customer_refresh flag for DRAFT orders
-- Purpose: Track delivery orders that need customer data refresh when order state changes
-- Related: Fix for "Unknown Customer" in delivery routing queue

-- Add flag to track orders needing customer refresh
ALTER TABLE delivery_orders
ADD COLUMN IF NOT EXISTS needs_customer_refresh BOOLEAN DEFAULT FALSE;

-- Add square_order_state to track order state changes
ALTER TABLE delivery_orders
ADD COLUMN IF NOT EXISTS square_order_state VARCHAR(50);

-- Index for efficient queries of orders needing refresh
CREATE INDEX IF NOT EXISTS idx_delivery_orders_needs_refresh
    ON delivery_orders(merchant_id, needs_customer_refresh)
    WHERE needs_customer_refresh = TRUE;

-- Update schema comments
COMMENT ON COLUMN delivery_orders.needs_customer_refresh IS 'TRUE when order was ingested with incomplete customer data (DRAFT state or missing recipient)';
COMMENT ON COLUMN delivery_orders.square_order_state IS 'Square order state (DRAFT, OPEN, COMPLETED, CANCELED) for tracking state changes';

-- Backfill: Mark existing Unknown Customer orders as needing refresh
UPDATE delivery_orders
SET needs_customer_refresh = TRUE
WHERE customer_name = 'Unknown Customer'
  AND status NOT IN ('completed', 'delivered');
