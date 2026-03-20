-- Migration 059: Platform settings table
-- Stores platform-level configuration (trial duration, pricing tiers, feature flags)
-- without requiring server restarts

-- UP
CREATE TABLE IF NOT EXISTS platform_settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default trial duration (180 days = 6 months for beta)
INSERT INTO platform_settings (key, value)
VALUES ('default_trial_days', '180')
ON CONFLICT (key) DO NOTHING;

-- DOWN (rollback)
-- DROP TABLE IF EXISTS platform_settings;
