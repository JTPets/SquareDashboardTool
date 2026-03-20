-- Migration 004: Subscription Management for Square Dashboard Addon Tool
-- Adds tables for managing customer subscriptions via Square Subscriptions API

-- Subscribers table - tracks each subscriber/tenant
CREATE TABLE IF NOT EXISTS subscribers (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    business_name TEXT,
    square_customer_id TEXT UNIQUE,
    square_subscription_id TEXT UNIQUE,

    -- Subscription status
    subscription_status TEXT DEFAULT 'trial', -- trial, active, canceled, expired, past_due
    subscription_plan TEXT DEFAULT 'monthly', -- monthly, annual

    -- Pricing (in cents)
    price_cents INTEGER NOT NULL DEFAULT 999, -- $9.99 default

    -- Important dates
    trial_start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    trial_end_date TIMESTAMP, -- 30 days from start
    subscription_start_date TIMESTAMP,
    subscription_end_date TIMESTAMP,
    next_billing_date TIMESTAMP,
    canceled_at TIMESTAMP,

    -- Payment info
    card_brand TEXT, -- VISA, MASTERCARD, etc
    card_last_four TEXT,
    card_id TEXT, -- Square card on file ID

    -- Intro pricing flag
    is_intro_pricing BOOLEAN DEFAULT TRUE,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription payments history
CREATE TABLE IF NOT EXISTS subscription_payments (
    id SERIAL PRIMARY KEY,
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    square_payment_id TEXT UNIQUE,
    square_invoice_id TEXT,

    -- Payment details
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'CAD',
    status TEXT NOT NULL, -- completed, failed, refunded, pending

    -- Payment type
    payment_type TEXT DEFAULT 'subscription', -- subscription, refund, one_time
    billing_period_start TIMESTAMP,
    billing_period_end TIMESTAMP,

    -- Refund tracking
    refund_amount_cents INTEGER,
    refund_reason TEXT,
    refunded_at TIMESTAMP,

    -- Metadata
    receipt_url TEXT,
    failure_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription events log (for debugging and audit)
CREATE TABLE IF NOT EXISTS subscription_events (
    id SERIAL PRIMARY KEY,
    subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, -- subscription.created, payment.completed, subscription.canceled, etc
    event_data JSONB,
    square_event_id TEXT,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription plans configuration
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    plan_key TEXT NOT NULL UNIQUE, -- monthly, annual
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL,
    billing_frequency TEXT NOT NULL, -- MONTHLY, ANNUAL
    square_plan_id TEXT, -- Square catalog subscription plan ID
    is_active BOOLEAN DEFAULT TRUE,
    is_intro_pricing BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default subscription plans (intro pricing)
INSERT INTO subscription_plans (plan_key, name, description, price_cents, billing_frequency, is_intro_pricing) VALUES
    ('monthly', 'Monthly Plan (Intro)', 'Full feature access - billed monthly. Introductory pricing for early adopters!', 2999, 'MONTHLY', TRUE),
    ('annual', 'Annual Plan (Intro)', 'Full feature access - billed annually. Save $60/year! Introductory pricing for early adopters!', 29999, 'ANNUAL', TRUE)
ON CONFLICT (plan_key) DO UPDATE SET
    price_cents = EXCLUDED.price_cents,
    description = EXCLUDED.description,
    updated_at = CURRENT_TIMESTAMP;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(subscription_status);
CREATE INDEX IF NOT EXISTS idx_subscribers_square_customer ON subscribers(square_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_square_subscription ON subscribers(square_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscriber ON subscription_payments(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX IF NOT EXISTS idx_subscription_events_subscriber ON subscription_events(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_type ON subscription_events(event_type);

-- Add comment
COMMENT ON TABLE subscribers IS 'Tracks all subscribers to Square Dashboard Addon Tool with their subscription status';
COMMENT ON TABLE subscription_payments IS 'Payment history for all subscription transactions';
COMMENT ON TABLE subscription_events IS 'Audit log of all subscription-related events from Square webhooks';
COMMENT ON TABLE subscription_plans IS 'Available subscription plans with pricing';
