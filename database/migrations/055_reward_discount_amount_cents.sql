-- Migration 055: Add discount_amount_cents to loyalty_rewards
--
-- Tracks the maximum_amount_money (in cents) set on the Square DISCOUNT object
-- for earned rewards. This lets the audit job detect when current catalog prices
-- exceed the discount cap and update Square to keep free-item rewards truly free.
--
-- Without this column the discount cap was only stored in Square's catalog,
-- making drift detection impossible without a Square API call per reward.

BEGIN;

ALTER TABLE loyalty_rewards
    ADD COLUMN IF NOT EXISTS discount_amount_cents INTEGER DEFAULT NULL;

COMMENT ON COLUMN loyalty_rewards.discount_amount_cents
    IS 'The maximum_amount_money (cents) set on the Square DISCOUNT object — used to detect price drift';

COMMIT;
