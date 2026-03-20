-- Migration 054: Track custom attribute initialization per merchant
-- BACKLOG-13: Move custom attribute initialization from startup to tenant onboarding
-- Adds a timestamp so server restart skips already-initialized merchants

ALTER TABLE merchants
    ADD COLUMN custom_attributes_initialized_at TIMESTAMPTZ DEFAULT NULL;

-- Backfill: mark all active merchants as already initialized
-- (they've been initialized on every restart until now)
UPDATE merchants
    SET custom_attributes_initialized_at = NOW()
    WHERE is_active = TRUE;
