-- Migration 070: Expand catalog_location_health into full Catalog Health Monitor
-- Adds check_type, object_type, parent_id, severity columns for multi-check support

-- Add check_type column (default 'location_mismatch' for existing rows)
ALTER TABLE catalog_location_health
    ADD COLUMN IF NOT EXISTS check_type TEXT NOT NULL DEFAULT 'location_mismatch'
    CHECK (check_type IN (
        'location_mismatch',
        'orphaned_variation',
        'deleted_parent',
        'category_orphan',
        'image_orphan',
        'modifier_orphan',
        'pricing_rule_orphan',
        'missing_tax'
    ));

-- Add object_type column (ITEM, ITEM_VARIATION, PRICING_RULE, etc.)
ALTER TABLE catalog_location_health
    ADD COLUMN IF NOT EXISTS object_type TEXT;

-- Add parent_id column (parent item ID for variation-level issues)
ALTER TABLE catalog_location_health
    ADD COLUMN IF NOT EXISTS parent_id TEXT;

-- Add severity column (default 'error'; missing_tax uses 'warn')
ALTER TABLE catalog_location_health
    ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'error'
    CHECK (severity IN ('error', 'warn'));

-- Backfill existing rows: all prior records are location_mismatch / ITEM_VARIATION / error
UPDATE catalog_location_health
SET object_type = 'ITEM_VARIATION',
    check_type = 'location_mismatch',
    severity = 'error'
WHERE object_type IS NULL;

-- Add index for check_type lookups
CREATE INDEX IF NOT EXISTS idx_catalog_health_merchant_check_status
    ON catalog_location_health (merchant_id, check_type, status);

COMMENT ON COLUMN catalog_location_health.check_type IS 'Type of health check that detected this issue';
COMMENT ON COLUMN catalog_location_health.object_type IS 'Square catalog object type (ITEM, ITEM_VARIATION, PRICING_RULE, etc.)';
COMMENT ON COLUMN catalog_location_health.parent_id IS 'Parent item ID for variation-level issues';
COMMENT ON COLUMN catalog_location_health.severity IS 'Issue severity: error or warn';
