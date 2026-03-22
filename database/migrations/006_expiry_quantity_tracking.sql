-- Migration: Add expiry quantity tracking to variation_discount_status
-- When expiring_quantity is set, track units sold at discount. When threshold reached,
-- flag for manual review instead of auto-removing discount. Staff reviews and decides.
-- Date: 2026-03-22 (BACKLOG-94)

BEGIN;

ALTER TABLE variation_discount_status
    ADD COLUMN IF NOT EXISTS expiring_quantity INTEGER,
    ADD COLUMN IF NOT EXISTS units_sold_at_discount INTEGER DEFAULT 0;

COMMIT;
