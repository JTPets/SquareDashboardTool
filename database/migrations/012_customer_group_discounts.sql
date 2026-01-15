-- ========================================
-- MIGRATION: Customer Group Discounts for Frequent Buyer Rewards
-- ========================================
-- Replaces the old Square Loyalty API approach (which required points)
-- with Customer Group Discounts that auto-apply at Square POS.
--
-- How it works:
-- 1. When customer earns a reward, we create a Customer Group
-- 2. Add the customer to the group
-- 3. Create a Catalog Discount + Pricing Rule for that group
-- 4. When customer checks out at POS and is identified, discount auto-applies
-- 5. After redemption, we detect it via webhook and clean up the objects
--
-- Usage: psql -d your_database -f 012_customer_group_discounts.sql

BEGIN;

-- ----------------------------------------
-- 1. Add Customer Group Discount columns to loyalty_rewards
-- ----------------------------------------
-- These store the Square object IDs for cleanup after redemption

ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_group_id TEXT;

ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_discount_id TEXT;

ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_product_set_id TEXT;

ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_pricing_rule_id TEXT;

ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS square_pos_synced_at TIMESTAMPTZ;

-- Index for looking up rewards by discount ID (for redemption detection)
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_square_discount
ON loyalty_rewards(square_discount_id)
WHERE square_discount_id IS NOT NULL;

-- Index for looking up rewards by group ID
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_square_group
ON loyalty_rewards(square_group_id)
WHERE square_group_id IS NOT NULL;

COMMENT ON COLUMN loyalty_rewards.square_group_id IS 'Square Customer Group ID - customer is added to this group when reward is earned';
COMMENT ON COLUMN loyalty_rewards.square_discount_id IS 'Square Catalog Discount ID - 100% discount for the customer group';
COMMENT ON COLUMN loyalty_rewards.square_product_set_id IS 'Square Catalog Product Set ID - defines which items qualify for discount';
COMMENT ON COLUMN loyalty_rewards.square_pricing_rule_id IS 'Square Catalog Pricing Rule ID - ties discount to group and products';
COMMENT ON COLUMN loyalty_rewards.square_pos_synced_at IS 'Timestamp when the discount was synced to Square POS';

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Customer Group Discounts migration completed successfully!';
    RAISE NOTICE 'Added columns to loyalty_rewards:';
    RAISE NOTICE '  - square_group_id (Customer Group for the reward)';
    RAISE NOTICE '  - square_discount_id (Catalog Discount 100%% off)';
    RAISE NOTICE '  - square_product_set_id (Which items qualify)';
    RAISE NOTICE '  - square_pricing_rule_id (Links discount to group)';
    RAISE NOTICE '  - square_pos_synced_at (When synced to POS)';
    RAISE NOTICE '';
    RAISE NOTICE 'NOTE: The old square_reward_tier_id on loyalty_offers is no longer used.';
    RAISE NOTICE 'Customer Group Discounts work independently without needing tier mapping.';
END $$;

COMMIT;
