-- Migration 041: Fix webhook_events merchant_id column type
-- Changes merchant_id from TEXT (Square merchant ID) to INTEGER (internal FK)
-- Preserves the Square merchant ID in a new square_merchant_id column

BEGIN;

-- Step 1: Rename the existing TEXT merchant_id to square_merchant_id
ALTER TABLE webhook_events RENAME COLUMN merchant_id TO square_merchant_id;

-- Step 2: Add the properly-typed merchant_id column with FK constraint
ALTER TABLE webhook_events ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);

-- Step 3: Backfill the new column from existing data
-- Maps Square merchant IDs to internal merchant IDs via the merchants table
UPDATE webhook_events we
SET merchant_id = m.id
FROM merchants m
WHERE we.square_merchant_id = m.square_merchant_id;

-- Step 4: Add index for multi-tenant queries (leading with merchant_id per CLAUDE.md rules)
CREATE INDEX IF NOT EXISTS idx_webhook_events_merchant_id
    ON webhook_events(merchant_id);

-- Step 5: Log any orphaned rows (square_merchant_id with no matching merchant)
-- These are kept but will have NULL merchant_id
DO $$
DECLARE
    orphan_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO orphan_count
    FROM webhook_events
    WHERE square_merchant_id IS NOT NULL AND merchant_id IS NULL;

    IF orphan_count > 0 THEN
        RAISE NOTICE 'Migration 041: % webhook_events rows have no matching merchant (orphaned)', orphan_count;
    END IF;
END $$;

COMMIT;
