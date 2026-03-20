-- ========================================
-- MIGRATION: Delivery Scheduler Component
-- ========================================
-- This migration adds tables for the delivery scheduling system including:
-- - delivery_orders: Orders ready for delivery (from Square or manual)
-- - delivery_pod: Proof of delivery photos
-- - delivery_settings: Per-merchant delivery configuration
-- - delivery_routes: Route history for auditing
--
-- Usage: psql -d your_database -f 008_delivery_scheduler.sql

BEGIN;

-- ----------------------------------------
-- 1. delivery_orders - Delivery order queue
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS delivery_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    square_order_id VARCHAR(255),  -- null for manual orders
    customer_name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    address_lat DECIMAL(10, 8),  -- geocoded latitude
    address_lng DECIMAL(11, 8),  -- geocoded longitude
    geocoded_at TIMESTAMPTZ,     -- null = needs geocoding
    phone VARCHAR(50),
    notes TEXT,
    status VARCHAR(50) DEFAULT 'pending' CHECK (
        status IN ('pending', 'active', 'skipped', 'delivered', 'completed')
    ),
    route_id UUID,               -- reference to delivery_routes
    route_position INTEGER,      -- sequence in generated route
    route_date DATE,
    square_synced_at TIMESTAMPTZ,  -- when synced to Square as completed
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient merchant-filtered queries
CREATE INDEX IF NOT EXISTS idx_delivery_orders_merchant_status
    ON delivery_orders(merchant_id, status);

-- Index for route date queries
CREATE INDEX IF NOT EXISTS idx_delivery_orders_route_date
    ON delivery_orders(merchant_id, route_date);

-- Index for Square order lookups (deduplication)
CREATE INDEX IF NOT EXISTS idx_delivery_orders_square_order
    ON delivery_orders(merchant_id, square_order_id)
    WHERE square_order_id IS NOT NULL;

-- Index for pending orders needing geocoding
CREATE INDEX IF NOT EXISTS idx_delivery_orders_needs_geocoding
    ON delivery_orders(merchant_id, geocoded_at)
    WHERE geocoded_at IS NULL;

COMMENT ON TABLE delivery_orders IS 'Delivery order queue with status tracking and route assignment';
COMMENT ON COLUMN delivery_orders.status IS 'pending=ready for route, active=on current route, skipped=driver skipped, delivered=POD captured, completed=synced to Square';

-- ----------------------------------------
-- 2. delivery_pod - Proof of Delivery photos
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS delivery_pod (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_order_id UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
    photo_path TEXT NOT NULL,       -- relative path to storage
    original_filename VARCHAR(255),
    file_size_bytes INTEGER,
    mime_type VARCHAR(100),
    captured_at TIMESTAMPTZ DEFAULT NOW(),
    latitude DECIMAL(10, 8),        -- GPS coords if available
    longitude DECIMAL(11, 8),
    expires_at TIMESTAMPTZ,         -- for auto-purge based on retention setting
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for order lookups
CREATE INDEX IF NOT EXISTS idx_delivery_pod_order
    ON delivery_pod(delivery_order_id);

-- Index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_delivery_pod_expires
    ON delivery_pod(expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON TABLE delivery_pod IS 'Proof of delivery photos with GPS metadata and retention tracking';

-- ----------------------------------------
-- 3. delivery_settings - Per-merchant configuration
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS delivery_settings (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    start_address TEXT,
    start_address_lat DECIMAL(10, 8),
    start_address_lng DECIMAL(11, 8),
    end_address TEXT,
    end_address_lat DECIMAL(10, 8),
    end_address_lng DECIMAL(11, 8),
    same_day_cutoff TIME DEFAULT '17:00',
    pod_retention_days INTEGER DEFAULT 180,
    auto_ingest_ready_orders BOOLEAN DEFAULT TRUE,
    openrouteservice_api_key TEXT,  -- optional, uses default if null
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT delivery_settings_merchant_unique UNIQUE(merchant_id)
);

COMMENT ON TABLE delivery_settings IS 'Per-merchant delivery scheduler configuration';
COMMENT ON COLUMN delivery_settings.same_day_cutoff IS 'Orders marked ready after this time go to next day';
COMMENT ON COLUMN delivery_settings.auto_ingest_ready_orders IS 'Automatically ingest Square orders when status = ready';

-- ----------------------------------------
-- 4. delivery_routes - Route history for auditing
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS delivery_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    route_date DATE NOT NULL,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generated_by INTEGER REFERENCES users(id),  -- user who generated the route
    total_stops INTEGER NOT NULL DEFAULT 0,
    total_distance_km DECIMAL(10, 2),
    estimated_duration_min INTEGER,
    started_at TIMESTAMPTZ,        -- when driver started route
    finished_at TIMESTAMPTZ,       -- when route was marked finished
    status VARCHAR(50) DEFAULT 'active' CHECK (
        status IN ('active', 'finished', 'cancelled')
    ),
    route_geometry TEXT,           -- GeoJSON from routing API (optional)
    waypoint_order TEXT[],         -- ordered array of delivery_order IDs
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for merchant route lookups
CREATE INDEX IF NOT EXISTS idx_delivery_routes_merchant_date
    ON delivery_routes(merchant_id, route_date);

-- Index for active route queries
CREATE INDEX IF NOT EXISTS idx_delivery_routes_active
    ON delivery_routes(merchant_id, status)
    WHERE status = 'active';

COMMENT ON TABLE delivery_routes IS 'Route generation history with optimization metrics';

-- ----------------------------------------
-- 5. delivery_audit_log - Audit trail for key actions
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS delivery_audit_log (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,  -- route_generated, order_completed, order_skipped, etc.
    delivery_order_id UUID REFERENCES delivery_orders(id) ON DELETE SET NULL,
    route_id UUID REFERENCES delivery_routes(id) ON DELETE SET NULL,
    details JSONB,                 -- additional context
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for merchant audit queries
CREATE INDEX IF NOT EXISTS idx_delivery_audit_merchant
    ON delivery_audit_log(merchant_id, created_at DESC);

COMMENT ON TABLE delivery_audit_log IS 'Audit trail for delivery-related actions';

-- ----------------------------------------
-- 6. Add foreign key for route_id in delivery_orders
-- ----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'delivery_orders_route_id_fkey'
    ) THEN
        ALTER TABLE delivery_orders
        ADD CONSTRAINT delivery_orders_route_id_fkey
        FOREIGN KEY (route_id) REFERENCES delivery_routes(id) ON DELETE SET NULL;
        RAISE NOTICE 'Added route_id foreign key constraint';
    END IF;
END $$;

-- ----------------------------------------
-- 7. Create function for updating updated_at timestamp
-- ----------------------------------------
CREATE OR REPLACE FUNCTION update_delivery_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for delivery_orders
DROP TRIGGER IF EXISTS delivery_orders_updated_at ON delivery_orders;
CREATE TRIGGER delivery_orders_updated_at
    BEFORE UPDATE ON delivery_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_delivery_orders_updated_at();

-- Create trigger for delivery_settings
DROP TRIGGER IF EXISTS delivery_settings_updated_at ON delivery_settings;
CREATE TRIGGER delivery_settings_updated_at
    BEFORE UPDATE ON delivery_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_delivery_orders_updated_at();

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Delivery Scheduler migration completed successfully!';
    RAISE NOTICE 'Created tables: delivery_orders, delivery_pod, delivery_settings, delivery_routes, delivery_audit_log';
END $$;

COMMIT;
