BEGIN;

-- Migration 018: Add last_received_sync_at column to merchants
--
-- Tracks the high-water mark for the inventory RECEIVE adjustment sync.
-- After each successful run of syncReceiveAdjustments(), this column is
-- updated to NOW() so the next run can pass updated_after = (this value - 10 min)
-- to the Square batch-retrieve endpoint instead of fetching all history.
--
-- NULL means the merchant has never completed a receive sync → full history pull.
-- Schema-manager handles this via ADD COLUMN IF NOT EXISTS on fresh installs;
-- this migration applies the column to existing databases.

ALTER TABLE merchants
    ADD COLUMN IF NOT EXISTS last_received_sync_at TIMESTAMPTZ;

COMMIT;
