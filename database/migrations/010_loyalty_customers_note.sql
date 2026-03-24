-- Migration 010: Add note column to loyalty_customers
-- Stores the persistent Square customer profile note for driver reference.
-- This is the merchant-managed note on the Square customer record (customer.note).
-- Distinct from delivery_orders.customer_note (per-order delivery instructions).

BEGIN;

ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS note TEXT;

COMMENT ON COLUMN loyalty_customers.note IS 'Persistent Square customer profile note (customer.note) - merchant-managed, e.g. delivery preferences or special instructions';

COMMIT;
