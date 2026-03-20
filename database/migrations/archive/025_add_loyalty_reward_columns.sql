-- ========================================
-- MIGRATION: Add Missing Loyalty Schema Columns
-- ========================================
-- Adds missing columns referenced in code but not in schema:
-- 1. loyalty_offers: reward_type, reward_value, reward_description
-- 2. loyalty_purchase_events: total_price_cents
--
-- Usage: psql -d your_database -f 025_add_loyalty_reward_columns.sql

BEGIN;

-- ----------------------------------------
-- 1. Add reward_type to loyalty_offers
-- ----------------------------------------
-- Defines what type of reward is given
-- Default is 'free_item' per business rules (buy X get 1 free)
ALTER TABLE loyalty_offers
ADD COLUMN IF NOT EXISTS reward_type VARCHAR(50) NOT NULL DEFAULT 'free_item'
CHECK (reward_type IN ('free_item', 'percent_off', 'fixed_amount'));

COMMENT ON COLUMN loyalty_offers.reward_type IS 'Type of reward: free_item, percent_off, or fixed_amount';

-- ----------------------------------------
-- 2. Add reward_value to loyalty_offers
-- ----------------------------------------
-- For free_item: number of free items (usually 1)
-- For percent_off: percentage discount
-- For fixed_amount: discount in cents
-- Default is 1 per business rules (get 1 free)
ALTER TABLE loyalty_offers
ADD COLUMN IF NOT EXISTS reward_value INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN loyalty_offers.reward_value IS 'Value of reward: 1 for free_item, percentage for percent_off, cents for fixed_amount';

-- ----------------------------------------
-- 3. Add reward_description to loyalty_offers
-- ----------------------------------------
-- Human-readable description of the reward
ALTER TABLE loyalty_offers
ADD COLUMN IF NOT EXISTS reward_description TEXT;

COMMENT ON COLUMN loyalty_offers.reward_description IS 'Human-readable description of the reward (e.g., "One free 12oz bag")';

-- ----------------------------------------
-- 4. Add total_price_cents to loyalty_purchase_events
-- ----------------------------------------
-- Total price for the line item (quantity * unit_price_cents)
ALTER TABLE loyalty_purchase_events
ADD COLUMN IF NOT EXISTS total_price_cents INTEGER;

COMMENT ON COLUMN loyalty_purchase_events.total_price_cents IS 'Total price for the line item in cents';

-- ----------------------------------------
-- 5. Update existing offers with default descriptions
-- ----------------------------------------
UPDATE loyalty_offers
SET reward_description = 'One free ' || size_group || ' ' || brand_name
WHERE reward_description IS NULL;

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Migration 025_add_loyalty_reward_columns completed successfully!';
    RAISE NOTICE 'Added columns:';
    RAISE NOTICE '  - loyalty_offers.reward_type (defaults to free_item)';
    RAISE NOTICE '  - loyalty_offers.reward_value (defaults to 1)';
    RAISE NOTICE '  - loyalty_offers.reward_description';
    RAISE NOTICE '  - loyalty_purchase_events.total_price_cents';
END $$;

COMMIT;
