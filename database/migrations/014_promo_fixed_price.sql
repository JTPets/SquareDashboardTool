BEGIN;

-- Migration 014: Add fixed_price promo code support
--
-- Adds two columns to promo_codes to support a new discount_type = 'fixed_price':
--   fixed_price_cents  — the flat monthly rate the subscriber pays (e.g. 99 = $0.99/mo)
--   duration_months    — how many months the promo rate applies (NULL = indefinite)
--
-- The existing discount_value column is unused for fixed_price codes;
-- fixed_price_cents replaces it as the pricing source of truth.

ALTER TABLE promo_codes
    ADD COLUMN IF NOT EXISTS fixed_price_cents INTEGER,
    ADD COLUMN IF NOT EXISTS duration_months INTEGER;

COMMIT;
