-- cleanup-duplicate-deliveries.sql
-- One-time script to deduplicate delivery_orders rows before applying
-- the UNIQUE index from migration 058.
--
-- Strategy: For each (square_order_id, merchant_id) group with >1 row,
-- keep the EARLIEST created row and DELETE the rest.
--
-- Usage:
--   set -a && source .env && set +a && \
--   PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
--     -f scripts/cleanup-duplicate-deliveries.sql
--
-- IMPORTANT: Run this BEFORE migration 058 (the unique index).
-- The migration will fail if duplicates still exist.

BEGIN;

-- Step 1: Audit — show what will be deleted
\echo '=== DUPLICATE DELIVERY ORDERS (will be deleted) ==='
SELECT
    d.id,
    d.merchant_id,
    d.square_order_id,
    d.customer_name,
    d.status,
    d.created_at,
    d.route_id,
    CASE
        WHEN d.created_at = first_row.min_created THEN 'KEEP'
        ELSE 'DELETE'
    END AS action
FROM delivery_orders d
INNER JOIN (
    SELECT square_order_id, merchant_id, MIN(created_at) AS min_created
    FROM delivery_orders
    WHERE square_order_id IS NOT NULL
    GROUP BY square_order_id, merchant_id
    HAVING COUNT(*) > 1
) first_row
    ON d.square_order_id = first_row.square_order_id
    AND d.merchant_id = first_row.merchant_id
ORDER BY d.square_order_id, d.merchant_id, d.created_at;

-- Step 2: Count duplicates
\echo '=== SUMMARY ==='
SELECT
    COUNT(*) AS total_duplicate_rows,
    COUNT(DISTINCT (square_order_id, merchant_id)) AS affected_square_orders
FROM delivery_orders d
WHERE square_order_id IS NOT NULL
AND EXISTS (
    SELECT 1 FROM delivery_orders d2
    WHERE d2.square_order_id = d.square_order_id
    AND d2.merchant_id = d.merchant_id
    AND d2.id != d.id
    AND d2.created_at < d.created_at
);

-- Step 3: Delete duplicates (keep earliest per square_order_id + merchant_id)
\echo '=== DELETING DUPLICATES ==='
WITH duplicates AS (
    SELECT id
    FROM delivery_orders d
    WHERE square_order_id IS NOT NULL
    AND EXISTS (
        SELECT 1 FROM delivery_orders d2
        WHERE d2.square_order_id = d.square_order_id
        AND d2.merchant_id = d.merchant_id
        AND d2.id != d.id
        AND d2.created_at < d.created_at
    )
)
DELETE FROM delivery_orders
WHERE id IN (SELECT id FROM duplicates)
RETURNING id, merchant_id, square_order_id, customer_name, status, created_at;

\echo '=== CLEANUP COMPLETE ==='
-- Verify no duplicates remain
SELECT
    square_order_id,
    merchant_id,
    COUNT(*) AS row_count
FROM delivery_orders
WHERE square_order_id IS NOT NULL
GROUP BY square_order_id, merchant_id
HAVING COUNT(*) > 1;

COMMIT;
