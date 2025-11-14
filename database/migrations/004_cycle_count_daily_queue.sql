-- Migration: Add daily batch queue for cycle counts
-- This table tracks items added to daily batches to ensure accumulation if previous batches incomplete

CREATE TABLE IF NOT EXISTS count_queue_daily (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    batch_date DATE NOT NULL DEFAULT CURRENT_DATE,
    added_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed BOOLEAN DEFAULT FALSE,
    completed_date TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE,
    UNIQUE(catalog_object_id, batch_date)
);

CREATE INDEX IF NOT EXISTS idx_count_queue_daily_catalog_id ON count_queue_daily(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_batch_date ON count_queue_daily(batch_date DESC);
CREATE INDEX IF NOT EXISTS idx_count_queue_daily_completed ON count_queue_daily(completed) WHERE completed = FALSE;

COMMENT ON TABLE count_queue_daily IS 'Daily batch queue for cycle counts - accumulates uncompleted items across days';
COMMENT ON COLUMN count_queue_daily.batch_date IS 'The date this item was added to the batch';
COMMENT ON COLUMN count_queue_daily.completed IS 'Whether this item has been counted';
