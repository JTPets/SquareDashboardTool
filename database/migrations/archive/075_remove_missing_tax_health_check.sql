-- Migration 075: Remove missing_tax from catalog health checks
-- Redundant with catalog audit "No Tax IDs" card which shows full product details.
-- Resolve any open missing_tax rows and update the CHECK constraint.

-- Resolve all open missing_tax rows
UPDATE catalog_location_health
SET resolved_at = NOW(), status = 'valid'
WHERE check_type = 'missing_tax' AND status = 'mismatch' AND resolved_at IS NULL;

-- Drop and recreate the check_type constraint without missing_tax
ALTER TABLE catalog_location_health DROP CONSTRAINT IF EXISTS catalog_location_health_check_type_check;
ALTER TABLE catalog_location_health ADD CONSTRAINT catalog_location_health_check_type_check
    CHECK (check_type IN (
        'location_mismatch',
        'orphaned_variation',
        'deleted_parent',
        'category_orphan',
        'image_orphan',
        'modifier_orphan',
        'pricing_rule_orphan'
    ));
