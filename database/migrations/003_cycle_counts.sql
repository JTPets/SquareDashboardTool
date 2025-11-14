-- Cycle Count System Migration
-- Tracks cycle counting history and priority queues

-- Table to track when each item was last counted
CREATE TABLE IF NOT EXISTS count_history (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL UNIQUE,
    last_counted_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counted_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_count_history_catalog_id ON count_history(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_history_last_counted ON count_history(last_counted_date DESC);

-- Table for priority queue ("Send Now" items)
CREATE TABLE IF NOT EXISTS count_queue_priority (
    id SERIAL PRIMARY KEY,
    catalog_object_id TEXT NOT NULL,
    added_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_by TEXT,
    notes TEXT,
    completed BOOLEAN DEFAULT FALSE,
    completed_date TIMESTAMP,
    FOREIGN KEY (catalog_object_id) REFERENCES variations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_count_queue_catalog_id ON count_queue_priority(catalog_object_id);
CREATE INDEX IF NOT EXISTS idx_count_queue_completed ON count_queue_priority(completed) WHERE completed = FALSE;

-- Table to track count sessions for reporting
CREATE TABLE IF NOT EXISTS count_sessions (
    id SERIAL PRIMARY KEY,
    session_date DATE NOT NULL DEFAULT CURRENT_DATE,
    items_expected INTEGER NOT NULL DEFAULT 0,
    items_completed INTEGER NOT NULL DEFAULT 0,
    completion_rate DECIMAL(5,2),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_count_sessions_date ON count_sessions(session_date DESC);

-- Comments for documentation
COMMENT ON TABLE count_history IS 'Tracks when each variation was last cycle counted';
COMMENT ON TABLE count_queue_priority IS 'Priority queue for immediate cycle count requests (Send Now)';
COMMENT ON TABLE count_sessions IS 'Tracks daily cycle count sessions and completion rates';

COMMENT ON COLUMN count_history.catalog_object_id IS 'Reference to variations.id';
COMMENT ON COLUMN count_history.last_counted_date IS 'Timestamp when item was last counted';
COMMENT ON COLUMN count_history.counted_by IS 'User/system that performed the count';

COMMENT ON COLUMN count_queue_priority.catalog_object_id IS 'Reference to variations.id for priority counting';
COMMENT ON COLUMN count_queue_priority.added_by IS 'User who requested priority count';
COMMENT ON COLUMN count_queue_priority.completed IS 'Whether this priority item has been counted';

COMMENT ON COLUMN count_sessions.items_expected IS 'Number of items expected to be counted';
COMMENT ON COLUMN count_sessions.items_completed IS 'Number of items actually counted';
COMMENT ON COLUMN count_sessions.completion_rate IS 'Percentage of expected items completed';
