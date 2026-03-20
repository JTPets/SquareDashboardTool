-- Migration 064: Add square_sync_pending column to loyalty_rewards
-- Tracks rewards where Square discount creation failed and needs retry.
-- Part of LA-4 fix: fire-and-forget createSquareCustomerGroupDiscount()
-- can silently fail, leaving reward earned in DB but not synced to POS.

ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_sync_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for the retry job to efficiently find pending rewards
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_sync_pending
    ON loyalty_rewards(merchant_id, status)
    WHERE square_sync_pending = TRUE AND status = 'earned';

COMMENT ON COLUMN loyalty_rewards.square_sync_pending IS 'True when Square discount creation failed and needs retry (LA-4 fix)';
