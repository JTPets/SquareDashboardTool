BEGIN;

-- Migration 017: Add last_received_at column to variation_location_settings
--
-- Tracks the most recent inventory receipt timestamp per (variation, location)
-- populated during the daily inventory sync from Square ADJUSTMENT changes
-- where to_state = 'IN_STOCK'. Uses GREATEST() in upsert so earlier syncs
-- can never overwrite a more-recent receipt.
--
-- Schema-manager handles this via ADD COLUMN IF NOT EXISTS on fresh installs;
-- this migration applies the column to existing databases.

ALTER TABLE variation_location_settings
    ADD COLUMN IF NOT EXISTS last_received_at TIMESTAMPTZ;

COMMIT;
