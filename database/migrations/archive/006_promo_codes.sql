-- Migration 006: Promo/Discount Codes for Subscriptions
-- Adds support for promotional discount codes

-- Promo codes table
CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    description TEXT,

    -- Discount type: 'percent' (e.g., 50 = 50% off) or 'fixed' (e.g., 500 = $5.00 off)
    discount_type TEXT NOT NULL DEFAULT 'percent', -- percent, fixed
    discount_value INTEGER NOT NULL, -- percentage or cents depending on type

    -- Restrictions
    max_uses INTEGER, -- NULL = unlimited
    times_used INTEGER DEFAULT 0,
    min_purchase_cents INTEGER DEFAULT 0, -- minimum order amount

    -- Validity
    valid_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP, -- NULL = never expires
    is_active BOOLEAN DEFAULT TRUE,

    -- Plan restrictions (NULL = applies to all plans)
    applies_to_plans TEXT[], -- e.g., {'monthly', 'annual'}

    -- Metadata
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add promo_code_id to subscribers to track which code they used
ALTER TABLE subscribers
ADD COLUMN IF NOT EXISTS promo_code_id INTEGER REFERENCES promo_codes(id),
ADD COLUMN IF NOT EXISTS discount_applied_cents INTEGER DEFAULT 0;

-- Promo code usage tracking
CREATE TABLE IF NOT EXISTS promo_code_uses (
    id SERIAL PRIMARY KEY,
    promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    discount_applied_cents INTEGER NOT NULL,
    used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(promo_code_id, subscriber_id) -- Each subscriber can only use a code once
);

-- Create some initial promo codes for testing
INSERT INTO promo_codes (code, description, discount_type, discount_value, max_uses, valid_until, created_by) VALUES
    ('BETA100', 'Beta tester - 100% off first payment', 'percent', 100, 50, NULL, 'system'),
    ('HALFOFF', '50% off first month', 'percent', 50, NULL, NULL, 'system'),
    ('SAVE5', '$5 off any plan', 'fixed', 500, NULL, NULL, 'system')
ON CONFLICT (code) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active);
CREATE INDEX IF NOT EXISTS idx_promo_code_uses_code ON promo_code_uses(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_code_uses_subscriber ON promo_code_uses(subscriber_id);

COMMENT ON TABLE promo_codes IS 'Promotional discount codes for subscriptions';
COMMENT ON TABLE promo_code_uses IS 'Tracks which subscribers used which promo codes';
