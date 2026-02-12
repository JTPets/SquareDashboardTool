-- Migration 048: Add last_verified_state to seniors_discount_config
--
-- Stores the result of the last Square API state check so the daily
-- cron job can skip redundant verification calls on non-seniors days.
-- Eliminates ~27 Square API calls/month per merchant.

BEGIN;

ALTER TABLE seniors_discount_config
    ADD COLUMN IF NOT EXISTS last_verified_state TEXT,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN seniors_discount_config.last_verified_state IS 'Last known pricing rule state: enabled or disabled';
COMMENT ON COLUMN seniors_discount_config.last_verified_at IS 'When the state was last verified against Square';

DO $$
BEGIN
    RAISE NOTICE 'Migration 048: Added last_verified_state/last_verified_at to seniors_discount_config';
END $$;

COMMIT;
