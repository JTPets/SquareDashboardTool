-- Migration 050: Fix label template ZPL field positioning
-- Product name field (^FB520) exceeded physical label width causing text truncation.
-- Barcode position (x=280) overflowed right edge on Standard labels.
-- Fix: Constrain fields to actual label bounds, allow 2-line name wrapping.
-- NOTE: Do NOT use ^PW/^LL — they cause rotation on some printers.
-- Let the printer auto-detect media size from calibration.
--
-- Reference dimensions at 203 DPI:
--   Standard 57x32mm = ~456x256 dots
--   Large 102x51mm   = ~816x408 dots
--   Small 32x25mm    = ~256x200 dots

-- Fix Standard template (57x32mm)
-- Stacked layout: name (2-line), variation, price, barcode below price
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^FO15,5^A0N,22,22^FB426,2,0,L^FD{{itemName}}^FS
^FO15,53^A0N,16,16^FB300,1,0,L^FD{{variationName}}^FS
^FO15,74^A0N,48,48^FD${{price}}^FS
^FO15,130^BY2^BCN,50,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Standard Price Tag%';

-- Fix Large template (102x51mm)
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^FO20,15^A0N,34,34^FB776,2,0,L^FD{{itemName}}^FS
^FO20,88^A0N,26,26^FB400,1,0,L^FD{{variationName}}^FS
^FO20,130^A0N,60,60^FD${{price}}^FS
^FO20,205^A0N,20,20^FDSKU: {{sku}}^FS
^FO460,120^BY2^BCN,80,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Large Price Tag%';

-- Fix Small template (32x25mm)
UPDATE label_templates
SET template_zpl = '^XA
^CI28
^FO8,8^A0N,20,20^FB240,2,0,L^FD{{itemName}}^FS
^FO8,56^A0N,34,34^FD${{price}}^FS
^FO130,52^BY1^BCN,38,Y,N,N^FD{{barcode}}^FS
^XZ',
    updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'Small Price Tag%';
