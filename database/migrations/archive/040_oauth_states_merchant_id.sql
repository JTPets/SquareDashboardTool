-- Migration 040: Add merchant_id to oauth_states for Google OAuth CSRF protection
--
-- The oauth_states table is used by both Square OAuth and Google OAuth.
-- Square OAuth stores user_id; Google OAuth needs merchant_id to bind
-- the state to the merchant being connected.
-- Column is nullable since Square OAuth doesn't use it.

BEGIN;

ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

CREATE INDEX IF NOT EXISTS idx_oauth_states_merchant
    ON oauth_states(merchant_id)
    WHERE merchant_id IS NOT NULL;

COMMENT ON COLUMN oauth_states.merchant_id IS 'Merchant ID for Google OAuth flows (NULL for Square OAuth)';

DO $$
BEGIN
    RAISE NOTICE 'Migration 040: Added merchant_id column to oauth_states';
END $$;

COMMIT;
