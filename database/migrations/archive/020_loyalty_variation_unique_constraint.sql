-- ========================================
-- MIGRATION: Fix loyalty variation uniqueness
-- ========================================
-- BUG FIX: A variation could be assigned to multiple offers from the same brand,
-- causing purchases to track to the wrong offer (non-deterministic first match).
--
-- SOLUTION: Add unique constraint to ensure each variation can only belong to
-- ONE offer per merchant.
--
-- Usage: psql -d your_database -f 020_loyalty_variation_unique_constraint.sql

BEGIN;

-- ----------------------------------------
-- 1. Check for existing duplicates before adding constraint
-- ----------------------------------------
-- This will show any variations that are currently in multiple offers
DO $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT merchant_id, variation_id, COUNT(*) as offer_count
        FROM loyalty_qualifying_variations
        WHERE is_active = TRUE
        GROUP BY merchant_id, variation_id
        HAVING COUNT(*) > 1
    ) dupes;

    IF duplicate_count > 0 THEN
        RAISE WARNING 'Found % variation(s) assigned to multiple offers. These must be cleaned up manually before constraint can be enforced.', duplicate_count;
        RAISE WARNING 'Run this query to see duplicates: SELECT merchant_id, variation_id, array_agg(offer_id) as offer_ids FROM loyalty_qualifying_variations WHERE is_active = TRUE GROUP BY merchant_id, variation_id HAVING COUNT(*) > 1;';
    END IF;
END $$;

-- ----------------------------------------
-- 2. Add unique constraint on (merchant_id, variation_id)
-- ----------------------------------------
-- This ensures a variation can only belong to ONE offer per merchant
-- Note: Using a partial unique index on is_active = TRUE allows deactivated
-- variations to exist in multiple places (for historical records)
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_qual_vars_unique_per_merchant
    ON loyalty_qualifying_variations(merchant_id, variation_id)
    WHERE is_active = TRUE;

-- Add a comment explaining the constraint
COMMENT ON INDEX idx_loyalty_qual_vars_unique_per_merchant IS
    'Ensures each active variation can only qualify for ONE offer per merchant. Prevents tracking ambiguity.';

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Migration 020 completed successfully!';
    RAISE NOTICE 'Added unique index on (merchant_id, variation_id) for active variations.';
    RAISE NOTICE 'Each variation can now only belong to one active offer per merchant.';
END $$;

COMMIT;
