-- =============================================================================
-- Migration 056: Add composite index on inventory_counts for analytics queries
-- =============================================================================
-- Common analytics queries filter by (merchant_id, location_id, state).
-- This composite index optimizes those queries.
-- Ref: REMEDIATION-PLAN.md D-2
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_inventory_counts_merchant_location_state
ON inventory_counts(merchant_id, location_id, state);
