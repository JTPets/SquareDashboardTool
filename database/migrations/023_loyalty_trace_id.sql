-- Migration: Add trace_id columns for loyalty service debugging
-- Purpose: Enable correlation tracking across all loyalty-related tables
-- Author: claude-code
-- Date: 2026-01-22

-- Add trace_id to loyalty_audit_logs for tracking operation chains
ALTER TABLE loyalty_audit_logs
ADD COLUMN IF NOT EXISTS trace_id UUID;

-- Add trace_id to loyalty_purchase_events for purchase correlation
ALTER TABLE loyalty_purchase_events
ADD COLUMN IF NOT EXISTS trace_id UUID;

-- Add trace_id to loyalty_rewards for reward tracking
ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS trace_id UUID;

-- Create indexes for efficient trace_id queries
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_logs_trace_id
ON loyalty_audit_logs(trace_id)
WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_trace_id
ON loyalty_purchase_events(trace_id)
WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_trace_id
ON loyalty_rewards(trace_id)
WHERE trace_id IS NOT NULL;

-- Add comment explaining the trace_id purpose
COMMENT ON COLUMN loyalty_audit_logs.trace_id IS 'Correlation ID for tracking related operations. Query all records with same trace_id to see complete processing chain.';
COMMENT ON COLUMN loyalty_purchase_events.trace_id IS 'Correlation ID linking this purchase to its processing trace';
COMMENT ON COLUMN loyalty_rewards.trace_id IS 'Correlation ID for the operation that created/updated this reward';

-- Verification: Check columns exist
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loyalty_audit_logs' AND column_name = 'trace_id'
    ) THEN
        RAISE NOTICE 'trace_id column added to loyalty_audit_logs';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loyalty_purchase_events' AND column_name = 'trace_id'
    ) THEN
        RAISE NOTICE 'trace_id column added to loyalty_purchase_events';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'loyalty_rewards' AND column_name = 'trace_id'
    ) THEN
        RAISE NOTICE 'trace_id column added to loyalty_rewards';
    END IF;
END $$;
