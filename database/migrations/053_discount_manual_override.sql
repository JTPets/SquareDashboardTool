-- Migration 053: Add manual override and review columns to variation_discount_status
-- Supports tier regression guard and manual override audit trail
-- Date: 2026-02-23

-- Add needs_manual_review flag (set when tier regression is detected)
ALTER TABLE variation_discount_status
    ADD COLUMN IF NOT EXISTS needs_manual_review BOOLEAN DEFAULT FALSE;

-- Add manual override tracking columns
ALTER TABLE variation_discount_status
    ADD COLUMN IF NOT EXISTS manually_overridden BOOLEAN DEFAULT FALSE;

ALTER TABLE variation_discount_status
    ADD COLUMN IF NOT EXISTS manual_override_at TIMESTAMPTZ;

ALTER TABLE variation_discount_status
    ADD COLUMN IF NOT EXISTS manual_override_note TEXT;

-- Index for quickly finding flagged items
CREATE INDEX IF NOT EXISTS idx_variation_discount_manual_review
    ON variation_discount_status(needs_manual_review)
    WHERE needs_manual_review = TRUE;

-- Index for manually overridden items
CREATE INDEX IF NOT EXISTS idx_variation_discount_overridden
    ON variation_discount_status(manually_overridden)
    WHERE manually_overridden = TRUE;
