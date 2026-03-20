-- Migration: 017_delivery_order_data
-- Description: Add column to store full Square order data for driver reference
-- This allows drivers to view order items when making deliveries

-- Add square_order_data column to store the full order JSON from Square
ALTER TABLE delivery_orders
ADD COLUMN IF NOT EXISTS square_order_data JSONB;

-- Add comment explaining the column
COMMENT ON COLUMN delivery_orders.square_order_data IS 'Full Square order data (line items, totals, etc.) for driver reference';

-- Log migration
DO $$
BEGIN
    RAISE NOTICE 'Added square_order_data column to delivery_orders table';
END $$;
