-- ========================================
-- MIGRATION: Resolve False Positive Audit Findings
-- ========================================
-- The loyalty audit job was incorrectly flagging Square's native points
-- loyalty redemptions as MISSING_REDEMPTION. These are a different system
-- from our custom punch card loyalty (customer group discounts).
--
-- This migration resolves the 4 false positive findings that were logged
-- before the fix was applied.
--
-- Usage: psql -d your_database -f 034_resolve_false_positive_audit_findings.sql

BEGIN;

-- Resolve all existing MISSING_REDEMPTION findings
-- These were false positives from Square's native points loyalty system
UPDATE loyalty_audit_log
SET
    resolved = TRUE,
    resolved_at = NOW(),
    details = jsonb_set(
        COALESCE(details, '{}'::jsonb),
        '{resolution}',
        '"false_positive_square_native_points_loyalty"'::jsonb
    )
WHERE issue_type = 'MISSING_REDEMPTION'
  AND resolved = FALSE;

-- Log how many were resolved
DO $$
DECLARE
    resolved_count INTEGER;
BEGIN
    GET DIAGNOSTICS resolved_count = ROW_COUNT;
    RAISE NOTICE 'Resolved % false positive MISSING_REDEMPTION findings', resolved_count;
END $$;

COMMIT;
