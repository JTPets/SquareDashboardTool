-- Migration 068: Add locale column to merchants table for OSS multi-tenant locale support
-- Defaults match the .ca domain (Canada/Toronto timezone, CAD currency, en-CA locale)

-- Add locale column for per-merchant display locale
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT 'en-CA';

COMMENT ON COLUMN merchants.locale IS 'Display locale for date/number formatting (e.g. en-CA, en-US, fr-CA)';

-- Update merchants.timezone default from America/New_York to America/Toronto
ALTER TABLE merchants ALTER COLUMN timezone SET DEFAULT 'America/Toronto';

-- Update merchants.currency default from USD to CAD
ALTER TABLE merchants ALTER COLUMN currency SET DEFAULT 'CAD';
