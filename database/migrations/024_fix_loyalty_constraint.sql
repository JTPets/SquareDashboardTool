-- ========================================
-- MIGRATION: Fix Loyalty Rewards Constraint
-- ========================================
-- Fixes issue where the unique constraint on loyalty_rewards blocks
-- customers from earning multiple rewards over time.
--
-- PROBLEM:
-- The existing constraint UNIQUE(merchant_id, offer_id, square_customer_id)
-- applies to ALL rewards regardless of status. Once a customer has ANY reward
-- (in_progress, earned, redeemed, or revoked), they cannot create another
-- one for the same offer.
--
-- SOLUTION:
-- Replace with a partial unique index that only applies to 'in_progress' status.
-- This allows customers to:
-- 1. Have exactly ONE in_progress reward per offer at a time
-- 2. Have unlimited redeemed/revoked rewards (historical)
-- 3. Start a new reward cycle after redeeming previous rewards
--
-- Usage: psql -d your_database -f 024_fix_loyalty_constraint.sql

BEGIN;

-- ----------------------------------------
-- 1. Drop the problematic constraint
-- ----------------------------------------
-- The constraint name from 010_loyalty_program.sql line 200
ALTER TABLE loyalty_rewards
  DROP CONSTRAINT IF EXISTS loyalty_rewards_one_in_progress;

-- ----------------------------------------
-- 2. Create partial unique index
-- ----------------------------------------
-- This ensures only ONE in_progress reward per customer per offer,
-- but allows multiple earned/redeemed/revoked rewards to exist
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_rewards_one_in_progress_idx
  ON loyalty_rewards (merchant_id, offer_id, square_customer_id)
  WHERE status = 'in_progress';

-- ----------------------------------------
-- 3. Add covering index for common query pattern (Issue #12)
-- ----------------------------------------
-- The query pattern `WHERE window_end_date >= CURRENT_DATE AND reward_id IS NULL`
-- is used frequently for finding active unlocked purchases
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_active_unlocked
  ON loyalty_purchase_events (merchant_id, offer_id, square_customer_id, window_end_date)
  WHERE reward_id IS NULL;

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Migration 024_fix_loyalty_constraint completed successfully!';
    RAISE NOTICE 'Changes applied:';
    RAISE NOTICE '  - Dropped constraint: loyalty_rewards_one_in_progress';
    RAISE NOTICE '  - Created partial unique index: loyalty_rewards_one_in_progress_idx (only for in_progress status)';
    RAISE NOTICE '  - Created covering index: idx_loyalty_purchase_events_active_unlocked';
    RAISE NOTICE '';
    RAISE NOTICE 'Customers can now earn multiple rewards over time!';
END $$;

COMMIT;
