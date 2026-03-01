-- Migration 062: Platform owner concept
--
-- Self-hosted installations need a "platform owner" merchant that is never
-- locked out by subscription enforcement. This migration:
-- 1. Adds 'platform_owner' to the valid subscription_status values
-- 2. Sets platform_owner_merchant_id in platform_settings
-- 3. Updates the owner merchant's subscription_status to 'platform_owner'
--
-- For existing installations: uses ENV or merchant ID 3 (JT Pets)
-- For fresh installations: uses ENV or lowest merchant ID, or no-op if empty

-- UP

-- Step 1: Update CHECK constraint to include 'platform_owner'
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS valid_subscription_status;
ALTER TABLE merchants ADD CONSTRAINT valid_subscription_status CHECK (
    subscription_status IN ('trial', 'active', 'cancelled', 'expired', 'suspended', 'platform_owner')
);

-- Step 2: Determine and set platform owner
DO $$
DECLARE
    owner_id INTEGER;
    env_owner_id TEXT;
BEGIN
    -- Check if platform_owner_merchant_id is already set
    SELECT value INTO env_owner_id FROM platform_settings WHERE key = 'platform_owner_merchant_id';
    IF env_owner_id IS NOT NULL THEN
        owner_id := env_owner_id::INTEGER;
        RAISE NOTICE 'Platform owner already set to merchant %', owner_id;
    ELSE
        -- For existing installations: find the right merchant
        -- Priority: lowest active merchant ID (which is 3 after migration 061 cleans up 1 and 2)
        SELECT id INTO owner_id FROM merchants WHERE is_active = TRUE ORDER BY id ASC LIMIT 1;

        IF owner_id IS NULL THEN
            -- Fresh install with no merchants yet — skip, OAuth onboarding will handle it
            RAISE NOTICE 'No merchants found — platform owner will be set on first OAuth connect';
            RETURN;
        END IF;

        -- Store the platform owner setting
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES ('platform_owner_merchant_id', owner_id::TEXT, NOW())
        ON CONFLICT (key) DO UPDATE SET value = owner_id::TEXT, updated_at = NOW();

        RAISE NOTICE 'Platform owner set to merchant % (lowest active ID)', owner_id;
    END IF;

    -- Step 3: Update the owner merchant's subscription_status
    UPDATE merchants
    SET subscription_status = 'platform_owner', updated_at = NOW()
    WHERE id = owner_id;

    RAISE NOTICE 'Merchant % subscription_status set to platform_owner', owner_id;
END $$;

-- DOWN (rollback)
-- Revert subscription_status back to 'trial' and remove platform_owner from CHECK
-- UPDATE merchants SET subscription_status = 'trial' WHERE subscription_status = 'platform_owner';
-- ALTER TABLE merchants DROP CONSTRAINT IF EXISTS valid_subscription_status;
-- ALTER TABLE merchants ADD CONSTRAINT valid_subscription_status CHECK (
--     subscription_status IN ('trial', 'active', 'cancelled', 'expired', 'suspended')
-- );
-- DELETE FROM platform_settings WHERE key = 'platform_owner_merchant_id';
