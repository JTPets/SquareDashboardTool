-- Migration 063: Add merchant_id to subscribers table
-- Bridges System B (SaaS billing) to System A (merchant subscription enforcement)
--
-- Previously, the subscribers table had no link to the merchants table.
-- This migration adds merchant_id so we know which merchant a subscriber is paying for.

-- Add merchant_id column to subscribers
ALTER TABLE subscribers
ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- Index for lookups by merchant
CREATE INDEX IF NOT EXISTS idx_subscribers_merchant_id ON subscribers(merchant_id);

-- Add comment
COMMENT ON COLUMN subscribers.merchant_id IS 'Links subscriber billing record to the merchant they are paying for (bridges System A and System B)';
