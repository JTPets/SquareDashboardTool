-- Migration 051: Add vendor dashboard fields
-- Adds scheduling, ordering, and contact columns to the vendors table
-- for the vendor dashboard feature.
--
-- Note: lead_time_days, default_supply_days, minimum_order_amount, payment_terms, notes
-- already exist but are unpopulated. contact_email also already exists.
-- We only add the truly new columns here.

-- Schedule type: 'fixed' (specific day each week) or 'anytime' (order whenever)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(10) DEFAULT 'anytime' CHECK (schedule_type IN ('fixed', 'anytime'));

-- Day of the week to place the order (used when schedule_type = 'fixed')
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS order_day VARCHAR(10);

-- Day of the week delivery is expected (used when schedule_type = 'fixed')
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS receive_day VARCHAR(10);

-- How the vendor is paid
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);

-- How orders are placed with this vendor
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS order_method VARCHAR(50);
