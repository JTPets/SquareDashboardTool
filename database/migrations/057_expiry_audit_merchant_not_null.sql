-- =============================================================================
-- Migration 057: Add NOT NULL constraint to expiry_discount_audit_log.merchant_id
-- =============================================================================
-- In a multi-tenant system, all audit records must be merchant-scoped.
-- NULL merchant_id rows would be orphaned and invisible to any tenant query.
--
-- Safety: This migration verifies no NULL rows exist before adding the
-- constraint. If any NULL rows are found, it raises an error and aborts.
--
-- Ref: REMEDIATION-PLAN.md D-6
-- =============================================================================

DO $$
DECLARE
    null_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO null_count
    FROM expiry_discount_audit_log
    WHERE merchant_id IS NULL;

    IF null_count > 0 THEN
        RAISE EXCEPTION 'Cannot add NOT NULL constraint: % rows have NULL merchant_id in expiry_discount_audit_log. Backfill required before running this migration.', null_count;
    END IF;

    RAISE NOTICE 'Verified: 0 NULL merchant_id rows in expiry_discount_audit_log. Safe to add constraint.';
END $$;

ALTER TABLE expiry_discount_audit_log
ALTER COLUMN merchant_id SET NOT NULL;
