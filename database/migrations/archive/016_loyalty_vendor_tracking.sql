-- Migration 016: Add vendor tracking to loyalty offers and payment type to purchase events
-- This enables proper vendor credit reporting per Big Country Raw's Frequent Buyer Policy

-- Add vendor reference to loyalty offers
ALTER TABLE loyalty_offers
ADD COLUMN IF NOT EXISTS vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS vendor_name TEXT,
ADD COLUMN IF NOT EXISTS vendor_email TEXT;

COMMENT ON COLUMN loyalty_offers.vendor_id IS 'Reference to vendor for credit submission';
COMMENT ON COLUMN loyalty_offers.vendor_name IS 'Cached vendor name for reports';
COMMENT ON COLUMN loyalty_offers.vendor_email IS 'Vendor email for credit submissions';

-- Add payment type tracking to purchase events
ALTER TABLE loyalty_purchase_events
ADD COLUMN IF NOT EXISTS payment_type TEXT;

COMMENT ON COLUMN loyalty_purchase_events.payment_type IS 'Payment method: CARD, CASH, WALLET, etc.';

-- Create index for vendor-based reporting
CREATE INDEX IF NOT EXISTS idx_loyalty_offers_vendor ON loyalty_offers(vendor_id) WHERE vendor_id IS NOT NULL;
