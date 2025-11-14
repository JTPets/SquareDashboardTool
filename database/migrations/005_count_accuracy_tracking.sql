-- Migration: Add accuracy tracking to cycle counts
-- Tracks actual counted quantities and variances

-- Add columns to count_history for accuracy tracking
ALTER TABLE count_history
ADD COLUMN IF NOT EXISTS is_accurate BOOLEAN DEFAULT NULL,
ADD COLUMN IF NOT EXISTS actual_quantity INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS expected_quantity INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS variance INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;

-- Create index for variance queries
CREATE INDEX IF NOT EXISTS idx_count_history_accuracy ON count_history(is_accurate) WHERE is_accurate = FALSE;

-- Comments
COMMENT ON COLUMN count_history.is_accurate IS 'Whether the physical count matched the system count';
COMMENT ON COLUMN count_history.actual_quantity IS 'The actual physical count performed by staff';
COMMENT ON COLUMN count_history.expected_quantity IS 'The system inventory count at time of cycle count';
COMMENT ON COLUMN count_history.variance IS 'Difference between actual and expected (actual - expected)';
COMMENT ON COLUMN count_history.notes IS 'Staff notes about discrepancies or issues';
