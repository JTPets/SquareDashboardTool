-- Migration 009: Make oauth_states.merchant_id nullable
--
-- Migration 040 (archived) originally added merchant_id as nullable,
-- but schema.sql drifted to NOT NULL. First-time Square OAuth connect
-- has no merchant yet, so this column must be nullable.

BEGIN;

ALTER TABLE oauth_states
    ALTER COLUMN merchant_id DROP NOT NULL;

COMMENT ON COLUMN oauth_states.merchant_id IS 'Merchant ID — NULL for first-time Square OAuth connect, set for re-auth and Google OAuth';

DO $$
BEGIN
    RAISE NOTICE 'Migration 009: Made oauth_states.merchant_id nullable';
END $$;

COMMIT;
