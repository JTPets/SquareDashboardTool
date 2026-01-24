/**
 * Vendor Catalog Import Module
 * Handles importing vendor product catalogs from CSV/XLSX files
 * for rapid lookup and margin/price tracking
 */

const ExcelJS = require('exceljs');
const db = require('./database');
const logger = require('./logger');
const crypto = require('crypto');

/**
 * Generate a unique batch ID for an import
 * @returns {string} Unique batch ID
 */
function generateBatchId() {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const random = crypto.randomBytes(4).toString('hex');
    return `IMPORT-${timestamp}-${random}`;
}

/**
 * Parse a money string to cents
 * Handles formats: "$10.99", "10.99", "10,99", "$1,234.56"
 * @param {string|number} value - Money value to parse
 * @returns {number|null} Value in cents, or null if invalid
 */
function parseMoney(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    // If already a number, assume it's in dollars and convert to cents
    if (typeof value === 'number') {
        return Math.round(value * 100);
    }

    // Clean string: remove $, spaces, and handle comma as thousands separator
    let cleaned = String(value).trim()
        .replace(/[$\s]/g, '')
        .replace(/,(\d{3})/g, '$1'); // Remove commas used as thousands separator

    // Handle comma as decimal separator (European format)
    if (/^\d+,\d{2}$/.test(cleaned)) {
        cleaned = cleaned.replace(',', '.');
    }

    const num = parseFloat(cleaned);
    if (isNaN(num)) {
        return null;
    }

    return Math.round(num * 100);
}

/**
 * Clean and normalize a UPC/GTIN value
 * @param {string|number} value - UPC value
 * @returns {string|null} Cleaned UPC or null
 */
function cleanUPC(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    // Convert to string and remove any non-digit characters
    const cleaned = String(value).replace(/\D/g, '');

    // UPCs are typically 8, 12, 13, or 14 digits
    if (cleaned.length >= 8 && cleaned.length <= 14) {
        return cleaned;
    }

    // Return the cleaned value even if length is unusual
    return cleaned || null;
}

/**
 * Calculate margin percentage
 * @param {number} costCents - Cost in cents
 * @param {number} priceCents - Price in cents
 * @returns {number|null} Margin percentage or null
 */
function calculateMargin(costCents, priceCents) {
    if (!priceCents || priceCents <= 0 || !costCents) {
        return null;
    }
    const margin = ((priceCents - costCents) / priceCents) * 100;
    // Cap to DECIMAL(5,2) range (-999.99 to 999.99) to prevent database overflow
    // Values outside this range indicate data errors (e.g., cost > price)
    return Math.max(-999.99, Math.min(999.99, margin));
}

/**
 * Normalize column headers to standard format
 * Maps various common header names to our standard fields
 * @param {string} header - Original header name
 * @returns {string|null} Normalized field name or null if unknown
 */
function normalizeHeader(header) {
    if (!header) return null;

    const normalized = String(header).toLowerCase().trim().replace(/[.\s]+/g, ' ').trim();

    // Vendor name mappings
    if (['vendor', 'vendor_name', 'vendor name', 'supplier', 'supplier_name'].includes(normalized)) {
        return 'vendor_name';
    }

    // Brand mappings (can be used as vendor name if vendor not specified)
    if (['brand', 'brand name', 'manufacturer', 'mfg', 'mfr'].includes(normalized)) {
        return 'brand';
    }

    // Product name mappings
    if (['name', 'product_name', 'product name', 'item_name', 'item name', 'description',
         'item description', 'product description', 'item', 'product', 'title',
         'english description', 'eng description', 'product title', 'item title'].includes(normalized)) {
        return 'product_name';
    }

    // UPC/GTIN mappings
    if (['upc', 'gtin', 'barcode', 'upc/gtin', 'ean', 'upc_code', 'gtin_code', 'upc code',
         'upc number', 'barcode number', 'gtin number'].includes(normalized)) {
        return 'upc';
    }

    // Vendor item number mappings
    if (['vendor_item_number', 'vendor item number', 'vendor_sku', 'vendor sku', 'part_number',
         'part number', 'item_number', 'item number', 'sku', 'vendor_code', 'vendor code',
         'item#', 'item #', 'part#', 'part #', 'catalog_number', 'catalog number',
         'product number', 'product_number', 'model', 'model number', 'model_number',
         'item no', 'item no.', 'part no', 'part no.', 'catalog no', 'catalog no.',
         'code', 'item code', 'item_code', 'product code', 'product_code'].includes(normalized)) {
        return 'vendor_item_number';
    }

    // Cost mappings (in B2B vendor catalogs, "price" typically means wholesale cost to retailer)
    // net price = actual cost after discounts, LIST = dealer list price
    if (['cost', 'unit_cost', 'unit cost', 'wholesale', 'wholesale_price', 'wholesale price',
         'our_cost', 'our cost', 'dealer_cost', 'dealer cost', 'cost_price', 'cost price',
         'buy_price', 'buy price', 'net_price', 'net price', 'net cost', 'net',
         'your cost', 'your price', 'dealer price', 'distributor cost', 'dist cost',
         'list', 'dealer list', 'dealer list price', 'price', 'new price', 'new_price'].includes(normalized)) {
        return 'cost';
    }

    // Price mappings (SRP = Suggested Retail Price, for end consumer pricing)
    if (['retail', 'retail_price', 'retail price', 'msrp', 'list price', 'list_price',
         'sell_price', 'sell price', 'suggested_retail', 'suggested retail', 'srp', 's r p',
         'suggested retail price', 'retail value', 'map', 'map price', 'sale price',
         'customer price', 'resale', 'resale price'].includes(normalized)) {
        return 'price';
    }

    return null;
}

/**
 * Parse CSV content into rows
 * @param {string} content - CSV file content
 * @returns {Array<Object>} Array of row objects with headers as keys
 */
function parseCSV(content) {
    const lines = content.split(/\r?\n/);
    if (lines.length < 2) {
        throw new Error('CSV file must have at least a header row and one data row');
    }

    // Parse header row
    const headers = parseCSVLine(lines[0]);
    const rows = [];

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue; // Skip empty lines

        const values = parseCSVLine(line);
        const row = {};

        headers.forEach((header, idx) => {
            row[header] = values[idx] !== undefined ? values[idx] : '';
        });

        rows.push(row);
    }

    return { headers, rows };
}

/**
 * Parse a single CSV line handling quoted fields
 * @param {string} line - CSV line
 * @returns {Array<string>} Array of field values
 */
function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (inQuotes) {
            if (char === '"' && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++;
            } else if (char === '"') {
                // End of quoted field
                inQuotes = false;
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                // Start of quoted field
                inQuotes = true;
            } else if (char === ',') {
                // Field separator
                fields.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
    }

    // Add last field
    fields.push(current.trim());

    return fields;
}

/**
 * Parse XLSX file content
 * @param {Buffer} buffer - XLSX file buffer
 * @returns {Promise<Object>} Headers and rows
 */
async function parseXLSX(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    // Get first worksheet
    const worksheet = workbook.worksheets[0];
    if (!worksheet || worksheet.rowCount < 2) {
        throw new Error('XLSX file must have at least a header row and one data row');
    }

    // Get headers from first row
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = cell.text || cell.value || `Column${colNumber}`;
    });

    // Parse data rows
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header

        const rowData = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const header = headers[colNumber - 1];
            if (header) {
                // Handle different cell types
                let value = cell.value;
                if (cell.type === ExcelJS.ValueType.RichText && cell.value?.richText) {
                    value = cell.value.richText.map(rt => rt.text).join('');
                } else if (cell.type === ExcelJS.ValueType.Formula) {
                    value = cell.result;
                }
                rowData[header] = value;
            }
        });

        rows.push(rowData);
    });

    return { headers, rows };
}

/**
 * Validate and transform imported data
 * @param {Array<Object>} rows - Raw data rows
 * @param {Array<string>} headers - Column headers
 * @param {string} defaultVendorName - Optional default vendor name for files without vendor column
 * @returns {Object} Validation result with items and errors
 */
function validateAndTransform(rows, headers, defaultVendorName = null) {
    // Map headers to our standard fields
    const fieldMap = {};
    headers.forEach(header => {
        const normalized = normalizeHeader(header);
        if (normalized) {
            fieldMap[header] = normalized;
        }
    });

    // Check required fields - brand can substitute for vendor_name
    const mappedFields = Object.values(fieldMap);
    const hasVendorOrBrand = mappedFields.includes('vendor_name') || mappedFields.includes('brand') || defaultVendorName;

    // Adjusted required fields - vendor can come from brand or default
    const requiredFields = ['product_name', 'vendor_item_number', 'cost'];
    const missingRequired = requiredFields.filter(f => !mappedFields.includes(f));

    if (!hasVendorOrBrand) {
        missingRequired.unshift('vendor_name (or brand)');
    }

    if (missingRequired.length > 0) {
        return {
            valid: false,
            error: `Missing required columns: ${missingRequired.join(', ')}. ` +
                   `Found columns: ${headers.join(', ')}. ` +
                   `Recognized: ${Object.entries(fieldMap).map(([k, v]) => `${k} → ${v}`).join(', ')}`,
            items: [],
            errors: []
        };
    }

    const items = [];
    const errors = [];

    rows.forEach((row, index) => {
        const rowNum = index + 2; // Account for header row
        const item = {};

        // Map row values to standard fields
        Object.entries(row).forEach(([header, value]) => {
            const field = fieldMap[header];
            if (field) {
                item[field] = value;
            }
        });

        // Validate and transform
        const rowErrors = [];

        // Vendor name (required) - can come from vendor_name, brand, or default
        let vendorName = item.vendor_name || item.brand || defaultVendorName;
        if (!vendorName || String(vendorName).trim() === '') {
            rowErrors.push('Missing vendor name');
        } else {
            item.vendor_name = String(vendorName).trim();
        }

        // Product name (required)
        if (!item.product_name || String(item.product_name).trim() === '') {
            rowErrors.push('Missing product name');
        } else {
            item.product_name = String(item.product_name).trim();
        }

        // Vendor item number (required)
        if (!item.vendor_item_number || String(item.vendor_item_number).trim() === '') {
            rowErrors.push('Missing vendor item number');
        } else {
            item.vendor_item_number = String(item.vendor_item_number).trim();
        }

        // Cost (required)
        const costCents = parseMoney(item.cost);
        if (costCents === null || costCents < 0) {
            rowErrors.push(`Invalid cost: ${item.cost}`);
        } else {
            item.cost_cents = costCents;
        }

        // Price (optional)
        if (item.price !== undefined && item.price !== null && item.price !== '') {
            const priceCents = parseMoney(item.price);
            if (priceCents === null || priceCents < 0) {
                rowErrors.push(`Invalid price: ${item.price}`);
            } else {
                item.price_cents = priceCents;
            }
        } else {
            item.price_cents = null;
        }

        // UPC (optional)
        item.upc = cleanUPC(item.upc);

        // Calculate margin if we have both cost and price
        item.margin_percent = calculateMargin(item.cost_cents, item.price_cents);

        if (rowErrors.length > 0) {
            errors.push({ row: rowNum, errors: rowErrors, data: item });
        } else {
            items.push(item);
        }
    });

    return {
        valid: errors.length === 0,
        items,
        errors,
        fieldMap
    };
}

/**
 * Look up or create vendor by name
 * @param {string} vendorName - Vendor name
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @returns {Promise<string|null>} Vendor ID or null
 */
async function findOrCreateVendor(vendorName, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for findOrCreateVendor');
    }

    // First try to find existing vendor (case-insensitive, within merchant)
    const existing = await db.query(
        'SELECT id FROM vendors WHERE LOWER(name) = LOWER($1) AND merchant_id = $2 LIMIT 1',
        [vendorName, merchantId]
    );

    if (existing.rows.length > 0) {
        return existing.rows[0].id;
    }

    // Create new vendor with generated ID
    const vendorId = `VENDOR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await db.query(
        `INSERT INTO vendors (id, name, merchant_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [vendorId, vendorName, merchantId]
    );

    logger.info('Created new vendor from import', { vendorId, vendorName, merchantId });
    return vendorId;
}

/**
 * Try to match vendor catalog item to our catalog
 * Checks across entire catalog - items can have multiple vendors
 * @param {Object} item - Vendor catalog item
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Object>} Match result with variation_id, method, and all matches
 */
async function matchToOurCatalog(item, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for matchToOurCatalog');
    }

    const allMatches = [];

    // Try UPC match first (most reliable) - find ALL matching variations
    if (item.upc) {
        const upcMatches = await db.query(`
            SELECT v.id, v.sku, v.name as variation_name, v.price_money,
                   i.name as item_name, i.id as item_id
            FROM variations v
            LEFT JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE v.upc = $2 AND v.merchant_id = $1 AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
        `, [merchantId, item.upc]);

        for (const match of upcMatches.rows) {
            allMatches.push({
                variation_id: match.id,
                method: 'upc',
                sku: match.sku,
                variation_name: match.variation_name,
                item_name: match.item_name,
                our_price_cents: match.price_money
            });
        }
    }

    // Also try vendor item number match (check supplier_item_number and sku)
    if (item.vendor_item_number) {
        const vendorSkuMatches = await db.query(`
            SELECT v.id, v.sku, v.name as variation_name, v.price_money,
                   i.name as item_name, i.id as item_id
            FROM variations v
            LEFT JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE (v.supplier_item_number = $2 OR v.sku = $2)
                  AND v.merchant_id = $1
                  AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
                  AND v.id NOT IN (SELECT unnest($3::text[]))
        `, [merchantId, item.vendor_item_number, allMatches.map(m => m.variation_id)]);

        for (const match of vendorSkuMatches.rows) {
            allMatches.push({
                variation_id: match.id,
                method: 'vendor_item_number',
                sku: match.sku,
                variation_name: match.variation_name,
                item_name: match.item_name,
                our_price_cents: match.price_money
            });
        }
    }

    // Return first match as primary, but include all matches
    if (allMatches.length > 0) {
        return {
            variation_id: allMatches[0].variation_id,
            method: allMatches[0].method,
            allMatches
        };
    }

    return { variation_id: null, method: null, allMatches: [] };
}

/**
 * Import vendor catalog items into database
 * @param {Array<Object>} items - Validated items to import
 * @param {string} batchId - Import batch ID
 * @param {Object} options - Import options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @param {string} options.vendorId - Selected vendor ID
 * @param {string} options.vendorName - Selected vendor name
 * @param {string} options.importName - User-defined import name
 * @returns {Promise<Object>} Import statistics with price update report
 */
async function importItems(items, batchId, options = {}) {
    const { merchantId, vendorId, vendorName, importName } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for importItems');
    }

    const stats = {
        total: items.length,
        imported: 0,
        matched: 0,
        errors: []
    };

    // Track price differences for report
    const priceUpdates = [];

    for (const item of items) {
        try {
            // Try to match to our catalog (with merchant filtering)
            const match = await matchToOurCatalog(item, merchantId);
            if (match.variation_id) {
                stats.matched++;

                // Check for price differences on matched items
                for (const m of match.allMatches) {
                    if (m.our_price_cents && item.price_cents) {
                        const priceDiff = item.price_cents - m.our_price_cents;
                        const priceDiffPercent = (priceDiff / m.our_price_cents) * 100;

                        if (Math.abs(priceDiffPercent) >= 1) { // Report differences >= 1%
                            priceUpdates.push({
                                vendor_item_number: item.vendor_item_number,
                                product_name: item.product_name,
                                brand: item.brand || null,
                                upc: item.upc,
                                our_sku: m.sku,
                                our_item_name: m.item_name || m.variation_name,
                                our_price_cents: m.our_price_cents,
                                vendor_srp_cents: item.price_cents,
                                vendor_cost_cents: item.cost_cents,
                                price_diff_cents: priceDiff,
                                price_diff_percent: priceDiffPercent,
                                match_method: m.method,
                                action: priceDiff > 0 ? 'price_increase' : 'price_decrease',
                                matched_variation_id: m.variation_id  // Include variation ID for pushing to Square
                            });
                        }
                    }
                }
            }

            // Insert catalog item with brand stored separately (including merchant_id)
            await db.query(`
                INSERT INTO vendor_catalog_items (
                    merchant_id, vendor_id, vendor_name, brand, vendor_item_number, product_name,
                    upc, cost_cents, price_cents, margin_percent,
                    matched_variation_id, match_method, import_batch_id, import_name, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
                ON CONFLICT (vendor_id, vendor_item_number, import_batch_id)
                DO UPDATE SET
                    brand = EXCLUDED.brand,
                    product_name = EXCLUDED.product_name,
                    upc = EXCLUDED.upc,
                    cost_cents = EXCLUDED.cost_cents,
                    price_cents = EXCLUDED.price_cents,
                    margin_percent = EXCLUDED.margin_percent,
                    matched_variation_id = EXCLUDED.matched_variation_id,
                    match_method = EXCLUDED.match_method,
                    import_name = EXCLUDED.import_name,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                merchantId,
                vendorId,
                vendorName,
                item.brand || null,
                item.vendor_item_number,
                item.product_name,
                item.upc,
                item.cost_cents,
                item.price_cents,
                item.margin_percent,
                match.variation_id,
                match.method,
                batchId,
                importName || null
            ]);

            stats.imported++;

        } catch (error) {
            stats.errors.push({
                item: item.vendor_item_number,
                error: error.message
            });
            logger.error('Failed to import vendor catalog item', {
                item: item.vendor_item_number,
                error: error.message
            });
        }
    }

    // Add price update report to stats
    stats.priceUpdates = priceUpdates;
    stats.priceUpdatesCount = priceUpdates.length;
    stats.priceIncreasesCount = priceUpdates.filter(p => p.action === 'price_increase').length;
    stats.priceDecreasesCount = priceUpdates.filter(p => p.action === 'price_decrease').length;

    return stats;
}

/**
 * Main import function - handles CSV or XLSX
 * @param {string|Buffer} data - File content (string for CSV, Buffer for XLSX)
 * @param {string} fileType - 'csv' or 'xlsx'
 * @param {Object} options - Import options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @param {string} options.defaultVendorName - Default vendor name for files without vendor column
 * @returns {Promise<Object>} Import result
 */
async function importVendorCatalog(data, fileType, options = {}) {
    const startTime = Date.now();
    const batchId = generateBatchId();
    const { merchantId, defaultVendorName } = options;

    if (!merchantId) {
        return {
            success: false,
            error: 'merchantId is required for importVendorCatalog'
        };
    }

    logger.info('Starting vendor catalog import', { fileType, batchId, merchantId, defaultVendorName });

    try {
        // Parse file
        let parsed;
        if (fileType === 'xlsx') {
            parsed = await parseXLSX(data);
        } else {
            parsed = parseCSV(data);
        }

        logger.info('Parsed vendor catalog file', {
            batchId,
            headers: parsed.headers,
            rowCount: parsed.rows.length
        });

        // Validate and transform
        const validation = validateAndTransform(parsed.rows, parsed.headers, defaultVendorName);

        if (!validation.valid && validation.items.length === 0) {
            return {
                success: false,
                batchId,
                error: validation.error,
                validationErrors: validation.errors
            };
        }

        // Import valid items (with merchantId)
        const stats = await importItems(validation.items, batchId, { merchantId });

        const duration = Date.now() - startTime;
        logger.info('Vendor catalog import complete', {
            batchId,
            duration,
            ...stats
        });

        return {
            success: true,
            batchId,
            duration,
            stats,
            validationErrors: validation.errors,
            fieldMap: validation.fieldMap
        };

    } catch (error) {
        logger.error('Vendor catalog import failed', {
            batchId,
            error: error.message,
            stack: error.stack
        });

        return {
            success: false,
            batchId,
            error: error.message
        };
    }
}

/**
 * Search vendor catalog items
 * @param {Object} options - Search options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Array>} Matching items
 */
async function searchVendorCatalog(options = {}) {
    const { merchantId, vendorId, vendorName, upc, search, matchedOnly, limit = 100, offset = 0 } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for searchVendorCatalog');
    }

    let sql = `
        SELECT
            vci.*,
            v.name as vendor_display_name,
            var.sku as our_sku,
            var.name as our_product_name,
            var.price_money as our_price_cents,
            i.name as our_item_name
        FROM vendor_catalog_items vci
        LEFT JOIN vendors v ON vci.vendor_id = v.id AND v.merchant_id = $1
        LEFT JOIN variations var ON vci.matched_variation_id = var.id AND var.merchant_id = $1
        LEFT JOIN items i ON var.item_id = i.id AND i.merchant_id = $1
        WHERE vci.merchant_id = $1
    `;
    const params = [merchantId];
    let paramCount = 1;

    if (vendorId) {
        paramCount++;
        sql += ` AND vci.vendor_id = $${paramCount}`;
        params.push(vendorId);
    }

    if (vendorName) {
        paramCount++;
        sql += ` AND LOWER(vci.vendor_name) LIKE LOWER($${paramCount})`;
        params.push(`%${vendorName}%`);
    }

    if (upc) {
        paramCount++;
        sql += ` AND vci.upc = $${paramCount}`;
        params.push(upc);
    }

    if (search) {
        paramCount++;
        sql += ` AND (
            LOWER(vci.product_name) LIKE LOWER($${paramCount})
            OR LOWER(vci.vendor_item_number) LIKE LOWER($${paramCount})
            OR vci.upc LIKE $${paramCount}
        )`;
        params.push(`%${search}%`);
    }

    if (matchedOnly) {
        sql += ` AND vci.matched_variation_id IS NOT NULL`;
    }

    sql += ` ORDER BY vci.imported_at DESC, vci.product_name`;

    paramCount++;
    sql += ` LIMIT $${paramCount}`;
    params.push(limit);

    paramCount++;
    sql += ` OFFSET $${paramCount}`;
    params.push(offset);

    const result = await db.query(sql, params);
    return result.rows;
}

/**
 * Get import batches summary
 * @param {Object} options - Filter options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @param {boolean} options.includeArchived - Include archived imports
 * @returns {Promise<Array>} List of import batches with stats
 */
async function getImportBatches(options = {}) {
    const { merchantId, includeArchived = false } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for getImportBatches');
    }

    const result = await db.query(`
        SELECT
            import_batch_id,
            vendor_id,
            vendor_name,
            import_name,
            is_archived,
            COUNT(*) as item_count,
            COUNT(matched_variation_id) as matched_count,
            MIN(imported_at) as imported_at,
            AVG(margin_percent) as avg_margin
        FROM vendor_catalog_items
        WHERE merchant_id = $1
        ${includeArchived ? '' : 'AND (is_archived = FALSE OR is_archived IS NULL)'}
        GROUP BY import_batch_id, vendor_id, vendor_name, import_name, is_archived
        ORDER BY imported_at DESC
        LIMIT 100
    `, [merchantId]);
    return result.rows;
}

/**
 * Archive an import batch (soft delete - keeps for searches)
 * @param {string} batchId - Batch ID to archive
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @returns {Promise<number>} Number of items archived
 */
async function archiveImportBatch(batchId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for archiveImportBatch');
    }
    const result = await db.query(
        'UPDATE vendor_catalog_items SET is_archived = TRUE, updated_at = CURRENT_TIMESTAMP WHERE import_batch_id = $1 AND merchant_id = $2',
        [batchId, merchantId]
    );
    return result.rowCount;
}

/**
 * Unarchive an import batch
 * @param {string} batchId - Batch ID to unarchive
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @returns {Promise<number>} Number of items unarchived
 */
async function unarchiveImportBatch(batchId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for unarchiveImportBatch');
    }
    const result = await db.query(
        'UPDATE vendor_catalog_items SET is_archived = FALSE, updated_at = CURRENT_TIMESTAMP WHERE import_batch_id = $1 AND merchant_id = $2',
        [batchId, merchantId]
    );
    return result.rowCount;
}

/**
 * Delete an import batch
 * @param {string} batchId - Batch ID to delete
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @returns {Promise<number>} Number of items deleted
 */
async function deleteImportBatch(batchId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for deleteImportBatch');
    }
    const result = await db.query(
        'DELETE FROM vendor_catalog_items WHERE import_batch_id = $1 AND merchant_id = $2',
        [batchId, merchantId]
    );
    return result.rowCount;
}

/**
 * Regenerate price update report for a previously imported batch
 * Compares stored vendor prices against current catalog prices
 * @param {string} batchId - Batch ID to generate report for
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} Price report with vendor info and price updates
 */
async function regeneratePriceReport(batchId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for regeneratePriceReport');
    }

    // Get batch info and all matched items with current catalog prices
    const batchResult = await db.query(`
        SELECT
            vci.vendor_id,
            vci.vendor_name,
            vci.import_name,
            vci.imported_at,
            vci.vendor_item_number,
            vci.product_name,
            vci.brand,
            vci.upc,
            vci.cost_cents as vendor_cost_cents,
            vci.price_cents as vendor_srp_cents,
            vci.matched_variation_id,
            vci.match_method,
            v.sku as our_sku,
            v.name as variation_name,
            v.price_money as our_price_cents,
            i.name as item_name
        FROM vendor_catalog_items vci
        LEFT JOIN variations v ON vci.matched_variation_id = v.id AND v.merchant_id = $2
        LEFT JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
        WHERE vci.import_batch_id = $1 AND vci.merchant_id = $2
        ORDER BY vci.product_name
    `, [batchId, merchantId]);

    if (batchResult.rows.length === 0) {
        return {
            success: false,
            error: 'Batch not found or no items'
        };
    }

    // Extract batch metadata from first row
    const firstRow = batchResult.rows[0];
    const vendorName = firstRow.vendor_name;
    const vendorId = firstRow.vendor_id;
    const importName = firstRow.import_name;
    const importedAt = firstRow.imported_at;

    // Build price updates array for matched items with price differences
    const priceUpdates = [];
    for (const row of batchResult.rows) {
        if (row.matched_variation_id && row.our_price_cents && row.vendor_srp_cents) {
            const priceDiff = row.vendor_srp_cents - row.our_price_cents;
            const priceDiffPercent = (priceDiff / row.our_price_cents) * 100;

            // Only report differences >= 1%
            if (Math.abs(priceDiffPercent) >= 1) {
                priceUpdates.push({
                    vendor_item_number: row.vendor_item_number,
                    product_name: row.product_name,
                    brand: row.brand || null,
                    upc: row.upc,
                    our_sku: row.our_sku,
                    our_item_name: row.item_name || row.variation_name,
                    our_price_cents: row.our_price_cents,
                    vendor_srp_cents: row.vendor_srp_cents,
                    vendor_cost_cents: row.vendor_cost_cents,
                    price_diff_cents: priceDiff,
                    price_diff_percent: priceDiffPercent,
                    match_method: row.match_method,
                    action: priceDiff > 0 ? 'price_increase' : 'price_decrease',
                    matched_variation_id: row.matched_variation_id
                });
            }
        }
    }

    return {
        success: true,
        batchId,
        vendorId,
        vendorName,
        importName,
        importedAt,
        totalItems: batchResult.rows.length,
        matchedItems: batchResult.rows.filter(r => r.matched_variation_id).length,
        priceUpdates,
        summary: {
            total: priceUpdates.length,
            increases: priceUpdates.filter(p => p.action === 'price_increase').length,
            decreases: priceUpdates.filter(p => p.action === 'price_decrease').length
        }
    };
}

/**
 * Quick lookup by UPC
 * @param {string} upc - UPC to lookup
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Array>} All vendor catalog items with this UPC
 */
async function lookupByUPC(upc, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for lookupByUPC');
    }

    const cleanedUPC = cleanUPC(upc);
    if (!cleanedUPC) return [];

    const result = await db.query(`
        SELECT
            vci.*,
            v.name as vendor_display_name
        FROM vendor_catalog_items vci
        LEFT JOIN vendors v ON vci.vendor_id = v.id AND v.merchant_id = $1
        WHERE vci.upc = $2 AND vci.merchant_id = $1
        ORDER BY vci.cost_cents ASC
    `, [merchantId, cleanedUPC]);

    return result.rows;
}

/**
 * Get catalog statistics
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Object>} Statistics
 */
async function getStats(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getStats');
    }

    const result = await db.query(`
        SELECT
            COUNT(*) as total_items,
            COUNT(DISTINCT vendor_id) as vendor_count,
            COUNT(matched_variation_id) as matched_items,
            COUNT(DISTINCT import_batch_id) as batch_count,
            AVG(margin_percent) as avg_margin,
            MIN(imported_at) as earliest_import,
            MAX(imported_at) as latest_import
        FROM vendor_catalog_items
        WHERE merchant_id = $1
    `, [merchantId]);

    return result.rows[0];
}

/**
 * Supported field types for mapping
 * Note: Vendor is selected from dropdown, not mapped from file
 * Brand is metadata only, stored separately
 */
const FIELD_TYPES = [
    { id: 'brand', label: 'Brand', required: false, description: 'Brand/manufacturer name (metadata only)' },
    { id: 'product_name', label: 'Product Name', required: true, description: 'Product description/title' },
    { id: 'vendor_item_number', label: 'Vendor Item #', required: true, description: "Vendor's SKU or part number" },
    { id: 'upc', label: 'UPC/GTIN', required: false, description: 'Barcode for matching to catalog' },
    { id: 'cost', label: 'Cost', required: true, description: 'Your cost from this vendor' },
    { id: 'price', label: 'Price (SRP)', required: false, description: 'Suggested retail price' },
    { id: 'skip', label: '(Skip)', required: false, description: 'Ignore this column' }
];

/**
 * Preview file contents and auto-detect column mappings
 * @param {string|Buffer} data - File content
 * @param {string} fileType - 'csv' or 'xlsx'
 * @returns {Promise<Object>} Preview data with headers, sample rows, and suggested mappings
 */
async function previewFile(data, fileType) {
    // Parse file
    let parsed;
    if (fileType === 'xlsx') {
        parsed = await parseXLSX(data);
    } else {
        parsed = parseCSV(data);
    }

    const { headers, rows } = parsed;

    // Auto-detect mappings for each column
    const columns = headers.map((header, index) => {
        const autoDetected = normalizeHeader(header);

        // Get sample values from first 3 rows
        const sampleValues = rows.slice(0, 3).map(row => {
            const value = row[header];
            // Truncate long values for display
            if (value === null || value === undefined) return '';
            const str = String(value);
            return str.length > 50 ? str.substring(0, 47) + '...' : str;
        });

        return {
            index,
            originalHeader: header,
            suggestedMapping: autoDetected || 'skip',
            sampleValues
        };
    });

    return {
        totalRows: rows.length,
        columns,
        fieldTypes: FIELD_TYPES
    };
}

/**
 * Import with explicit column mappings
 * @param {string|Buffer} data - File content
 * @param {string} fileType - 'csv' or 'xlsx'
 * @param {Object} options - Import options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @param {Object} options.columnMappings - Map of column index/header to field type
 * @param {string} options.vendorId - Selected vendor ID (required)
 * @param {string} options.vendorName - Selected vendor name
 * @param {string} options.importName - User-defined catalog name (e.g., "ABC Corp 2025 Price List")
 * @returns {Promise<Object>} Import result with price update report
 */
async function importWithMappings(data, fileType, options = {}) {
    const startTime = Date.now();
    const batchId = generateBatchId();
    const { merchantId, columnMappings, vendorId, vendorName, importName } = options;

    // Validate merchantId is provided
    if (!merchantId) {
        return {
            success: false,
            error: 'merchantId is required for importWithMappings'
        };
    }

    // Validate vendor is selected
    if (!vendorId) {
        return {
            success: false,
            error: 'Please select a vendor for this import'
        };
    }

    logger.info('Starting vendor catalog import with explicit mappings', {
        fileType,
        batchId,
        merchantId,
        vendorId,
        vendorName,
        importName,
        mappingCount: columnMappings ? Object.keys(columnMappings).length : 0
    });

    try {
        // Parse file
        let parsed;
        if (fileType === 'xlsx') {
            parsed = await parseXLSX(data);
        } else {
            parsed = parseCSV(data);
        }

        const { headers, rows } = parsed;

        logger.info('Parsed vendor catalog file', {
            batchId,
            headers,
            rowCount: rows.length
        });

        // Build field map from explicit mappings or fall back to auto-detect
        const fieldMap = {};
        headers.forEach((header, index) => {
            // Check explicit mappings by index first, then by header name
            let mapping = null;
            if (columnMappings) {
                mapping = columnMappings[index] || columnMappings[header];
            }

            // Fall back to auto-detection if no explicit mapping
            if (!mapping || mapping === 'auto') {
                mapping = normalizeHeader(header);
            }

            // Skip if mapping is 'skip' or null
            if (mapping && mapping !== 'skip') {
                fieldMap[header] = mapping;
            }
        });

        // Validate required fields (vendor comes from selection, not file)
        const mappedFields = Object.values(fieldMap);

        const missingRequired = [];
        if (!mappedFields.includes('product_name')) missingRequired.push('product_name');
        if (!mappedFields.includes('vendor_item_number')) missingRequired.push('vendor_item_number');
        if (!mappedFields.includes('cost')) missingRequired.push('cost');

        if (missingRequired.length > 0) {
            return {
                success: false,
                batchId,
                error: `Missing required field mappings: ${missingRequired.join(', ')}`,
                fieldMap
            };
        }

        // Transform rows using the field map
        const items = [];
        const errors = [];

        rows.forEach((row, index) => {
            const rowNum = index + 2;
            const item = {};

            // Map row values to standard fields
            Object.entries(row).forEach(([header, value]) => {
                const field = fieldMap[header];
                if (field) {
                    item[field] = value;
                }
            });

            // Validate and transform
            const rowErrors = [];

            // Brand (optional metadata from file)
            if (item.brand) {
                item.brand = String(item.brand).trim();
            }

            // Product name (required)
            if (!item.product_name || String(item.product_name).trim() === '') {
                rowErrors.push('Missing product name');
            } else {
                item.product_name = String(item.product_name).trim();
            }

            // Vendor item number (required)
            if (!item.vendor_item_number || String(item.vendor_item_number).trim() === '') {
                rowErrors.push('Missing vendor item number');
            } else {
                item.vendor_item_number = String(item.vendor_item_number).trim();
            }

            // Cost (required)
            const costCents = parseMoney(item.cost);
            if (costCents === null || costCents < 0) {
                rowErrors.push(`Invalid cost: ${item.cost}`);
            } else {
                item.cost_cents = costCents;
            }

            // Price (optional)
            if (item.price !== undefined && item.price !== null && item.price !== '') {
                const priceCents = parseMoney(item.price);
                if (priceCents === null || priceCents < 0) {
                    rowErrors.push(`Invalid price: ${item.price}`);
                } else {
                    item.price_cents = priceCents;
                }
            } else {
                item.price_cents = null;
            }

            // UPC
            item.upc = cleanUPC(item.upc);

            // Calculate margin
            item.margin_percent = calculateMargin(item.cost_cents, item.price_cents);

            if (rowErrors.length > 0) {
                errors.push({ row: rowNum, errors: rowErrors, data: item });
            } else {
                items.push(item);
            }
        });

        if (items.length === 0) {
            return {
                success: false,
                batchId,
                error: 'No valid rows to import',
                validationErrors: errors
            };
        }

        // Import valid items with vendor info (including merchantId)
        const stats = await importItems(items, batchId, {
            merchantId,
            vendorId,
            vendorName,
            importName
        });

        const duration = Date.now() - startTime;
        logger.info('Vendor catalog import complete', {
            batchId,
            duration,
            imported: stats.imported,
            matched: stats.matched,
            priceUpdatesCount: stats.priceUpdatesCount
        });

        return {
            success: true,
            batchId,
            duration,
            stats,
            validationErrors: errors,
            fieldMap,
            importName,
            vendorName
        };

    } catch (error) {
        logger.error('Vendor catalog import failed', {
            batchId,
            error: error.message,
            stack: error.stack
        });

        return {
            success: false,
            batchId,
            error: error.message
        };
    }
}

module.exports = {
    importVendorCatalog,
    importWithMappings,
    previewFile,
    searchVendorCatalog,
    getImportBatches,
    archiveImportBatch,
    unarchiveImportBatch,
    deleteImportBatch,
    regeneratePriceReport,
    lookupByUPC,
    getStats,
    generateBatchId,
    parseCSV,
    parseXLSX,
    validateAndTransform,
    normalizeHeader,
    matchToOurCatalog,
    FIELD_TYPES
};
