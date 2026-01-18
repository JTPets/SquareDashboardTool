-- Migration 015: Add customer_source tracking to loyalty_purchase_events
-- Tracks how the customer was identified for each purchase event:
--   'order' - customer_id was on the order directly
--   'tender' - customer_id was on the payment tender
--   'loyalty_api' - customer was looked up via Square Loyalty API by order_id
--   'manual' - manually added via admin audit interface

ALTER TABLE loyalty_purchase_events
ADD COLUMN IF NOT EXISTS customer_source VARCHAR(20) DEFAULT 'order';

COMMENT ON COLUMN loyalty_purchase_events.customer_source IS 'How the customer was identified: order, tender, loyalty_api, or manual';
