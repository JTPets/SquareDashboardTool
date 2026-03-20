-- Migration: 033_loyalty_audit_log
-- Description: Add loyalty_audit_log table for tracking orphaned rewards and discrepancies
--
-- NOTE: This migration must be run manually:
-- set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/033_loyalty_audit_log.sql

BEGIN;

-- Loyalty audit log for tracking discrepancies between Square and local DB
CREATE TABLE IF NOT EXISTS loyalty_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_customer_id TEXT,
    order_id TEXT,
    reward_id TEXT,
    issue_type VARCHAR(50) NOT NULL CHECK (issue_type IN (
        'MISSING_REDEMPTION',   -- Redeemed in Square but no local record
        'PHANTOM_REWARD',       -- Local reward with no Square backing
        'DOUBLE_REDEMPTION'     -- Same reward appears redeemed multiple times
    )),
    details JSONB,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying unresolved issues by merchant
CREATE INDEX idx_loyalty_audit_log_merchant_resolved
    ON loyalty_audit_log(merchant_id, resolved, created_at DESC);

-- Index for finding issues by order
CREATE INDEX idx_loyalty_audit_log_order
    ON loyalty_audit_log(merchant_id, order_id)
    WHERE order_id IS NOT NULL;

-- Index for finding issues by customer
CREATE INDEX idx_loyalty_audit_log_customer
    ON loyalty_audit_log(merchant_id, square_customer_id)
    WHERE square_customer_id IS NOT NULL;

COMMIT;
