-- ========================================
-- MIGRATION: Square Loyalty Integration
-- ========================================
-- Adds columns to integrate our frequent buyer rewards with Square Loyalty
-- so rewards show up in Square POS for cashiers to redeem.
--
-- Usage: psql -d your_database -f 011_square_loyalty_integration.sql

BEGIN;

-- ----------------------------------------
-- 1. Add square_reward_tier_id to loyalty_offers
-- ----------------------------------------
-- Links our offer to a Square Loyalty reward tier
-- When a customer earns a reward, we'll create a Square Loyalty reward using this tier
ALTER TABLE loyalty_offers
ADD COLUMN IF NOT EXISTS square_reward_tier_id TEXT;

COMMENT ON COLUMN loyalty_offers.square_reward_tier_id IS 'Square Loyalty reward tier ID - when set, earned rewards create Square Loyalty rewards for POS redemption';

-- ----------------------------------------
-- 2. Add square_reward_id to loyalty_rewards
-- ----------------------------------------
-- Tracks the Square Loyalty reward created when a customer earns a reward
ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_reward_id TEXT;

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_square ON loyalty_rewards(square_reward_id) WHERE square_reward_id IS NOT NULL;

COMMENT ON COLUMN loyalty_rewards.square_reward_id IS 'Square Loyalty reward ID - created when reward is earned, shows in Square POS';

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Square Loyalty Integration migration completed successfully!';
    RAISE NOTICE 'Added columns:';
    RAISE NOTICE '  - loyalty_offers.square_reward_tier_id (link to Square Loyalty reward tier)';
    RAISE NOTICE '  - loyalty_rewards.square_reward_id (Square reward created for POS redemption)';
END $$;

COMMIT;
