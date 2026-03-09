-- Migration 069: Create catalog_location_health table for tracking Square catalog location mismatches
-- Permanent audit trail — rows are NEVER pruned or deleted

CREATE TABLE IF NOT EXISTS catalog_location_health (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    variation_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('valid', 'mismatch')),
    mismatch_type TEXT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    notes TEXT
);

COMMENT ON TABLE catalog_location_health IS 'Permanent audit trail of Square catalog location mismatches (present_at_all_locations / present_at_all_future_locations)';
COMMENT ON COLUMN catalog_location_health.mismatch_type IS 'Type of mismatch detected (e.g. present_at_all_locations, present_at_all_future_locations)';
COMMENT ON COLUMN catalog_location_health.resolved_at IS 'When the mismatch was resolved (NULL if still open)';

CREATE INDEX IF NOT EXISTS idx_catalog_location_health_merchant_variation_status
    ON catalog_location_health (merchant_id, variation_id, status);
