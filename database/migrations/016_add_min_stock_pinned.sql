BEGIN;

-- Migration 016: Add min_stock_pinned column to variation_location_settings
--
-- Allows merchants to manually pin a variation's min stock level,
-- preventing the weekly auto min/max cron from adjusting it.
-- Schema-manager handles this via ADD COLUMN IF NOT EXISTS on fresh installs;
-- this migration applies the column to existing databases.
--
-- Part of BACKLOG-106 v2 — manual pin feature.

ALTER TABLE variation_location_settings
    ADD COLUMN IF NOT EXISTS min_stock_pinned BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
