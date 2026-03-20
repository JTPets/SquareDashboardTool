-- Migration 044: Add delta sync support for catalog webhook optimization
-- Instead of full ListCatalog on every webhook, track timestamps for SearchCatalogObjects delta sync

-- Add last_delta_timestamp to sync_history for storing Square's latest_time from SearchCatalogObjects
-- This is separate from synced_at (which tracks when WE last synced) — this tracks Square's cursor
ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS last_delta_timestamp TEXT;

-- Add last_catalog_version to track the webhook's updated_at for dedup
-- Prevents re-processing when duplicate webhooks arrive with the same catalog version
ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS last_catalog_version TEXT;
