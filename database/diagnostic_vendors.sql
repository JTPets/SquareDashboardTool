-- Diagnostic script for vendors/reorder issue
-- Run this against your production database to identify the problem

-- 1. Check if merchant_id column exists on vendors table
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'vendors';

-- 2. Check all merchants in the system
SELECT id, business_name, square_merchant_id, is_active, subscription_status
FROM merchants
ORDER BY id;

-- 3. Check vendors and their merchant_id assignment
SELECT id, name, status, merchant_id
FROM vendors
ORDER BY merchant_id NULLS FIRST, name
LIMIT 20;

-- 4. Count vendors per merchant (including NULL)
SELECT
    COALESCE(merchant_id::text, 'NULL') as merchant_id,
    COUNT(*) as vendor_count
FROM vendors
GROUP BY merchant_id
ORDER BY merchant_id;

-- 5. Check user-merchant associations for diagnosing login issues
SELECT
    u.id as user_id,
    u.email,
    um.merchant_id,
    um.role as user_role,
    m.business_name,
    m.square_merchant_id
FROM users u
LEFT JOIN user_merchants um ON u.id = um.user_id
LEFT JOIN merchants m ON um.merchant_id = m.id
ORDER BY u.id;

-- 6. Check if the items query would work (sample)
SELECT
    v.id as variation_id,
    i.name as item_name,
    v.merchant_id as variation_merchant_id,
    vv.merchant_id as variation_vendor_merchant_id,
    ve.id as vendor_id,
    ve.name as vendor_name,
    ve.merchant_id as vendor_merchant_id
FROM variations v
JOIN items i ON v.item_id = i.id
LEFT JOIN variation_vendors vv ON v.id = vv.variation_id
LEFT JOIN vendors ve ON vv.vendor_id = ve.id
WHERE v.discontinued = FALSE
LIMIT 10;
