#!/bin/bash
# Load .env file
set -a
source .env
set +a

# Run the migration
PGPASSWORD="$DB_PASSWORD" psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -d "${DB_NAME:-square_dashboard_addon}" << 'SQL'
-- Add merchant_id column if it doesn't exist
ALTER TABLE gmc_feed_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_gmc_feed_history_merchant ON gmc_feed_history(merchant_id, generated_at DESC);

-- Verify the column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'gmc_feed_history' AND column_name = 'merchant_id';
SQL

echo "Migration complete!"
