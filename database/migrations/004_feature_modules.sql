-- Migration 004: Feature Modules
-- Adds merchant_features table for per-merchant feature gating (Phase 2)

BEGIN;

CREATE TABLE IF NOT EXISTS merchant_features (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    feature_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disabled_at TIMESTAMPTZ,
    source TEXT NOT NULL DEFAULT 'manual',
    UNIQUE(merchant_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_merchant_features_lookup
    ON merchant_features(merchant_id, feature_key, enabled);

COMMIT;
