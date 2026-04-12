BEGIN;

-- Migration 019: Enforce stock_alert_min < stock_alert_max at DB level
--
-- Prevents conflicting min/max values that silently drop below-minimum items
-- from reorder suggestions (items below min but with max < min were being
-- capped to 0 and filtered out).
--
-- Normalization: stock_alert_max = 0 has always been treated as "unlimited"
-- at the application layer, but stored as 0. Normalize to NULL so the CHECK
-- constraint has a single representation for "no cap".
--
-- Constraint semantics:
--   - NULL stock_alert_min: no constraint (no minimum configured)
--   - NULL stock_alert_max: no constraint (unlimited — preferred encoding)
--   - both set: stock_alert_min must be strictly less than stock_alert_max
--
-- No auto-fixing of genuine conflicts (min >= max with both > 0) — the
-- migration will fail loudly if any such rows exist, surfacing them for
-- manual merchant review. Normalizing 0→NULL is safe because 0 was always
-- treated as unlimited at the read layer.

-- Normalize 0 → NULL on both tables before adding the constraint
UPDATE variation_location_settings
    SET stock_alert_max = NULL
    WHERE stock_alert_max = 0;

UPDATE variations
    SET stock_alert_max = NULL
    WHERE stock_alert_max = 0;

-- Drop any prior attempt (re-runnable migration)
ALTER TABLE variation_location_settings
    DROP CONSTRAINT IF EXISTS chk_vls_min_less_than_max;

ALTER TABLE variations
    DROP CONSTRAINT IF EXISTS chk_v_min_less_than_max;

-- Enforce min < max when both are set
ALTER TABLE variation_location_settings
    ADD CONSTRAINT chk_vls_min_less_than_max
    CHECK (stock_alert_min IS NULL
           OR stock_alert_max IS NULL
           OR stock_alert_min < stock_alert_max);

ALTER TABLE variations
    ADD CONSTRAINT chk_v_min_less_than_max
    CHECK (stock_alert_min IS NULL
           OR stock_alert_max IS NULL
           OR stock_alert_min < stock_alert_max);

-- Document the 0 → NULL normalization policy on both columns
COMMENT ON COLUMN variations.stock_alert_max IS
    'Maximum stock level to avoid overstocking. NULL means unlimited. '
    'Writes of 0 are normalized to NULL by the application layer. '
    'CHECK constraint chk_v_min_less_than_max enforces min < max.';

COMMENT ON COLUMN variation_location_settings.stock_alert_max IS
    'Per-location maximum stock level. NULL means unlimited (overrides '
    'variation-level cap when set). Writes of 0 are normalized to NULL. '
    'CHECK constraint chk_vls_min_less_than_max enforces min < max.';

COMMIT;
