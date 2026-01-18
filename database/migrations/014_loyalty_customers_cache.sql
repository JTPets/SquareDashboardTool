-- Migration: 014_loyalty_customers_cache
-- Description: Add customers cache table for loyalty program
-- This allows customer lookup without API calls for customers we've seen before

-- Customers cache table - stores customer details for quick lookup
CREATE TABLE IF NOT EXISTS loyalty_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_customer_id TEXT NOT NULL,

    -- Customer details from Square
    given_name TEXT,
    family_name TEXT,
    display_name TEXT,
    phone_number TEXT,
    email_address TEXT,
    company_name TEXT,

    -- Metadata
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_order_at TIMESTAMP,

    -- Loyalty stats (denormalized for quick access)
    total_orders INTEGER DEFAULT 0,
    total_rewards_earned INTEGER DEFAULT 0,
    has_active_rewards BOOLEAN DEFAULT FALSE,

    CONSTRAINT uq_loyalty_customers_merchant_square UNIQUE (merchant_id, square_customer_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_loyalty_customers_merchant ON loyalty_customers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_customers_square_id ON loyalty_customers(square_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_customers_phone ON loyalty_customers(merchant_id, phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loyalty_customers_email ON loyalty_customers(merchant_id, email_address) WHERE email_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loyalty_customers_name ON loyalty_customers(merchant_id, display_name) WHERE display_name IS NOT NULL;

-- Add comment explaining the table
COMMENT ON TABLE loyalty_customers IS 'Cache of Square customer details for loyalty program lookups - reduces API calls';
