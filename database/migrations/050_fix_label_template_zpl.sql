-- Migration 050: Fix label template ZPL positioning
-- Templates were missing ^PW/^LL (print width/label length) commands,
-- and field positions exceeded the physical label dimensions, causing
-- text truncation and barcode overflow past label edges.
--
-- Dimensions at 203 DPI:
--   Standard 57x32mm = 456x256 dots
--   Large 102x51mm   = 816x408 dots
--   Small 32x25mm    = 256x200 dots

-- Fix Standard template (57x32mm = 456x256 dots)
-- Layout: 2-line product name (full width), variation, price left, barcode right
-- Was: ^FB520 exceeded label, barcode at x=280 overflowed right edge
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^PW456
^LL256
^FO15,8^A0N,24,24^FB426,2,0,L^FD{{itemName}}^FS
^FO15,62^A0N,18,18^FB200,1,0,L^FD{{variationName}}^FS
^FO15,88^A0N,48,48^FD${{price}}^FS
^FO240,82^BY2^BCN,55,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Standard Price Tag%';

-- Fix Large template (102x51mm = 816x408 dots)
-- Was: missing ^PW/^LL, positions mostly OK but add explicit dimensions
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^PW816
^LL408
^FO20,15^A0N,34,34^FB776,2,0,L^FD{{itemName}}^FS
^FO20,88^A0N,26,26^FB400,1,0,L^FD{{variationName}}^FS
^FO20,130^A0N,60,60^FD${{price}}^FS
^FO20,205^A0N,20,20^FDSKU: {{sku}}^FS
^FO460,120^BY2^BCN,80,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Large Price Tag%';

-- Fix Small template (32x25mm = 256x200 dots)
-- Compact: 1-line name, price left, barcode right
-- Was: missing ^PW/^LL
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^PW256
^LL200
^FO8,8^A0N,20,20^FB240,2,0,L^FD{{itemName}}^FS
^FO8,56^A0N,34,34^FD${{price}}^FS
^FO130,52^BY1^BCN,38,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Small Price Tag%';
