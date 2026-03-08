-- Migration 066: MT-2 and MT-3 multi-tenant fixes
-- MT-2: Add admin_email column to merchants for per-merchant email notification routing
-- MT-3: Add ors_api_key_encrypted column to delivery_settings for encrypted ORS key storage

-- MT-2: Per-merchant email notification routing
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS admin_email TEXT;
COMMENT ON COLUMN merchants.admin_email IS 'Per-merchant admin email for notifications. Falls back to platform EMAIL_TO env var if null.';

-- Populate admin_email from business_email where available
UPDATE merchants SET admin_email = business_email WHERE business_email IS NOT NULL AND admin_email IS NULL;

-- MT-3: Encrypted ORS API key storage
ALTER TABLE delivery_settings ADD COLUMN IF NOT EXISTS ors_api_key_encrypted TEXT;
COMMENT ON COLUMN delivery_settings.ors_api_key_encrypted IS 'AES-256-GCM encrypted OpenRouteService API key. Replaces plaintext openrouteservice_api_key column.';

-- Migrate existing plaintext keys will be handled by the application on first read
-- (encrypt-on-read pattern, same as Square token migration)

DO $$
BEGIN
    RAISE NOTICE 'Migration 066 complete: admin_email added to merchants, ors_api_key_encrypted added to delivery_settings';
END $$;
