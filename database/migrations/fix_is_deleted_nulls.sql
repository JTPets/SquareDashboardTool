-- Migration: Fix NULL values in is_deleted columns
-- This fixes existing rows that have NULL for is_deleted after the column was added
-- Run this if the expiry page shows "No items found"

-- Backfill NULL values with FALSE
UPDATE items SET is_deleted = FALSE WHERE is_deleted IS NULL;
UPDATE variations SET is_deleted = FALSE WHERE is_deleted IS NULL;

-- Verify the fix
SELECT 'Items with NULL is_deleted:' as status, COUNT(*) as count FROM items WHERE is_deleted IS NULL;
SELECT 'Variations with NULL is_deleted:' as status, COUNT(*) as count FROM variations WHERE is_deleted IS NULL;
SELECT 'Total variations (should be 2781):' as status, COUNT(*) as count FROM variations;
SELECT 'Non-deleted variations:' as status, COUNT(*) as count FROM variations WHERE COALESCE(is_deleted, FALSE) = FALSE;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed: Updated is_deleted NULL values to FALSE';
END $$;
