-- Migration 013: Add receipt URL tracking to loyalty purchase events
-- Purpose: Store Square receipt URLs for vendor redemption reports

-- Add receipt_url column to loyalty_purchase_events
ALTER TABLE loyalty_purchase_events
ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- Add index for order lookups (receipt URL fetching)
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_order_lookup
ON loyalty_purchase_events(square_order_id, merchant_id);

-- Comment explaining the column
COMMENT ON COLUMN loyalty_purchase_events.receipt_url IS 'Square receipt URL from order tenders - for vendor redemption verification';

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Migration 013 complete: Added receipt_url to loyalty_purchase_events';
END $$;
