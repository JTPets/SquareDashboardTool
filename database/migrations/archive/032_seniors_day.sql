-- ========================================
-- MIGRATION: Seniors Day Discount Feature
-- ========================================
-- Manages age-based discount eligibility via Square Customer Groups.
-- Usage: psql -d your_database -f database/migrations/032_seniors_day.sql

BEGIN;

-- ----------------------------------------
-- 1. Add birthday to loyalty_customers
-- ----------------------------------------
-- Square provides birthday in YYYY-MM-DD format
-- We cache it locally for efficient age calculations

ALTER TABLE loyalty_customers
ADD COLUMN IF NOT EXISTS birthday DATE;

CREATE INDEX IF NOT EXISTS idx_loyalty_customers_birthday
ON loyalty_customers(merchant_id, birthday)
WHERE birthday IS NOT NULL;

COMMENT ON COLUMN loyalty_customers.birthday IS 'Customer birthday from Square (YYYY-MM-DD), used for seniors discount eligibility';

-- ----------------------------------------
-- 2. Seniors discount configuration table
-- ----------------------------------------
-- Tracks the Square objects created for each merchant's seniors discount

CREATE TABLE IF NOT EXISTS seniors_discount_config (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),

    -- Square object IDs
    square_group_id TEXT,              -- Customer Group: "Seniors (60+)"
    square_discount_id TEXT,           -- Catalog Discount: 10% off
    square_product_set_id TEXT,        -- Product Set: all items
    square_pricing_rule_id TEXT,       -- Pricing Rule: ties it together

    -- Configuration
    discount_percent INTEGER NOT NULL DEFAULT 10,
    min_age INTEGER NOT NULL DEFAULT 60,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    last_enabled_at TIMESTAMPTZ,       -- Last time pricing rule was enabled
    last_disabled_at TIMESTAMPTZ,      -- Last time pricing rule was disabled
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT seniors_discount_config_merchant_unique UNIQUE(merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_seniors_config_merchant
ON seniors_discount_config(merchant_id);

COMMENT ON TABLE seniors_discount_config IS 'Seniors Day discount configuration per merchant - stores Square object IDs and settings';

-- ----------------------------------------
-- 3. Seniors group membership tracking
-- ----------------------------------------
-- Tracks which customers are in the seniors group (denormalized for queries)

CREATE TABLE IF NOT EXISTS seniors_group_members (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    square_customer_id TEXT NOT NULL,
    birthday DATE NOT NULL,
    age_at_last_check INTEGER NOT NULL,
    added_to_group_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_from_group_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT seniors_group_members_unique UNIQUE(merchant_id, square_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_seniors_members_merchant_active
ON seniors_group_members(merchant_id, is_active)
WHERE is_active = TRUE;

COMMENT ON TABLE seniors_group_members IS 'Tracks customers in the Seniors (60+) customer group';

-- ----------------------------------------
-- 4. Seniors discount audit log
-- ----------------------------------------
-- Tracks all changes for debugging and compliance

CREATE TABLE IF NOT EXISTS seniors_discount_audit_log (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    action TEXT NOT NULL,              -- 'PRICING_RULE_ENABLED', 'PRICING_RULE_DISABLED',
                                       -- 'CUSTOMER_ADDED', 'CUSTOMER_REMOVED', 'AGE_SWEEP'
    square_customer_id TEXT,
    details JSONB,                     -- Additional context
    triggered_by TEXT NOT NULL,        -- 'CRON', 'WEBHOOK', 'MANUAL', 'BACKFILL'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seniors_audit_merchant_date
ON seniors_discount_audit_log(merchant_id, created_at DESC);

COMMENT ON TABLE seniors_discount_audit_log IS 'Audit trail for seniors discount actions';

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Seniors Day migration completed successfully!';
    RAISE NOTICE 'Tables created/modified:';
    RAISE NOTICE '  - loyalty_customers.birthday column added';
    RAISE NOTICE '  - seniors_discount_config (Square object IDs)';
    RAISE NOTICE '  - seniors_group_members (membership tracking)';
    RAISE NOTICE '  - seniors_discount_audit_log (audit trail)';
END $$;

COMMIT;
