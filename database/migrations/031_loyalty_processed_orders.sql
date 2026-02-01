-- Migration: 031_loyalty_processed_orders
-- Description: Lightweight tracking table for all loyalty-processed orders
-- This tracks orders that were processed but had zero qualifying items,
-- preventing the catchup job from reprocessing them every hour.

-- Create the processed orders tracking table
CREATE TABLE IF NOT EXISTS loyalty_processed_orders (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_order_id TEXT NOT NULL,
    square_customer_id TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Tracks the processing result for debugging/reporting
    -- 'qualifying' = had qualifying items (also in loyalty_purchase_events)
    -- 'non_qualifying' = had items but none qualified for loyalty
    -- 'no_customer' = couldn't identify customer
    -- 'no_offers' = no active loyalty offers
    result_type TEXT NOT NULL DEFAULT 'non_qualifying',
    qualifying_items INTEGER DEFAULT 0,
    total_line_items INTEGER DEFAULT 0,
    trace_id TEXT,
    source TEXT DEFAULT 'WEBHOOK',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT loyalty_processed_orders_unique UNIQUE(merchant_id, square_order_id)
);

-- Index for the catchup job query
CREATE INDEX IF NOT EXISTS idx_loyalty_processed_orders_lookup
    ON loyalty_processed_orders(merchant_id, square_order_id);

-- Index for debugging/cleanup queries
CREATE INDEX IF NOT EXISTS idx_loyalty_processed_orders_result
    ON loyalty_processed_orders(merchant_id, result_type, processed_at);

COMMENT ON TABLE loyalty_processed_orders IS
    'Tracks all orders processed by loyalty system, including those with no qualifying items';
COMMENT ON COLUMN loyalty_processed_orders.result_type IS
    'Processing result: qualifying, non_qualifying, no_customer, no_offers';
