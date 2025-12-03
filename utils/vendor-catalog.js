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
         'item no', 'item no.', 'part no', 'part no.', 'catalog no', 'catalog no.'].includes(normalized)) {
        return 'vendor_item_number';
    }

    // Cost mappings (net price = actual cost after discounts, LIST = dealer list price)
    if (['cost', 'unit_cost', 'unit cost', 'wholesale', 'wholesale_price', 'wholesale price',
         'our_cost', 'our cost', 'dealer_cost', 'dealer cost', 'cost_price', 'cost price',
         'buy_price', 'buy price', 'net_price', 'net price', 'net cost', 'net',
         'your cost', 'your price', 'dealer price', 'distributor cost', 'dist cost',
         'list', 'dealer list', 'dealer list price'].includes(normalized)) {
        return 'cost';
    }

    // Price mappings (SRP = Suggested Retail Price)
    if (['price', 'retail', 'retail_price', 'retail price', 'msrp', 'list price', 'list_price',
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
 * @returns {Promise<string|null>} Vendor ID or null
 */
async function findOrCreateVendor(vendorName) {
    // First try to find existing vendor (case-insensitive)
    const existing = await db.query(
        'SELECT id FROM vendors WHERE LOWER(name) = LOWER($1) LIMIT 1',
        [vendorName]
    );

    if (existing.rows.length > 0) {
        return existing.rows[0].id;
    }

    // Create new vendor with generated ID
    const vendorId = `VENDOR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await db.query(
        `INSERT INTO vendors (id, name, status, created_at, updated_at)
         VALUES ($1, $2, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [vendorId, vendorName]
    );

    logger.info('Created new vendor from import', { vendorId, vendorName });
    return vendorId;
}

/**
 * Try to match vendor catalog item to our catalog
 * Checks across entire catalog - items can have multiple vendors
 * @param {Object} item - Vendor catalog item
 * @returns {Promise<Object>} Match result with variation_id, method, and all matches
 */
async function matchToOurCatalog(item) {
    const allMatches = [];

    // Try UPC match first (most reliable) - find ALL matching variations
    if (item.upc) {
        const upcMatches = await db.query(`
            SELECT v.id, v.sku, v.name as variation_name, v.price_money,
                   i.name as item_name, i.id as item_id
            FROM variations v
            LEFT JOIN items i ON v.item_id = i.id
            WHERE v.upc = $1 AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
        `, [item.upc]);

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
            LEFT JOIN items i ON v.item_id = i.id
            WHERE (v.supplier_item_number = $1 OR v.sku = $1)
                  AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
                  AND v.id NOT IN (SELECT unnest($2::text[]))
        `, [item.vendor_item_number, allMatches.map(m => m.variation_id)]);

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
 * @param {string} options.vendorId - Selected vendor ID
 * @param {string} options.vendorName - Selected vendor name
 * @param {string} options.importName - User-defined import name
 * @returns {Promise<Object>} Import statistics with price update report
 */
async function importItems(items, batchId, options = {}) {
    const { vendorId, vendorName, importName } = options;

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
            // Try to match to our catalog
            const match = await matchToOurCatalog(item);
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
                                action: priceDiff > 0 ? 'price_increase' : 'price_decrease'
                            });
                        }
                    }
                }
            }

            // Insert catalog item with brand stored separately
            await db.query(`
                INSERT INTO vendor_catalog_items (
                    vendor_id, vendor_name, brand, vendor_item_number, product_name,
                    upc, cost_cents, price_cents, margin_percent,
                    matched_variation_id, match_method, import_batch_id, import_name, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
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
 * @param {string} options.defaultVendorName - Default vendor name for files without vendor column
 * @returns {Promise<Object>} Import result
 */
async function importVendorCatalog(data, fileType, options = {}) {
    const startTime = Date.now();
    const batchId = generateBatchId();
    const { defaultVendorName } = options;

    logger.info('Starting vendor catalog import', { fileType, batchId, defaultVendorName });

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

        // Import valid items
        const stats = await importItems(validation.items, batchId);

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
 * @returns {Promise<Array>} Matching items
 */
async function searchVendorCatalog(options = {}) {
    const { vendorId, vendorName, upc, search, matchedOnly, limit = 100, offset = 0 } = options;

    let sql = `
        SELECT
            vci.*,
            v.name as vendor_display_name,
            var.sku as our_sku,
            var.name as our_product_name,
            var.price_money as our_price_cents,
            i.name as our_item_name
        FROM vendor_catalog_items vci
        LEFT JOIN vendors v ON vci.vendor_id = v.id
        LEFT JOIN variations var ON vci.matched_variation_id = var.id
        LEFT JOIN items i ON var.item_id = i.id
        WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

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
 * @param {boolean} options.includeArchived - Include archived imports
 * @returns {Promise<Array>} List of import batches with stats
 */
async function getImportBatches(options = {}) {
    const { includeArchived = false } = options;

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
        ${includeArchived ? '' : 'WHERE (is_archived = FALSE OR is_archived IS NULL)'}
        GROUP BY import_batch_id, vendor_id, vendor_name, import_name, is_archived
        ORDER BY imported_at DESC
        LIMIT 100
    `);
    return result.rows;
}

/**
 * Archive an import batch (soft delete - keeps for searches)
 * @param {string} batchId - Batch ID to archive
 * @returns {Promise<number>} Number of items archived
 */
async function archiveImportBatch(batchId) {
    const result = await db.query(
        'UPDATE vendor_catalog_items SET is_archived = TRUE, updated_at = CURRENT_TIMESTAMP WHERE import_batch_id = $1',
        [batchId]
    );
    return result.rowCount;
}

/**
 * Unarchive an import batch
 * @param {string} batchId - Batch ID to unarchive
 * @returns {Promise<number>} Number of items unarchived
 */
async function unarchiveImportBatch(batchId) {
    const result = await db.query(
        'UPDATE vendor_catalog_items SET is_archived = FALSE, updated_at = CURRENT_TIMESTAMP WHERE import_batch_id = $1',
        [batchId]
    );
    return result.rowCount;
}

/**
 * Delete an import batch
 * @param {string} batchId - Batch ID to delete
 * @returns {Promise<number>} Number of items deleted
 */
async function deleteImportBatch(batchId) {
    const result = await db.query(
        'DELETE FROM vendor_catalog_items WHERE import_batch_id = $1',
        [batchId]
    );
    return result.rowCount;
}

/**
 * Quick lookup by UPC
 * @param {string} upc - UPC to lookup
 * @returns {Promise<Array>} All vendor catalog items with this UPC
 */
async function lookupByUPC(upc) {
    const cleanedUPC = cleanUPC(upc);
    if (!cleanedUPC) return [];

    const result = await db.query(`
        SELECT
            vci.*,
            v.name as vendor_display_name
        FROM vendor_catalog_items vci
        LEFT JOIN vendors v ON vci.vendor_id = v.id
        WHERE vci.upc = $1
        ORDER BY vci.cost_cents ASC
    `, [cleanedUPC]);

    return result.rows;
}

/**
 * Get catalog statistics
 * @returns {Promise<Object>} Statistics
 */
async function getStats() {
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
    `);

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
 * @param {Object} options.columnMappings - Map of column index/header to field type
 * @param {string} options.vendorId - Selected vendor ID (required)
 * @param {string} options.vendorName - Selected vendor name
 * @param {string} options.importName - User-defined catalog name (e.g., "ABC Corp 2025 Price List")
 * @returns {Promise<Object>} Import result with price update report
 */
async function importWithMappings(data, fileType, options = {}) {
    const startTime = Date.now();
    const batchId = generateBatchId();
    const { columnMappings, vendorId, vendorName, importName } = options;

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

        // Import valid items with vendor info
        const stats = await importItems(items, batchId, {
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
