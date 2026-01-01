-- =============================================================================
-- Migration 005: Multi-Tenant Account Isolation
-- Square Dashboard Tool - Multi-User SaaS Transformation
-- =============================================================================
-- This migration transforms the single-tenant application into a multi-tenant
-- SaaS solution ready for Square App Marketplace.
--
-- Changes:
-- 1. Creates merchants table for storing Square OAuth tokens per tenant
-- 2. Creates user_merchants for user-merchant relationships
-- 3. Creates merchant_invitations for team invites
-- 4. Creates oauth_states for OAuth flow security
-- 5. Adds merchant_id column to ALL existing data tables
-- 6. Creates indexes for efficient merchant-scoped queries
-- =============================================================================

BEGIN;

-- =============================================================================
-- STEP 1: CREATE NEW CORE TABLES
-- =============================================================================

-- 1.1 MERCHANTS TABLE - Core tenant table storing Square OAuth credentials
CREATE TABLE IF NOT EXISTS merchants (
    id SERIAL PRIMARY KEY,

    -- Identity
    square_merchant_id TEXT UNIQUE NOT NULL,  -- Square's merchant ID from OAuth
    business_name TEXT NOT NULL,
    business_email TEXT,

    -- Square OAuth tokens (encrypted at application layer)
    square_access_token TEXT NOT NULL,        -- Encrypted access token
    square_refresh_token TEXT,                -- Encrypted refresh token
    square_token_expires_at TIMESTAMPTZ,
    square_token_scopes TEXT[],               -- Array of granted OAuth scopes

    -- Subscription status
    subscription_status TEXT DEFAULT 'trial', -- trial, active, cancelled, expired, suspended
    subscription_plan_id INTEGER,
    trial_ends_at TIMESTAMPTZ,
    subscription_ends_at TIMESTAMPTZ,

    -- Settings
    timezone TEXT DEFAULT 'America/New_York',
    currency TEXT DEFAULT 'USD',
    settings JSONB DEFAULT '{}',              -- Flexible per-merchant settings

    -- Metadata
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,

    -- Constraints
    CONSTRAINT valid_subscription_status CHECK (
        subscription_status IN ('trial', 'active', 'cancelled', 'expired', 'suspended')
    )
);

CREATE INDEX IF NOT EXISTS idx_merchants_square_id ON merchants(square_merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchants_subscription ON merchants(subscription_status, is_active);
CREATE INDEX IF NOT EXISTS idx_merchants_active ON merchants(is_active) WHERE is_active = TRUE;

COMMENT ON TABLE merchants IS 'Multi-tenant merchants with Square OAuth credentials';
COMMENT ON COLUMN merchants.square_merchant_id IS 'Square merchant ID obtained via OAuth';
COMMENT ON COLUMN merchants.square_access_token IS 'Encrypted Square API access token';
COMMENT ON COLUMN merchants.square_refresh_token IS 'Encrypted Square API refresh token';


-- 1.2 USER-MERCHANT RELATIONSHIPS
CREATE TABLE IF NOT EXISTS user_merchants (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'user',        -- owner, admin, user, readonly
    is_primary BOOLEAN DEFAULT FALSE,         -- Primary merchant for user
    invited_by INTEGER REFERENCES users(id),
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,

    UNIQUE(user_id, merchant_id),
    CONSTRAINT valid_role CHECK (role IN ('owner', 'admin', 'user', 'readonly'))
);

CREATE INDEX IF NOT EXISTS idx_user_merchants_user ON user_merchants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_merchants_merchant ON user_merchants(merchant_id);
CREATE INDEX IF NOT EXISTS idx_user_merchants_primary ON user_merchants(user_id, is_primary) WHERE is_primary = TRUE;

COMMENT ON TABLE user_merchants IS 'Links users to merchants they have access to';
COMMENT ON COLUMN user_merchants.role IS 'User role for this merchant: owner, admin, user, readonly';
COMMENT ON COLUMN user_merchants.is_primary IS 'Whether this is the user default merchant';


-- 1.3 MERCHANT INVITATIONS
CREATE TABLE IF NOT EXISTS merchant_invitations (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    token TEXT UNIQUE NOT NULL,
    invited_by INTEGER REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_invitations_token ON merchant_invitations(token);
CREATE INDEX IF NOT EXISTS idx_merchant_invitations_email ON merchant_invitations(email);
CREATE INDEX IF NOT EXISTS idx_merchant_invitations_merchant ON merchant_invitations(merchant_id);

COMMENT ON TABLE merchant_invitations IS 'Pending invitations for users to join a merchant account';


-- 1.4 OAUTH STATE TABLE (for OAuth flow security)
CREATE TABLE IF NOT EXISTS oauth_states (
    id SERIAL PRIMARY KEY,
    state TEXT UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    redirect_uri TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

COMMENT ON TABLE oauth_states IS 'Stores OAuth state parameters for CSRF protection';


-- =============================================================================
-- STEP 2: CREATE LEGACY MERCHANT FOR EXISTING DATA
-- =============================================================================

-- Insert a placeholder merchant for existing data migration
-- The access token will need to be updated with the encrypted version of the existing token
INSERT INTO merchants (
    square_merchant_id,
    business_name,
    square_access_token,
    subscription_status,
    is_active
) VALUES (
    'legacy_single_tenant',
    'Legacy Merchant (Migrated)',
    'PENDING_ENCRYPTION',  -- Must be updated with encrypted token from .env
    'active',
    TRUE
) ON CONFLICT (square_merchant_id) DO NOTHING;

-- Store the legacy merchant ID for backfill (should be 1)
DO $$
DECLARE
    legacy_merchant_id INTEGER;
BEGIN
    SELECT id INTO legacy_merchant_id FROM merchants WHERE square_merchant_id = 'legacy_single_tenant';
    IF legacy_merchant_id IS NULL THEN
        RAISE EXCEPTION 'Failed to create legacy merchant record';
    END IF;
    RAISE NOTICE 'Legacy merchant created with ID: %', legacy_merchant_id;
END $$;


-- =============================================================================
-- STEP 3: LINK EXISTING USERS TO LEGACY MERCHANT
-- =============================================================================

INSERT INTO user_merchants (user_id, merchant_id, role, is_primary, accepted_at)
SELECT
    u.id,
    (SELECT id FROM merchants WHERE square_merchant_id = 'legacy_single_tenant'),
    CASE WHEN u.role = 'admin' THEN 'owner' ELSE u.role END,
    TRUE,
    NOW()
FROM users u
ON CONFLICT (user_id, merchant_id) DO NOTHING;


-- =============================================================================
-- STEP 4: ADD MERCHANT_ID TO ALL EXISTING DATA TABLES
-- =============================================================================

-- 4.1 Core catalog tables
ALTER TABLE locations ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variations ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE images ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.2 Vendor tables
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_vendors ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE vendor_catalog_items ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.3 Purchase order tables
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.4 Sales & analytics
ALTER TABLE sales_velocity ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_location_settings ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.5 Cycle count tables
ALTER TABLE count_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE count_queue_priority ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE count_queue_daily ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE count_sessions ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.6 Expiration tables
ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE expiry_discount_tiers ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_discount_status ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE expiry_discount_audit_log ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE expiry_discount_settings ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.7 GMC tables
ALTER TABLE brands ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE category_taxonomy_mapping ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE item_brands ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE gmc_settings ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE gmc_feed_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 4.8 System tables
ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE auth_audit_log ADD COLUMN IF NOT EXISTS merchant_id INTEGER;


-- =============================================================================
-- STEP 5: BACKFILL MERCHANT_ID ON ALL EXISTING DATA
-- =============================================================================

-- Get the legacy merchant ID
DO $$
DECLARE
    legacy_id INTEGER;
BEGIN
    SELECT id INTO legacy_id FROM merchants WHERE square_merchant_id = 'legacy_single_tenant';

    -- Core catalog tables
    EXECUTE 'UPDATE locations SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE categories SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE items SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE variations SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE images SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE inventory_counts SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- Vendor tables
    EXECUTE 'UPDATE vendors SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE variation_vendors SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE vendor_catalog_items SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- Purchase order tables
    EXECUTE 'UPDATE purchase_orders SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE purchase_order_items SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- Sales & analytics
    EXECUTE 'UPDATE sales_velocity SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE variation_location_settings SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- Cycle count tables
    EXECUTE 'UPDATE count_history SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE count_queue_priority SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE count_queue_daily SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE count_sessions SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- Expiration tables
    EXECUTE 'UPDATE variation_expiration SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE expiry_discount_tiers SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE variation_discount_status SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE expiry_discount_audit_log SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE expiry_discount_settings SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- GMC tables
    EXECUTE 'UPDATE brands SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE category_taxonomy_mapping SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE item_brands SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE gmc_settings SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;
    EXECUTE 'UPDATE gmc_feed_history SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    -- System tables
    EXECUTE 'UPDATE sync_history SET merchant_id = $1 WHERE merchant_id IS NULL' USING legacy_id;

    RAISE NOTICE 'Backfilled merchant_id = % on all tables', legacy_id;
END $$;


-- =============================================================================
-- STEP 6: VERIFY BACKFILL (Ensure no NULLs before adding NOT NULL constraint)
-- =============================================================================

DO $$
DECLARE
    null_count INTEGER;
    table_name TEXT;
    tables TEXT[] := ARRAY[
        'locations', 'categories', 'items', 'variations', 'images', 'inventory_counts',
        'vendors', 'variation_vendors', 'vendor_catalog_items',
        'purchase_orders', 'purchase_order_items',
        'sales_velocity', 'variation_location_settings',
        'count_history', 'count_queue_priority', 'count_queue_daily', 'count_sessions',
        'variation_expiration', 'expiry_discount_tiers', 'variation_discount_status',
        'expiry_discount_audit_log', 'expiry_discount_settings',
        'brands', 'category_taxonomy_mapping', 'item_brands', 'gmc_settings', 'gmc_feed_history',
        'sync_history'
    ];
BEGIN
    FOREACH table_name IN ARRAY tables
    LOOP
        EXECUTE format('SELECT COUNT(*) FROM %I WHERE merchant_id IS NULL', table_name) INTO null_count;
        IF null_count > 0 THEN
            RAISE WARNING 'Table % has % rows with NULL merchant_id', table_name, null_count;
        END IF;
    END LOOP;
END $$;


-- =============================================================================
-- STEP 7: CREATE INDEXES FOR MERCHANT FILTERING
-- =============================================================================

-- Core catalog tables
CREATE INDEX IF NOT EXISTS idx_locations_merchant ON locations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_categories_merchant ON categories(merchant_id);
CREATE INDEX IF NOT EXISTS idx_items_merchant ON items(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variations_merchant ON variations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_images_merchant ON images(merchant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_merchant ON inventory_counts(merchant_id);

-- Vendor tables
CREATE INDEX IF NOT EXISTS idx_vendors_merchant ON vendors(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variation_vendors_merchant ON variation_vendors(merchant_id);
CREATE INDEX IF NOT EXISTS idx_vendor_catalog_items_merchant ON vendor_catalog_items(merchant_id);

-- Purchase order tables
CREATE INDEX IF NOT EXISTS idx_purchase_orders_merchant ON purchase_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_merchant ON purchase_order_items(merchant_id);

-- Sales & analytics
CREATE INDEX IF NOT EXISTS idx_sales_velocity_merchant ON sales_velocity(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variation_location_settings_merchant ON variation_location_settings(merchant_id);

-- Cycle count tables
CREATE INDEX IF NOT EXISTS idx_count_history_merchant ON count_history(merchant_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_priority_merchant ON count_queue_priority(merchant_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_merchant ON count_queue_daily(merchant_id);
CREATE INDEX IF NOT EXISTS idx_count_sessions_merchant ON count_sessions(merchant_id);

-- Expiration tables
CREATE INDEX IF NOT EXISTS idx_variation_expiration_merchant ON variation_expiration(merchant_id);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_tiers_merchant ON expiry_discount_tiers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_variation_discount_status_merchant ON variation_discount_status(merchant_id);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_audit_log_merchant ON expiry_discount_audit_log(merchant_id);
CREATE INDEX IF NOT EXISTS idx_expiry_discount_settings_merchant ON expiry_discount_settings(merchant_id);

-- GMC tables
CREATE INDEX IF NOT EXISTS idx_brands_merchant ON brands(merchant_id);
CREATE INDEX IF NOT EXISTS idx_category_taxonomy_mapping_merchant ON category_taxonomy_mapping(merchant_id);
CREATE INDEX IF NOT EXISTS idx_item_brands_merchant ON item_brands(merchant_id);
CREATE INDEX IF NOT EXISTS idx_gmc_settings_merchant ON gmc_settings(merchant_id);
CREATE INDEX IF NOT EXISTS idx_gmc_feed_history_merchant ON gmc_feed_history(merchant_id);

-- System tables
CREATE INDEX IF NOT EXISTS idx_sync_history_merchant ON sync_history(merchant_id);


-- =============================================================================
-- STEP 8: CREATE COMPOSITE INDEXES FOR COMMON QUERIES
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_items_merchant_deleted ON items(merchant_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_variations_merchant_item ON variations(merchant_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_merchant_location ON inventory_counts(merchant_id, location_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_merchant_status ON purchase_orders(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_velocity_merchant_location ON sales_velocity(merchant_id, location_id);
CREATE INDEX IF NOT EXISTS idx_vendors_merchant_name ON vendors(merchant_id, name);
CREATE INDEX IF NOT EXISTS idx_categories_merchant_name ON categories(merchant_id, name);


-- =============================================================================
-- STEP 9: ADD NOT NULL CONSTRAINTS (ONLY AFTER BACKFILL VERIFICATION)
-- =============================================================================

-- Note: We're NOT adding NOT NULL constraints in this migration to avoid
-- blocking issues during rollout. These can be added in a subsequent migration
-- after verifying the backfill is complete and the application is updated.

-- The following would be run in a future migration:
-- ALTER TABLE locations ALTER COLUMN merchant_id SET NOT NULL;
-- ALTER TABLE categories ALTER COLUMN merchant_id SET NOT NULL;
-- ... etc.


-- =============================================================================
-- COMPLETION MESSAGE
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE '=============================================================================';
    RAISE NOTICE 'Multi-Tenant Migration (005) completed successfully!';
    RAISE NOTICE '=============================================================================';
    RAISE NOTICE 'Created tables: merchants, user_merchants, merchant_invitations, oauth_states';
    RAISE NOTICE 'Added merchant_id column to 28 existing tables';
    RAISE NOTICE 'Created merchant filtering indexes for all tables';
    RAISE NOTICE '';
    RAISE NOTICE 'IMPORTANT NEXT STEPS:';
    RAISE NOTICE '1. Update legacy merchant with encrypted SQUARE_ACCESS_TOKEN';
    RAISE NOTICE '2. Deploy token encryption utility';
    RAISE NOTICE '3. Update API endpoints to use merchant context';
    RAISE NOTICE '4. Configure Square OAuth application';
    RAISE NOTICE '=============================================================================';
END $$;

COMMIT;
