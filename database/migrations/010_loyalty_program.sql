-- ========================================
-- MIGRATION: Square Loyalty Addon (Frequent Buyer Program)
-- ========================================
-- Implements vendor-defined frequent buyer programs (Astro-style loyalty)
-- where customers earn free items after purchasing a defined quantity.
--
-- BUSINESS RULES (NON-NEGOTIABLE):
-- - One loyalty offer = one brand + one size group
-- - Qualifying purchases must match explicit variation IDs
-- - NEVER mix sizes to earn or redeem
-- - Rolling time window from first qualifying purchase
-- - Full redemption only (no partials, no substitutions)
-- - Reward is always 1 free unit of same size group
--
-- Usage: psql -d your_database -f 010_loyalty_program.sql

BEGIN;

-- ----------------------------------------
-- 1. loyalty_offers - Defines frequent buyer program offers
-- ----------------------------------------
-- One offer per brand + size group combination
CREATE TABLE IF NOT EXISTS loyalty_offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,

    -- Offer identification
    offer_name VARCHAR(255) NOT NULL,
    brand_name VARCHAR(255) NOT NULL,
    size_group VARCHAR(100) NOT NULL,  -- e.g., '12oz', '1lb', 'small'

    -- Earning rules
    required_quantity INTEGER NOT NULL CHECK (required_quantity > 0),  -- e.g., 12 (buy 12 get 1)
    reward_quantity INTEGER NOT NULL DEFAULT 1 CHECK (reward_quantity = 1),  -- Always 1 free unit

    -- Time window (rolling from first qualifying purchase)
    window_months INTEGER NOT NULL DEFAULT 12 CHECK (window_months > 0),  -- e.g., 12 or 18 months

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Metadata
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES users(id),

    -- Prevent duplicate offers for same brand+size per merchant
    CONSTRAINT loyalty_offers_unique_brand_size UNIQUE(merchant_id, brand_name, size_group)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_offers_merchant ON loyalty_offers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_offers_brand ON loyalty_offers(merchant_id, brand_name);
CREATE INDEX IF NOT EXISTS idx_loyalty_offers_active ON loyalty_offers(merchant_id, is_active) WHERE is_active = TRUE;

COMMENT ON TABLE loyalty_offers IS 'Frequent buyer program offers: one per brand + size group';
COMMENT ON COLUMN loyalty_offers.required_quantity IS 'Number of units customer must purchase to earn reward (e.g., 12)';
COMMENT ON COLUMN loyalty_offers.reward_quantity IS 'Always 1 - one free unit of same size group';
COMMENT ON COLUMN loyalty_offers.window_months IS 'Rolling time window in months from first qualifying purchase';

-- ----------------------------------------
-- 2. loyalty_qualifying_variations - Maps Square variations to offers
-- ----------------------------------------
-- Explicitly defines which Square variation IDs qualify for each offer
CREATE TABLE IF NOT EXISTS loyalty_qualifying_variations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Square catalog reference
    variation_id TEXT NOT NULL,  -- Square variation ID
    item_id TEXT,  -- Square item ID (for display purposes)
    item_name TEXT,  -- Cached item name
    variation_name TEXT,  -- Cached variation name (e.g., "12oz Bag")
    sku TEXT,  -- Cached SKU

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate variation mappings
    CONSTRAINT loyalty_qualifying_vars_unique UNIQUE(merchant_id, offer_id, variation_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_qual_vars_merchant ON loyalty_qualifying_variations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_qual_vars_offer ON loyalty_qualifying_variations(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_qual_vars_variation ON loyalty_qualifying_variations(merchant_id, variation_id);

COMMENT ON TABLE loyalty_qualifying_variations IS 'Maps Square variation IDs to loyalty offers - ONLY these variations qualify';
COMMENT ON COLUMN loyalty_qualifying_variations.variation_id IS 'Square variation ID that qualifies for this offer';

-- ----------------------------------------
-- 3. loyalty_purchase_events - Records qualifying purchases
-- ----------------------------------------
-- Each purchase event represents a qualifying purchase from an order
CREATE TABLE IF NOT EXISTS loyalty_purchase_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Customer reference (Square customer ID)
    square_customer_id TEXT NOT NULL,

    -- Order reference
    square_order_id TEXT NOT NULL,
    square_location_id TEXT,

    -- Purchase details
    variation_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity != 0),  -- Can be negative for refunds
    unit_price_cents INTEGER,  -- Price at time of purchase (for audit)

    -- Purchase timestamp (from Square order)
    purchased_at TIMESTAMPTZ NOT NULL,

    -- Window tracking (calculated)
    window_start_date DATE,  -- First qualifying purchase date for this customer+offer
    window_end_date DATE,    -- When this purchase will expire from window

    -- Linking to reward if this event contributed to an earned reward
    reward_id UUID,  -- Set when this purchase is locked into an earned reward

    -- Refund tracking
    is_refund BOOLEAN NOT NULL DEFAULT FALSE,
    original_event_id UUID REFERENCES loyalty_purchase_events(id),  -- For refund linking

    -- Idempotency
    idempotency_key TEXT NOT NULL,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate events (idempotency)
    CONSTRAINT loyalty_purchase_events_idempotent UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_merchant ON loyalty_purchase_events(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_offer ON loyalty_purchase_events(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_customer ON loyalty_purchase_events(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_customer_offer ON loyalty_purchase_events(merchant_id, square_customer_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_order ON loyalty_purchase_events(merchant_id, square_order_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_window ON loyalty_purchase_events(merchant_id, offer_id, square_customer_id, window_end_date);
CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_unlocked ON loyalty_purchase_events(merchant_id, offer_id, square_customer_id, reward_id) WHERE reward_id IS NULL;

COMMENT ON TABLE loyalty_purchase_events IS 'Records all qualifying purchases and refunds for loyalty tracking';
COMMENT ON COLUMN loyalty_purchase_events.quantity IS 'Positive for purchases, negative for refunds';
COMMENT ON COLUMN loyalty_purchase_events.reward_id IS 'Set when this purchase is locked into an earned reward';
COMMENT ON COLUMN loyalty_purchase_events.window_end_date IS 'Date when this purchase expires from the rolling window';

-- ----------------------------------------
-- 4. loyalty_rewards - Tracks earned and redeemed rewards
-- ----------------------------------------
-- State machine: in_progress -> earned -> redeemed | revoked
CREATE TABLE IF NOT EXISTS loyalty_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Customer reference
    square_customer_id TEXT NOT NULL,

    -- Reward state machine
    -- in_progress: Customer is working towards this reward
    -- earned: Customer has met requirements, reward is available
    -- redeemed: Reward has been used
    -- revoked: Reward was invalidated (e.g., due to refunds)
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (
        status IN ('in_progress', 'earned', 'redeemed', 'revoked')
    ),

    -- Progress tracking (for in_progress rewards)
    current_quantity INTEGER NOT NULL DEFAULT 0,  -- Current qualifying purchases
    required_quantity INTEGER NOT NULL,  -- Snapshot of offer requirement at time of creation

    -- Window dates
    window_start_date DATE NOT NULL,  -- First qualifying purchase date
    window_end_date DATE NOT NULL,    -- Window expiration date

    -- State timestamps
    earned_at TIMESTAMPTZ,
    redeemed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,

    -- Redemption details (when status = 'redeemed')
    redemption_id UUID,  -- Links to loyalty_redemptions
    redemption_order_id TEXT,  -- Square order ID where reward was redeemed

    -- Revocation reason (when status = 'revoked')
    revocation_reason TEXT,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Only one in_progress reward per customer+offer at a time
    CONSTRAINT loyalty_rewards_one_in_progress UNIQUE(merchant_id, offer_id, square_customer_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- Note: The unique constraint is deferrable to allow for state transitions
-- When a reward transitions from in_progress to earned, a new in_progress can be created

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_merchant ON loyalty_rewards(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_offer ON loyalty_rewards(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer ON loyalty_rewards(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer_offer ON loyalty_rewards(merchant_id, square_customer_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_status ON loyalty_rewards(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_earned ON loyalty_rewards(merchant_id, square_customer_id, status) WHERE status = 'earned';
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_in_progress ON loyalty_rewards(merchant_id, square_customer_id, status) WHERE status = 'in_progress';

COMMENT ON TABLE loyalty_rewards IS 'Tracks reward progress and state: in_progress -> earned -> redeemed | revoked';
COMMENT ON COLUMN loyalty_rewards.status IS 'State machine: in_progress (accumulating), earned (available), redeemed (used), revoked (invalidated)';
COMMENT ON COLUMN loyalty_rewards.current_quantity IS 'Count of qualifying purchases within the rolling window';

-- ----------------------------------------
-- 5. loyalty_redemptions - Records reward redemptions
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    reward_id UUID NOT NULL REFERENCES loyalty_rewards(id) ON DELETE RESTRICT,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE RESTRICT,

    -- Customer reference
    square_customer_id TEXT NOT NULL,

    -- Redemption method
    redemption_type VARCHAR(50) NOT NULL CHECK (
        redemption_type IN ('order_discount', 'manual_admin', 'auto_detected')
    ),

    -- Square order reference
    square_order_id TEXT,  -- May be null for manual redemptions
    square_location_id TEXT,

    -- What was redeemed
    redeemed_variation_id TEXT,  -- The variation given free
    redeemed_item_name TEXT,
    redeemed_variation_name TEXT,
    redeemed_value_cents INTEGER,  -- Value of the free item

    -- Square integration
    square_discount_id TEXT,  -- If applied via Square discount

    -- Admin info (for manual redemptions)
    redeemed_by_user_id INTEGER REFERENCES users(id),
    admin_notes TEXT,

    -- Metadata
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_merchant ON loyalty_redemptions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_reward ON loyalty_redemptions(reward_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_customer ON loyalty_redemptions(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_order ON loyalty_redemptions(merchant_id, square_order_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_date ON loyalty_redemptions(merchant_id, redeemed_at);

COMMENT ON TABLE loyalty_redemptions IS 'Records all reward redemptions with full audit trail';
COMMENT ON COLUMN loyalty_redemptions.redemption_type IS 'How the redemption was processed: order_discount, manual_admin, auto_detected';

-- ----------------------------------------
-- 6. loyalty_audit_logs - Full audit trail
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_audit_logs (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,

    -- What happened
    action VARCHAR(100) NOT NULL,  -- PURCHASE_RECORDED, REFUND_PROCESSED, REWARD_EARNED, REWARD_REDEEMED, REWARD_REVOKED, etc.

    -- References (nullable - depending on action)
    offer_id UUID REFERENCES loyalty_offers(id) ON DELETE SET NULL,
    reward_id UUID REFERENCES loyalty_rewards(id) ON DELETE SET NULL,
    purchase_event_id UUID REFERENCES loyalty_purchase_events(id) ON DELETE SET NULL,
    redemption_id UUID REFERENCES loyalty_redemptions(id) ON DELETE SET NULL,

    -- Customer
    square_customer_id TEXT,

    -- Order reference
    square_order_id TEXT,

    -- State change details
    old_state VARCHAR(50),
    new_state VARCHAR(50),
    old_quantity INTEGER,
    new_quantity INTEGER,

    -- Context
    triggered_by VARCHAR(50) NOT NULL DEFAULT 'SYSTEM',  -- SYSTEM, WEBHOOK, MANUAL, ADMIN
    user_id INTEGER REFERENCES users(id),

    -- Additional details (JSON for flexibility)
    details JSONB,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_audit_merchant ON loyalty_audit_logs(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_customer ON loyalty_audit_logs(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_offer ON loyalty_audit_logs(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_reward ON loyalty_audit_logs(reward_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_action ON loyalty_audit_logs(merchant_id, action);
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_created ON loyalty_audit_logs(merchant_id, created_at DESC);

COMMENT ON TABLE loyalty_audit_logs IS 'Complete audit trail for all loyalty program actions';

-- ----------------------------------------
-- 7. loyalty_settings - Per-merchant configuration
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_settings (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT loyalty_settings_unique UNIQUE(merchant_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_settings_merchant ON loyalty_settings(merchant_id);

COMMENT ON TABLE loyalty_settings IS 'Per-merchant loyalty program configuration';

-- ----------------------------------------
-- 8. loyalty_customer_summary - Materialized customer state (for performance)
-- ----------------------------------------
-- Denormalized view of customer loyalty status for quick lookups
CREATE TABLE IF NOT EXISTS loyalty_customer_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_customer_id TEXT NOT NULL,
    offer_id UUID NOT NULL REFERENCES loyalty_offers(id) ON DELETE CASCADE,

    -- Current progress
    current_quantity INTEGER NOT NULL DEFAULT 0,
    required_quantity INTEGER NOT NULL,

    -- Window info
    window_start_date DATE,
    window_end_date DATE,

    -- Reward status
    has_earned_reward BOOLEAN NOT NULL DEFAULT FALSE,
    earned_reward_id UUID REFERENCES loyalty_rewards(id),

    -- Totals
    total_lifetime_purchases INTEGER NOT NULL DEFAULT 0,
    total_rewards_earned INTEGER NOT NULL DEFAULT 0,
    total_rewards_redeemed INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    last_purchase_at TIMESTAMPTZ,
    last_reward_earned_at TIMESTAMPTZ,
    last_reward_redeemed_at TIMESTAMPTZ,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT loyalty_customer_summary_unique UNIQUE(merchant_id, square_customer_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_merchant ON loyalty_customer_summary(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_customer ON loyalty_customer_summary(merchant_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_offer ON loyalty_customer_summary(offer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cust_summary_earned ON loyalty_customer_summary(merchant_id, has_earned_reward) WHERE has_earned_reward = TRUE;

COMMENT ON TABLE loyalty_customer_summary IS 'Denormalized customer loyalty status for quick lookups';

-- ----------------------------------------
-- 9. Create update trigger for updated_at columns
-- ----------------------------------------
CREATE OR REPLACE FUNCTION update_loyalty_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
DROP TRIGGER IF EXISTS loyalty_offers_updated_at ON loyalty_offers;
CREATE TRIGGER loyalty_offers_updated_at
    BEFORE UPDATE ON loyalty_offers
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_qualifying_variations_updated_at ON loyalty_qualifying_variations;
CREATE TRIGGER loyalty_qualifying_variations_updated_at
    BEFORE UPDATE ON loyalty_qualifying_variations
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_purchase_events_updated_at ON loyalty_purchase_events;
CREATE TRIGGER loyalty_purchase_events_updated_at
    BEFORE UPDATE ON loyalty_purchase_events
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_rewards_updated_at ON loyalty_rewards;
CREATE TRIGGER loyalty_rewards_updated_at
    BEFORE UPDATE ON loyalty_rewards
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

DROP TRIGGER IF EXISTS loyalty_customer_summary_updated_at ON loyalty_customer_summary;
CREATE TRIGGER loyalty_customer_summary_updated_at
    BEFORE UPDATE ON loyalty_customer_summary
    FOR EACH ROW
    EXECUTE FUNCTION update_loyalty_updated_at();

-- ----------------------------------------
-- 10. Insert default settings
-- ----------------------------------------
-- Note: Settings will be created per-merchant on first access
-- This just documents the expected settings

COMMENT ON TABLE loyalty_settings IS 'Expected settings: auto_detect_redemptions (true/false), send_receipt_messages (true/false)';

-- ----------------------------------------
-- Future Schema Extensions - TODO (vNext)
-- ----------------------------------------
-- The following schema additions are planned for future releases:
--
-- TODO (vNext): Buy X Save Y% instantly (promo-compatible discounting)
--   - Add discount_type column to loyalty_offers: 'free_item' | 'percent_off' | 'fixed_amount'
--   - Add discount_value column for percentage or fixed amount
--   - Add min_qualifying_quantity for instant discounts
--
-- TODO (vNext): Pre-checkout POS reward prompts
--   - Add loyalty_pending_notifications table for POS alerts
--   - Track notification delivery status
--
-- TODO (vNext): Loyalty tiers
--   - Add loyalty_tiers table (bronze, silver, gold)
--   - Add tier_id to loyalty_customer_summary
--   - Add tier_multiplier for earning rate bonuses
--
-- TODO (vNext): Customer communication preferences
--   - Add loyalty_customer_preferences table
--   - Email opt-in, notification preferences
-- ----------------------------------------

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Loyalty Program migration completed successfully!';
    RAISE NOTICE 'Created tables:';
    RAISE NOTICE '  - loyalty_offers (defines frequent buyer programs)';
    RAISE NOTICE '  - loyalty_qualifying_variations (maps Square variations to offers)';
    RAISE NOTICE '  - loyalty_purchase_events (tracks qualifying purchases)';
    RAISE NOTICE '  - loyalty_rewards (tracks reward state: in_progress -> earned -> redeemed | revoked)';
    RAISE NOTICE '  - loyalty_redemptions (records redemption details)';
    RAISE NOTICE '  - loyalty_audit_logs (complete audit trail)';
    RAISE NOTICE '  - loyalty_settings (per-merchant configuration)';
    RAISE NOTICE '  - loyalty_customer_summary (denormalized customer status)';
END $$;

COMMIT;
