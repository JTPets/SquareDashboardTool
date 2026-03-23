-- Migration 008: Backfill NULL check_type in catalog_location_health
--
-- Rows inserted by location-health-service before check_type was added
-- explicitly to the INSERT statement may have check_type = NULL if the
-- column DEFAULT was not applied (e.g. rows predating migration 070).
-- Without this, enableItemAtAllLocations cannot resolve them because its
-- UPDATE filters on check_type = 'location_mismatch'.
--
-- Migration 070 added NOT NULL DEFAULT 'location_mismatch', which handles
-- new rows going forward. This is a safety net for any surviving NULL rows.
BEGIN;

UPDATE catalog_location_health
SET check_type = 'location_mismatch'
WHERE check_type IS NULL AND status = 'mismatch';

COMMIT;
