-- Migration: 036_vendor_credit_tracking.sql
-- Description: Add vendor credit submission tracking to loyalty_rewards
-- Date: 2026-02-02

-- Add columns to track vendor credit submission status
ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS vendor_credit_status VARCHAR(20) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS vendor_credit_submitted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS vendor_credit_resolved_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS vendor_credit_notes TEXT;

-- Add constraint for valid status values
-- Only redeemed rewards can have vendor credit status
ALTER TABLE loyalty_rewards
ADD CONSTRAINT vendor_credit_status_check
CHECK (vendor_credit_status IS NULL OR vendor_credit_status IN ('SUBMITTED', 'CREDITED', 'DENIED'));

-- Add index for efficient filtering by vendor credit status
-- Useful for dashboard views showing pending vendor credits
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_vendor_credit_status
ON loyalty_rewards(merchant_id, vendor_credit_status)
WHERE vendor_credit_status IS NOT NULL;

COMMENT ON COLUMN loyalty_rewards.vendor_credit_status IS 'Vendor credit submission status: SUBMITTED, CREDITED, or DENIED';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_submitted_at IS 'Timestamp when reward was submitted for vendor credit';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_resolved_at IS 'Timestamp when vendor credit was credited or denied';
COMMENT ON COLUMN loyalty_rewards.vendor_credit_notes IS 'Notes about vendor credit (invoice number, denial reason, etc.)';
