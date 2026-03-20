-- Migration 001: Fix remaining timestamp columns and add missing delivery_route_tokens table
-- Created: 2026-03-20
-- Fixes:
--   1. Create delivery_route_tokens table (missing from production)
--   2. Convert TIMESTAMP -> TIMESTAMPTZ on:
--      items.archived_at, variations.archived_at,
--      variation_expiration.expiration_date / created_at / updated_at,
--      gmc_location_settings.created_at / updated_at,
--      google_oauth_tokens.created_at / updated_at,
--      gmc_sync_logs.started_at / completed_at

BEGIN;

-- ============================================================
-- 1. Create delivery_route_tokens (missing from production)
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_route_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    token VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    driver_name VARCHAR(255),
    driver_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_route_tokens_token ON delivery_route_tokens(token);
CREATE INDEX IF NOT EXISTS idx_route_tokens_route ON delivery_route_tokens(route_id);
CREATE INDEX IF NOT EXISTS idx_route_tokens_merchant ON delivery_route_tokens(merchant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_tokens_active_route ON delivery_route_tokens(route_id) WHERE status = 'active';

-- ============================================================
-- 2. items.archived_at: TIMESTAMP -> TIMESTAMPTZ
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'items' AND column_name = 'archived_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE items ALTER COLUMN archived_at TYPE TIMESTAMPTZ USING archived_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'items.archived_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'items.archived_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

-- ============================================================
-- 3. variations.archived_at: TIMESTAMP -> TIMESTAMPTZ
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'variations' AND column_name = 'archived_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE variations ALTER COLUMN archived_at TYPE TIMESTAMPTZ USING archived_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'variations.archived_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'variations.archived_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

-- ============================================================
-- 4. variation_expiration: expiration_date, created_at, updated_at
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'variation_expiration' AND column_name = 'expiration_date'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE variation_expiration ALTER COLUMN expiration_date TYPE TIMESTAMPTZ USING expiration_date AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'variation_expiration.expiration_date converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'variation_expiration.expiration_date already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'variation_expiration' AND column_name = 'created_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE variation_expiration ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'variation_expiration.created_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'variation_expiration.created_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'variation_expiration' AND column_name = 'updated_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE variation_expiration ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'variation_expiration.updated_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'variation_expiration.updated_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

-- ============================================================
-- 5. gmc_location_settings: created_at, updated_at
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gmc_location_settings' AND column_name = 'created_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE gmc_location_settings ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'gmc_location_settings.created_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'gmc_location_settings.created_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gmc_location_settings' AND column_name = 'updated_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE gmc_location_settings ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'gmc_location_settings.updated_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'gmc_location_settings.updated_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

-- ============================================================
-- 6. google_oauth_tokens: created_at, updated_at
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'google_oauth_tokens' AND column_name = 'created_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE google_oauth_tokens ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'google_oauth_tokens.created_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'google_oauth_tokens.created_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'google_oauth_tokens' AND column_name = 'updated_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE google_oauth_tokens ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'google_oauth_tokens.updated_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'google_oauth_tokens.updated_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

-- ============================================================
-- 7. gmc_sync_logs: started_at, completed_at
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gmc_sync_logs' AND column_name = 'started_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE gmc_sync_logs ALTER COLUMN started_at TYPE TIMESTAMPTZ USING started_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'gmc_sync_logs.started_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'gmc_sync_logs.started_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gmc_sync_logs' AND column_name = 'completed_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE gmc_sync_logs ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING completed_at AT TIME ZONE 'America/Toronto';
        RAISE NOTICE 'gmc_sync_logs.completed_at converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'gmc_sync_logs.completed_at already TIMESTAMPTZ or does not exist — skipped';
    END IF;
END $$;

COMMIT;
