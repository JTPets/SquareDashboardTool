-- Migration 049: Invoice-driven committed inventory tracking (BACKLOG-10)
--
-- Replaces the full-resync approach (DELETE all + rebuild from Square API)
-- with per-invoice incremental tracking via webhooks.
--
-- Previously, every order webhook triggered a full resync of all open invoices
-- (~11 API calls per sync, ~100-200 API calls/day).
-- Now, invoice webhooks update this table incrementally (1 API call per invoice change).
-- A daily 4 AM reconciliation job runs the full resync as a safety net.

BEGIN;

CREATE TABLE IF NOT EXISTS committed_inventory (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    square_invoice_id TEXT NOT NULL,
    square_order_id TEXT,
    catalog_object_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    invoice_status TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, square_invoice_id, catalog_object_id, location_id)
);

CREATE INDEX idx_committed_inv_merchant ON committed_inventory(merchant_id);
CREATE INDEX idx_committed_inv_status ON committed_inventory(merchant_id, invoice_status);
CREATE INDEX idx_committed_inv_variation ON committed_inventory(merchant_id, catalog_object_id);

COMMIT;
