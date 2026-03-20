-- Migration 046: Label Templates
-- Stores ZPL label templates per merchant with support for multiple label sizes
-- Used by Zebra Browser Print integration for printing price/product labels

-- Label templates table
CREATE TABLE IF NOT EXISTS label_templates (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    label_width_mm INTEGER NOT NULL,
    label_height_mm INTEGER NOT NULL,
    dpi INTEGER NOT NULL DEFAULT 203,
    template_zpl TEXT NOT NULL,
    fields JSONB NOT NULL DEFAULT '[]',
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_label_templates_merchant_id ON label_templates(merchant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_label_templates_merchant_default ON label_templates(merchant_id) WHERE is_default = true;

-- Ensure only one default template per merchant
-- (handled by unique partial index above)

-- Insert system-default templates for all existing merchants
-- These use {{placeholder}} syntax for field substitution
INSERT INTO label_templates (merchant_id, name, description, label_width_mm, label_height_mm, dpi, template_zpl, fields, is_default)
SELECT
    m.id,
    'Standard Price Tag (2.25" x 1.25")',
    'Standard shelf label with product name, variation, price, and barcode',
    57,
    32,
    203,
    '^XA
^CI28
^FO20,15^A0N,28,28^FB520,1,0,L^FD{{itemName}}^FS
^FO20,48^A0N,22,22^FB520,1,0,L^FD{{variationName}}^FS
^FO20,80^A0N,42,42^FD${{price}}^FS
^FO280,75^BY2^BCN,50,Y,N,N^FD{{barcode}}^FS
^XZ',
    '[{"key":"itemName","label":"Product Name","source":"item_name"},{"key":"variationName","label":"Variation","source":"variation_name"},{"key":"price","label":"Price","source":"price_display"},{"key":"barcode","label":"UPC/SKU","source":"barcode"}]'::jsonb,
    true
FROM merchants m
ON CONFLICT DO NOTHING;

-- Also insert a large-format template
INSERT INTO label_templates (merchant_id, name, description, label_width_mm, label_height_mm, dpi, template_zpl, fields, is_default)
SELECT
    m.id,
    'Large Price Tag (4" x 2")',
    'Large shelf label with product name, variation, price, SKU, and barcode',
    102,
    51,
    203,
    '^XA
^CI28
^FO30,20^A0N,36,36^FB750,1,0,L^FD{{itemName}}^FS
^FO30,62^A0N,28,28^FB750,1,0,L^FD{{variationName}}^FS
^FO30,105^A0N,56,56^FD${{price}}^FS
^FO30,170^A0N,20,20^FDSKU: {{sku}}^FS
^FO400,95^BY2^BCN,70,Y,N,N^FD{{barcode}}^FS
^XZ',
    '[{"key":"itemName","label":"Product Name","source":"item_name"},{"key":"variationName","label":"Variation","source":"variation_name"},{"key":"price","label":"Price","source":"price_display"},{"key":"sku","label":"SKU","source":"sku"},{"key":"barcode","label":"UPC/SKU","source":"barcode"}]'::jsonb,
    false
FROM merchants m
ON CONFLICT DO NOTHING;

-- Small format template for narrow rolls
INSERT INTO label_templates (merchant_id, name, description, label_width_mm, label_height_mm, dpi, template_zpl, fields, is_default)
SELECT
    m.id,
    'Small Price Tag (1.25" x 1")',
    'Compact label with product name, price, and barcode',
    32,
    25,
    203,
    '^XA
^CI28
^FO10,8^A0N,20,20^FB230,1,0,L^FD{{itemName}}^FS
^FO10,32^A0N,30,30^FD${{price}}^FS
^FO130,28^BY1^BCN,35,N,N,N^FD{{barcode}}^FS
^XZ',
    '[{"key":"itemName","label":"Product Name","source":"item_name"},{"key":"price","label":"Price","source":"price_display"},{"key":"barcode","label":"UPC/SKU","source":"barcode"}]'::jsonb,
    false
FROM merchants m
ON CONFLICT DO NOTHING;
