-- Migration 019: Add multi-tenant support to sync_history
-- This adds merchant_id and synced_at columns needed for multi-tenant sync tracking

-- Add merchant_id column
ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- Add synced_at column (simple timestamp for last sync)
ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- For existing rows, set merchant_id to NULL (legacy single-tenant data)
-- New rows will require merchant_id for the unique constraint to work properly

-- Create unique constraint for ON CONFLICT clause
-- This allows upsert by (sync_type, merchant_id)
DO $$
BEGIN
    -- Drop old constraint if it exists
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sync_history_type_merchant_unique'
    ) THEN
        ALTER TABLE sync_history DROP CONSTRAINT sync_history_type_merchant_unique;
    END IF;

    -- Create new unique constraint
    ALTER TABLE sync_history ADD CONSTRAINT sync_history_type_merchant_unique
        UNIQUE(sync_type, merchant_id);
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Constraint sync_history_type_merchant_unique already exists';
END $$;

-- Create index for merchant queries
CREATE INDEX IF NOT EXISTS idx_sync_history_merchant ON sync_history(merchant_id);

-- Update schema comments
COMMENT ON COLUMN sync_history.merchant_id IS 'Merchant ID for multi-tenant sync tracking';
COMMENT ON COLUMN sync_history.synced_at IS 'Timestamp of last successful sync completion';
