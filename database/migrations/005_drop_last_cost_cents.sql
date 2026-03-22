-- Migration: Drop dead columns last_cost_cents and last_cost_date from variations
-- These columns were never written to by any code path. Vendor costs are tracked in
-- variation_vendors.unit_cost_money (per-vendor cost). Confirmed NULL across all rows.
-- Date: 2026-03-22

BEGIN;

ALTER TABLE variations DROP COLUMN IF EXISTS last_cost_cents;
ALTER TABLE variations DROP COLUMN IF EXISTS last_cost_date;

COMMIT;
