-- Migration 035: Add contact fields to locations table
--
-- PROBLEM: The merchants.business_email field was incorrectly storing Square location IDs
-- instead of actual email addresses (bug in OAuth callback).
--
-- SOLUTION:
-- 1. Add phone_number and business_email columns to locations table (Square provides these per-location)
-- 2. Clear incorrect business_email values in merchants table that contain location IDs
-- 3. Going forward, vendor receipts will fetch contact info from Square APIs at generation time
--
-- Square API data sources:
-- - Merchants API: businessName (stored in merchants.business_name)
-- - Locations API: name, address, phoneNumber, businessEmail (stored in locations table)

-- Add contact fields to locations table
ALTER TABLE locations
ADD COLUMN IF NOT EXISTS phone_number TEXT,
ADD COLUMN IF NOT EXISTS business_email TEXT;

-- Clear merchants.business_email where it contains a Square location ID (starts with 'L')
-- These were incorrectly stored during OAuth and should be NULL
UPDATE merchants
SET business_email = NULL
WHERE business_email IS NOT NULL
  AND business_email ~ '^L[A-Z0-9]+$';

-- Add helpful comments
COMMENT ON COLUMN locations.phone_number IS 'Location phone number from Square Locations API';
COMMENT ON COLUMN locations.business_email IS 'Business email for this location from Square Locations API';
