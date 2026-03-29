BEGIN;

ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS start_lat DOUBLE PRECISION;
ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS start_lng DOUBLE PRECISION;
ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS end_lat DOUBLE PRECISION;
ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS end_lng DOUBLE PRECISION;

COMMENT ON COLUMN delivery_routes.start_lat IS 'Route start latitude override — NULL means use merchant default from delivery_settings';
COMMENT ON COLUMN delivery_routes.end_lat IS 'Route end latitude override — NULL means use merchant default from delivery_settings';

COMMIT;
