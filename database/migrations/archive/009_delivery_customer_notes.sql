-- ========================================
-- MIGRATION: Add customer ID and notes to delivery orders
-- ========================================
-- Adds square_customer_id to link delivery orders to Square customers
-- This enables fetching/editing customer notes (buzzer codes, delivery preferences)

BEGIN;

-- Add square_customer_id column to delivery_orders
ALTER TABLE delivery_orders
ADD COLUMN IF NOT EXISTS square_customer_id VARCHAR(255);

-- Add customer_note column to cache customer notes locally
-- This avoids repeated API calls and allows offline access
ALTER TABLE delivery_orders
ADD COLUMN IF NOT EXISTS customer_note TEXT;

-- Index for customer lookups
CREATE INDEX IF NOT EXISTS idx_delivery_orders_customer
    ON delivery_orders(merchant_id, square_customer_id)
    WHERE square_customer_id IS NOT NULL;

COMMENT ON COLUMN delivery_orders.square_customer_id IS 'Square customer ID for fetching customer profile/notes';
COMMENT ON COLUMN delivery_orders.customer_note IS 'Cached customer note from Square (buzzer codes, delivery instructions)';

COMMIT;
