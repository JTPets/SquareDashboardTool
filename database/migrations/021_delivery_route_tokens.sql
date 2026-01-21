-- Migration: 021_delivery_route_tokens.sql
-- Description: Add token-based access for sharing delivery routes with contract drivers
-- Created: 2026-01-21

-- Route share tokens for contract driver access
CREATE TABLE IF NOT EXISTS delivery_route_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    token VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    driver_name VARCHAR(255),  -- Optional: track who used the token
    driver_notes TEXT
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_route_tokens_token ON delivery_route_tokens(token);

-- Index for finding tokens by route
CREATE INDEX IF NOT EXISTS idx_route_tokens_route ON delivery_route_tokens(route_id);

-- Index for merchant's tokens
CREATE INDEX IF NOT EXISTS idx_route_tokens_merchant ON delivery_route_tokens(merchant_id, status);

-- Only one active token per route at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_tokens_active_route
ON delivery_route_tokens(route_id)
WHERE status = 'active';

COMMENT ON TABLE delivery_route_tokens IS 'Shareable tokens for contract drivers to access delivery routes without authentication';
COMMENT ON COLUMN delivery_route_tokens.token IS 'Unique URL-safe token for route access';
COMMENT ON COLUMN delivery_route_tokens.status IS 'active=usable, used=route finished, expired=past expiry, revoked=manually cancelled';
