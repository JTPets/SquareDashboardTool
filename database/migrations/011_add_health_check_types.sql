-- Migration 011: Add 3 new check_type values to catalog_location_health
-- New content-quality health checks: missing_online_content, missing_seo_data, sellable_not_tracked

-- Drop and recreate the check_type constraint with new values
ALTER TABLE catalog_location_health DROP CONSTRAINT IF EXISTS catalog_location_health_check_type_check;
ALTER TABLE catalog_location_health ADD CONSTRAINT catalog_location_health_check_type_check
    CHECK (check_type IN (
        'location_mismatch',
        'orphaned_variation',
        'deleted_parent',
        'category_orphan',
        'image_orphan',
        'modifier_orphan',
        'pricing_rule_orphan',
        'missing_online_content',
        'missing_seo_data',
        'sellable_not_tracked'
    ));
