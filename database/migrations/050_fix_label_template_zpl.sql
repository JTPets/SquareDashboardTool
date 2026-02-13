-- Migration 050: Fix label template ZPL positioning
-- Templates were missing ^PW/^LL (print width/label length) commands,
-- and field positions exceeded the physical label dimensions, causing
-- text truncation and barcode overflow past label edges.
--
-- Dimensions at 203 DPI:
--   Standard 57x32mm = 456x256 dots
--   Large 102x51mm   = 816x408 dots
--   Small 32x25mm    = 256x200 dots

-- Fix Standard template (57x32mm)
-- Was: ^FB520 (wider than 456-dot label), barcode at x=280 overflowed
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^PW456
^LL256
^FO15,12^A0N,26,26^FB220,1,0,L^FD{{itemName}}^FS
^FO15,42^A0N,20,20^FB220,1,0,L^FD{{variationName}}^FS
^FO15,75^A0N,50,50^FD${{price}}^FS
^FO235,10^BY2^BCN,55,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Standard Price Tag%';

-- Fix Large template (102x51mm)
-- Was: missing ^PW/^LL, barcode position OK but add explicit dimensions
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^PW816
^LL408
^FO20,15^A0N,34,34^FB500,1,0,L^FD{{itemName}}^FS
^FO20,55^A0N,26,26^FB500,1,0,L^FD{{variationName}}^FS
^FO20,100^A0N,60,60^FD${{price}}^FS
^FO20,175^A0N,20,20^FDSKU: {{sku}}^FS
^FO480,90^BY2^BCN,80,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Large Price Tag%';

-- Fix Small template (32x25mm)
-- Was: missing ^PW/^LL, barcode at x=130 barely fit
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^PW256
^LL200
^FO8,8^A0N,20,20^FB240,1,0,L^FD{{itemName}}^FS
^FO8,34^A0N,34,34^FD${{price}}^FS
^FO130,30^BY1^BCN,38,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Small Price Tag%';
