-- Migration: 037_cart_activity.sql
-- Purpose: Create cart_activity table for tracking DRAFT orders (shopping carts)
-- Date: 2026-02-03

-- Create cart_activity table
CREATE TABLE IF NOT EXISTS cart_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_order_id VARCHAR(255) NOT NULL,

    -- Customer identification (privacy-compliant)
    square_customer_id VARCHAR(255),
    customer_id_hash VARCHAR(64),
    phone_last4 VARCHAR(4),

    -- Cart contents
    cart_total_cents INTEGER,
    item_count INTEGER,
    items_json JSONB,

    -- Source tracking
    source_name VARCHAR(100),
    location_id VARCHAR(255),
    fulfillment_type VARCHAR(50),
    shipping_estimate_cents INTEGER,

    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending' CHECK (
        status IN ('pending', 'converted', 'abandoned', 'canceled')
    ),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    converted_at TIMESTAMPTZ,

    -- Unique constraint per merchant
    CONSTRAINT cart_activity_unique_order UNIQUE (merchant_id, square_order_id)
);

-- Indexes for common queries
CREATE INDEX idx_cart_activity_merchant_status
    ON cart_activity(merchant_id, status);

CREATE INDEX idx_cart_activity_merchant_created
    ON cart_activity(merchant_id, created_at DESC);

-- Partial index for cleanup job (pending carts older than threshold)
CREATE INDEX idx_cart_activity_pending_old
    ON cart_activity(merchant_id, created_at)
    WHERE status = 'pending';

-- Comments
COMMENT ON TABLE cart_activity IS 'Shopping cart activity tracking for DRAFT orders from Square Online';
COMMENT ON COLUMN cart_activity.status IS 'pending=DRAFT order, converted=transitioned to OPEN/COMPLETED, abandoned=7+ days pending, canceled=Square CANCELED';
COMMENT ON COLUMN cart_activity.phone_last4 IS 'Last 4 digits of phone for privacy-compliant identification';
COMMENT ON COLUMN cart_activity.customer_id_hash IS 'SHA-256 hash of customer_id for matching without storing PII';
