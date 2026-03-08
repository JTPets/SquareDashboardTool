-- Migration 065: Add NOT NULL constraints to merchant_id on 6 remaining tables
--
-- Continues defense-in-depth from migration 060, covering tables that were
-- missed or created later without NOT NULL on merchant_id.
--
-- Tables:
--   auth_audit_log        — also adds FK to merchants(id) (was missing)
--   gmc_location_settings — FK exists, just needs NOT NULL
--   gmc_sync_logs         — FK exists, just needs NOT NULL
--   google_oauth_tokens   — FK exists, just needs NOT NULL
--   subscribers           — FK exists, just needs NOT NULL
--   webhook_events        — FK exists, just needs NOT NULL
--
-- SAFETY: Each ALTER checks for NULL rows first. If any exist, the constraint
-- is skipped for that table and a warning is raised.

-- UP

DO $$
DECLARE
    null_count INTEGER;
    tables_with_nulls TEXT[] := '{}';
BEGIN
    RAISE NOTICE 'Checking for NULL merchant_id rows across 6 tables...';

    -- auth_audit_log (needs FK + NOT NULL)
    SELECT COUNT(*) INTO null_count FROM auth_audit_log WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'auth_audit_log has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'auth_audit_log');
    ELSE
        -- Add FK constraint if not already present
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'auth_audit_log'
              AND constraint_type = 'FOREIGN KEY'
              AND constraint_name = 'auth_audit_log_merchant_id_fkey'
        ) THEN
            ALTER TABLE auth_audit_log
                ADD CONSTRAINT auth_audit_log_merchant_id_fkey
                FOREIGN KEY (merchant_id) REFERENCES merchants(id);
            RAISE NOTICE 'auth_audit_log: FK constraint added';
        END IF;
        ALTER TABLE auth_audit_log ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'auth_audit_log: NOT NULL constraint added';
    END IF;

    -- gmc_location_settings
    SELECT COUNT(*) INTO null_count FROM gmc_location_settings WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'gmc_location_settings has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'gmc_location_settings');
    ELSE
        ALTER TABLE gmc_location_settings ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'gmc_location_settings: NOT NULL constraint added';
    END IF;

    -- gmc_sync_logs
    SELECT COUNT(*) INTO null_count FROM gmc_sync_logs WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'gmc_sync_logs has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'gmc_sync_logs');
    ELSE
        ALTER TABLE gmc_sync_logs ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'gmc_sync_logs: NOT NULL constraint added';
    END IF;

    -- google_oauth_tokens
    SELECT COUNT(*) INTO null_count FROM google_oauth_tokens WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'google_oauth_tokens has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'google_oauth_tokens');
    ELSE
        ALTER TABLE google_oauth_tokens ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'google_oauth_tokens: NOT NULL constraint added';
    END IF;

    -- subscribers
    SELECT COUNT(*) INTO null_count FROM subscribers WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'subscribers has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'subscribers');
    ELSE
        ALTER TABLE subscribers ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'subscribers: NOT NULL constraint added';
    END IF;

    -- webhook_events
    SELECT COUNT(*) INTO null_count FROM webhook_events WHERE merchant_id IS NULL;
    IF null_count > 0 THEN
        RAISE WARNING 'webhook_events has % rows with NULL merchant_id — skipping NOT NULL', null_count;
        tables_with_nulls := array_append(tables_with_nulls, 'webhook_events');
    ELSE
        ALTER TABLE webhook_events ALTER COLUMN merchant_id SET NOT NULL;
        RAISE NOTICE 'webhook_events: NOT NULL constraint added';
    END IF;

    -- Summary
    IF array_length(tables_with_nulls, 1) IS NULL THEN
        RAISE NOTICE 'All 6 tables updated with NOT NULL constraint on merchant_id';
    ELSE
        RAISE WARNING 'Tables skipped due to NULL merchant_id rows: %', array_to_string(tables_with_nulls, ', ');
        RAISE WARNING 'Manual review required: assign orphaned rows to correct merchant or DELETE';
    END IF;
END $$;

-- DOWN (rollback)
-- ALTER TABLE auth_audit_log ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE auth_audit_log DROP CONSTRAINT IF EXISTS auth_audit_log_merchant_id_fkey;
-- ALTER TABLE gmc_location_settings ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE gmc_sync_logs ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE google_oauth_tokens ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE subscribers ALTER COLUMN merchant_id DROP NOT NULL;
-- ALTER TABLE webhook_events ALTER COLUMN merchant_id DROP NOT NULL;
