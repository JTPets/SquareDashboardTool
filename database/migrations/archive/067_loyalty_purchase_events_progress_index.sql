-- Migration 067: Add composite index for reward progress queries (LA-19)
--
-- The updateRewardProgress() function queries loyalty_purchase_events
-- on every purchase webhook with a 5-column filter. This index covers
-- the exact query pattern with a partial index on reward_id IS NULL.

CREATE INDEX IF NOT EXISTS idx_lpe_reward_progress
ON loyalty_purchase_events (merchant_id, offer_id, square_customer_id, window_end_date)
WHERE reward_id IS NULL;
