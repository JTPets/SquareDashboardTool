-- Migration 074: Add merchant_id tenant isolation to subscription tables (CRIT-2, CRIT-4)
-- Tables affected: promo_codes, subscription_payments, subscription_events,
-- subscription_plans, platform_settings, oauth_states
-- Existing rows backfilled with merchant_id = 3 (JT Pets), then set NOT NULL.

BEGIN;

-- ==================== promo_codes ====================
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
UPDATE promo_codes SET merchant_id = 3 WHERE merchant_id IS NULL;
ALTER TABLE promo_codes ALTER COLUMN merchant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promo_codes_merchant ON promo_codes(merchant_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_merchant_code ON promo_codes(merchant_id, code);
-- Drop old unique on code alone — promo codes are now per-tenant
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_code_key;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_merchant_code_unique UNIQUE (merchant_id, code);

-- ==================== subscription_payments ====================
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
UPDATE subscription_payments SET merchant_id = 3 WHERE merchant_id IS NULL;
ALTER TABLE subscription_payments ALTER COLUMN merchant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_payments_merchant ON subscription_payments(merchant_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_merchant_subscriber ON subscription_payments(merchant_id, subscriber_id);

-- ==================== subscription_events ====================
ALTER TABLE subscription_events ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
UPDATE subscription_events SET merchant_id = 3 WHERE merchant_id IS NULL;
ALTER TABLE subscription_events ALTER COLUMN merchant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_events_merchant ON subscription_events(merchant_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_merchant_type ON subscription_events(merchant_id, event_type);

-- ==================== subscription_plans ====================
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
UPDATE subscription_plans SET merchant_id = 3 WHERE merchant_id IS NULL;
ALTER TABLE subscription_plans ALTER COLUMN merchant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_plans_merchant ON subscription_plans(merchant_id);
-- Drop old unique on plan_key alone — plans are now per-tenant
ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_plan_key_key;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_merchant_plan_key_unique UNIQUE (merchant_id, plan_key);

-- ==================== platform_settings ====================
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
CREATE INDEX IF NOT EXISTS idx_platform_settings_merchant ON platform_settings(merchant_id) WHERE merchant_id IS NOT NULL;

-- ==================== oauth_states ====================
-- Column may not exist if DB was created before merchant_id was added to schema
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
-- Backfill any NULL merchant_id rows, then set NOT NULL
UPDATE oauth_states SET merchant_id = 3 WHERE merchant_id IS NULL;
ALTER TABLE oauth_states ALTER COLUMN merchant_id SET NOT NULL;
-- Replace partial index with full index since merchant_id is now NOT NULL
DROP INDEX IF EXISTS idx_oauth_states_merchant;
CREATE INDEX IF NOT EXISTS idx_oauth_states_merchant ON oauth_states(merchant_id);

COMMIT;
