/**
 * Google Merchant Center Feed Service
 *
 * Generates product feeds in TSV format for Google Merchant Center.
 * Provides:
 * - Product feed generation from database
 * - TSV content formatting
 * - Local inventory feed generation
 * - GMC settings management
 * - Brand and taxonomy imports
 *
 * This service was extracted from utils/gmc-feed.js as part of P1-3.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const fs = require('fs').promises;
const path = require('path');

/**
 * Get GMC settings from database for a specific merchant
 * @param {number} merchantId - The merchant ID to get settings for
 */
async function getSettings(merchantId) {
    if (!merchantId) {
        logger.warn('getSettings called without merchantId - returning empty settings');
        return {};
    }
    const result = await db.query(
        'SELECT setting_key, setting_value FROM gmc_settings WHERE merchant_id = $1',
        [merchantId]
    );
    const settings = {};
    for (const row of result.rows) {
        settings[row.setting_key] = row.setting_value;
    }
    return settings;
}

/**
 * Generate URL slug from product name
 */
function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 100);
}

/**
 * Escape value for TSV (handle tabs and newlines)
 */
function escapeTsvValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value)
        .replace(/\t/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\r/g, '');
}

/**
 * Format price for GMC (e.g., "102.99 CAD")
 */
function formatPrice(priceCents, currency = 'CAD') {
    if (!priceCents) return '';
    const price = (priceCents / 100).toFixed(2);
    return `${price} ${currency}`;
}

/**
 * Determine availability based on stock quantity
 */
function getAvailability(quantity) {
    if (quantity === null || quantity === undefined) {
        return 'out_of_stock';
    }
    return quantity > 0 ? 'in_stock' : 'out_of_stock';
}

/**
 * Generate the GMC feed data
 * @param {Object} options - Generation options
 * @param {string} options.locationId - Optional location ID to filter inventory
 * @param {number} options.merchantId - Merchant ID for multi-tenant support
 * @returns {Promise<Object>} Feed data and statistics
 */
async function generateFeedData(options = {}) {
    const { merchantId } = options;
    const startTime = Date.now();
    logger.info('Starting GMC feed generation', { merchantId });

    if (!merchantId) {
        throw new Error('merchantId is required for feed generation');
    }

    try {
        const settings = await getSettings(merchantId);
        const baseUrl = settings.website_base_url || 'https://your-store-url.com';
        const urlPattern = settings.product_url_pattern || '/product/{slug}/{variation_id}';
        const currency = settings.currency || 'CAD';
        const defaultCondition = settings.default_condition || 'new';
        const adultContent = settings.adult_content || 'no';
        const isBundle = settings.is_bundle || 'no';

        // Query to get all product data with brands and taxonomy - filtered by merchant_id
        const queryText = `
            SELECT
                v.id as variation_id,
                v.name as variation_name,
                v.sku,
                v.upc,
                v.price_money,
                v.currency,
                i.id as item_id,
                i.name as item_name,
                i.description,
                i.category_id,
                i.category_name,
                i.images as item_image_ids,
                -- Resolve image URLs from images table
                (
                    SELECT ARRAY_AGG(img.url ORDER BY idx)
                    FROM jsonb_array_elements_text(COALESCE(i.images, '[]'::jsonb)) WITH ORDINALITY AS t(image_id, idx)
                    JOIN images img ON img.id = t.image_id
                    WHERE img.url IS NOT NULL AND img.merchant_id = $1
                ) as image_urls,
                -- Brand
                b.name as brand_name,
                -- Google taxonomy
                gt.name as google_product_category,
                gt.id as google_taxonomy_id,
                -- Inventory
                COALESCE(
                    (SELECT SUM(ic.quantity)
                     FROM inventory_counts ic
                     WHERE ic.catalog_object_id = v.id
                       AND ic.state = 'IN_STOCK'
                       AND ic.merchant_id = $1
                       ${options.locationId ? 'AND ic.location_id = $2' : ''}
                    ), 0
                ) as quantity
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN item_brands ib ON i.id = ib.item_id AND ib.merchant_id = $1
            LEFT JOIN brands b ON ib.brand_id = b.id AND b.merchant_id = $1
            LEFT JOIN category_taxonomy_mapping ctm ON i.category_id = ctm.category_id AND ctm.merchant_id = $1
            LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
            WHERE v.is_deleted = FALSE
              AND i.is_deleted = FALSE
              AND i.available_online = TRUE
              AND v.merchant_id = $1
            ORDER BY i.name, v.name
        `;

        const params = options.locationId ? [merchantId, options.locationId] : [merchantId];
        const result = await db.query(queryText, params);

        const products = [];
        let productsWithErrors = 0;

        for (const row of result.rows) {
            try {
                // Build product title
                const title = row.variation_name && row.variation_name !== 'Regular'
                    ? `${row.item_name}~${row.variation_name}`
                    : row.item_name;

                // Generate product URL
                const slug = generateSlug(row.item_name);
                const productUrl = baseUrl + urlPattern
                    .replace('{slug}', slug)
                    .replace('{variation_id}', row.item_id);

                // Get image URLs (now resolved from images table)
                let imageLink = '';
                const additionalImages = [];

                const imageUrls = row.image_urls || [];
                if (Array.isArray(imageUrls) && imageUrls.length > 0) {
                    imageLink = imageUrls[0];
                    for (let i = 1; i < imageUrls.length; i++) {
                        additionalImages.push(imageUrls[i]);
                    }
                }

                const product = {
                    id: row.variation_id,
                    title: title,
                    link: productUrl,
                    description: row.description || '',
                    gtin: row.upc || '',
                    category: row.category_name || '',
                    image_link: imageLink,
                    additional_image_link_1: additionalImages[0] || '',
                    additional_image_link_2: additionalImages[1] || '',
                    condition: defaultCondition,
                    availability: getAvailability(row.quantity),
                    quantity: row.quantity || 0,
                    brand: row.brand_name || '',
                    google_product_category: row.google_product_category || '',
                    price: formatPrice(row.price_money, row.currency || currency),
                    adult: adultContent,
                    is_bundle: isBundle
                };

                products.push(product);
            } catch (err) {
                logger.error('Error processing product for GMC feed', {
                    variationId: row.variation_id,
                    error: err.message
                });
                productsWithErrors++;
            }
        }

        const duration = Math.round((Date.now() - startTime) / 1000);
        logger.info('GMC feed data generated', {
            totalProducts: products.length,
            productsWithErrors,
            duration
        });

        return {
            products,
            stats: {
                total: products.length,
                withErrors: productsWithErrors,
                duration
            },
            settings
        };
    } catch (error) {
        logger.error('GMC feed generation failed', { error: error.message, stack: error.stack, merchantId });
        throw error;
    }
}

/**
 * Generate TSV content from products
 */
function generateTsvContent(products) {
    const headers = [
        'id',
        'title',
        'link',
        'description',
        'gtin',
        'category',
        'image_link',
        'additional_image_link',
        'additional_image_link',
        'condition',
        'availability',
        'quantity',
        'brand',
        'google_product_category',
        'price',
        'adult',
        'is_bundle'
    ];

    const rows = products.map(p => [
        escapeTsvValue(p.id),
        escapeTsvValue(p.title),
        escapeTsvValue(p.link),
        escapeTsvValue(p.description),
        escapeTsvValue(p.gtin),
        escapeTsvValue(p.category),
        escapeTsvValue(p.image_link),
        escapeTsvValue(p.additional_image_link_1),
        escapeTsvValue(p.additional_image_link_2),
        escapeTsvValue(p.condition),
        escapeTsvValue(p.availability),
        escapeTsvValue(p.quantity),
        escapeTsvValue(p.brand),
        escapeTsvValue(p.google_product_category),
        escapeTsvValue(p.price),
        escapeTsvValue(p.adult),
        escapeTsvValue(p.is_bundle)
    ].join('\t'));

    return [headers.join('\t'), ...rows].join('\n');
}

/**
 * Save TSV feed to file
 * @param {string} content - TSV content
 * @param {string} filename - Output filename (default: gmc-feed.tsv)
 * @returns {Promise<string>} Full path to saved file
 */
async function saveTsvFile(content, filename = 'gmc-feed.tsv') {
    // Write to output/feeds directory (outside public/ to avoid pm2 watch loops)
    const feedsDir = path.join(__dirname, '..', '..', 'output', 'feeds');

    // Ensure feeds directory exists
    try {
        await fs.mkdir(feedsDir, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }

    const filePath = path.join(feedsDir, filename);
    await fs.writeFile(filePath, content, 'utf8');

    logger.info('GMC feed saved to file', { filePath });
    return filePath;
}

/**
 * Import brands from array
 * @param {Array<string>} brandNames - Array of brand names
 * @returns {Promise<number>} Number of brands imported
 */
async function importBrands(brandNames) {
    let imported = 0;
    for (const name of brandNames) {
        if (!name || typeof name !== 'string') continue;
        try {
            await db.query(
                'INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
                [name.trim()]
            );
            imported++;
        } catch (err) {
            logger.error('Failed to import brand', { name, error: err.message });
        }
    }
    return imported;
}

/**
 * Import Google taxonomy from array
 * @param {Array<Object>} taxonomyItems - Array of {id, name} objects
 * @returns {Promise<number>} Number of taxonomy items imported
 */
async function importGoogleTaxonomy(taxonomyItems) {
    let imported = 0;
    for (const item of taxonomyItems) {
        if (!item.id || !item.name) continue;
        try {
            // Calculate level from the number of > separators
            const level = (item.name.match(/>/g) || []).length + 1;

            await db.query(`
                INSERT INTO google_taxonomy (id, name, level)
                VALUES ($1, $2, $3)
                ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level
            `, [item.id, item.name, level]);
            imported++;
        } catch (err) {
            logger.error('Failed to import taxonomy', { id: item.id, error: err.message });
        }
    }
    return imported;
}

/**
 * Get GMC location settings (store codes) for a merchant
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Array>} Array of location settings
 */
async function getLocationSettings(merchantId) {
    if (!merchantId) {
        return [];
    }
    const result = await db.query(`
        SELECT
            gls.id,
            gls.location_id,
            gls.google_store_code,
            gls.enabled,
            l.name as location_name,
            l.address as location_address
        FROM gmc_location_settings gls
        JOIN locations l ON gls.location_id = l.id AND l.merchant_id = $1
        WHERE gls.merchant_id = $1
        ORDER BY l.name
    `, [merchantId]);
    return result.rows;
}

/**
 * Save or update GMC location settings
 * @param {number} merchantId - The merchant ID
 * @param {string} locationId - The Square location ID
 * @param {Object} settings - Settings to save (google_store_code, enabled)
 */
async function saveLocationSettings(merchantId, locationId, settings) {
    const { google_store_code, enabled = true } = settings;

    await db.query(`
        INSERT INTO gmc_location_settings (merchant_id, location_id, google_store_code, enabled)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (merchant_id, location_id)
        DO UPDATE SET
            google_store_code = EXCLUDED.google_store_code,
            enabled = EXCLUDED.enabled,
            updated_at = NOW()
    `, [merchantId, locationId, google_store_code, enabled]);
}

/**
 * Generate Local Inventory Feed data for a specific location
 * This creates the feed format required by Google Merchant Center for local inventory
 *
 * @param {Object} options - Generation options
 * @param {number} options.merchantId - Merchant ID (required)
 * @param {string} options.locationId - Location ID (required)
 * @returns {Promise<Object>} Local inventory feed data
 */
async function generateLocalInventoryFeed(options = {}) {
    const { merchantId, locationId } = options;
    const startTime = Date.now();

    if (!merchantId) {
        throw new Error('merchantId is required for local inventory feed generation');
    }
    if (!locationId) {
        throw new Error('locationId is required for local inventory feed generation');
    }

    logger.info('Starting local inventory feed generation', { merchantId, locationId });

    try {
        // Get location settings to get the Google store code
        const locationResult = await db.query(`
            SELECT
                l.id,
                l.name as location_name,
                COALESCE(gls.google_store_code, l.id) as store_code,
                COALESCE(gls.enabled, true) as enabled
            FROM locations l
            LEFT JOIN gmc_location_settings gls ON l.id = gls.location_id AND gls.merchant_id = $1
            WHERE l.id = $2 AND l.merchant_id = $1
        `, [merchantId, locationId]);

        if (locationResult.rows.length === 0) {
            throw new Error(`Location ${locationId} not found for merchant ${merchantId}`);
        }

        const location = locationResult.rows[0];

        // Query to get inventory for this specific location with total inventory across all locations
        const queryText = `
            SELECT
                v.id as variation_id,
                v.sku,
                v.upc,
                i.id as item_id,
                i.name as item_name,
                v.name as variation_name,
                -- Inventory at this specific location
                COALESCE(
                    (SELECT SUM(ic.quantity)
                     FROM inventory_counts ic
                     WHERE ic.catalog_object_id = v.id
                       AND ic.state = 'IN_STOCK'
                       AND ic.merchant_id = $1
                       AND ic.location_id = $2
                    ), 0
                ) as location_quantity,
                -- Total inventory across ALL locations
                COALESCE(
                    (SELECT SUM(ic.quantity)
                     FROM inventory_counts ic
                     WHERE ic.catalog_object_id = v.id
                       AND ic.state = 'IN_STOCK'
                       AND ic.merchant_id = $1
                    ), 0
                ) as total_quantity
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE v.is_deleted = FALSE
              AND i.is_deleted = FALSE
              AND i.available_online = TRUE
              AND v.merchant_id = $1
            ORDER BY i.name, v.name
        `;

        const result = await db.query(queryText, [merchantId, locationId]);

        const items = [];
        let itemsWithErrors = 0;

        for (const row of result.rows) {
            try {
                // Use variation_id as the item identifier to match the main product feed
                // The main feed uses variation_id as the 'id' field, so local inventory must match
                const itemId = row.variation_id;

                const item = {
                    store_code: location.store_code,
                    itemid: itemId,
                    quantity: row.location_quantity || 0,
                    total_inventory: row.total_quantity || 0,
                    // Additional fields that may be useful
                    variation_id: row.variation_id,
                    item_name: row.item_name,
                    variation_name: row.variation_name
                };

                items.push(item);
            } catch (err) {
                logger.error('Error processing item for local inventory feed', {
                    variationId: row.variation_id,
                    error: err.message
                });
                itemsWithErrors++;
            }
        }

        const duration = Math.round((Date.now() - startTime) / 1000);
        logger.info('Local inventory feed data generated', {
            merchantId,
            locationId,
            locationName: location.location_name,
            totalItems: items.length,
            itemsWithErrors,
            duration
        });

        return {
            items,
            location,
            stats: {
                total: items.length,
                withErrors: itemsWithErrors,
                duration
            }
        };
    } catch (error) {
        logger.error('Local inventory feed generation failed', {
            error: error.message,
            stack: error.stack,
            merchantId,
            locationId
        });
        throw error;
    }
}

/**
 * Generate TSV content for local inventory feed
 * Google Merchant Center Local Inventory Feed format
 */
function generateLocalInventoryTsvContent(items) {
    // Google's Local Product Inventory Feed requires these columns
    const headers = [
        'store_code',
        'itemid',
        'quantity'
    ];

    const rows = items.map(item => [
        escapeTsvValue(item.store_code),
        escapeTsvValue(item.itemid),
        escapeTsvValue(item.quantity)
    ].join('\t'));

    return [headers.join('\t'), ...rows].join('\n');
}

/**
 * Save GMC settings
 * @param {number} merchantId - The merchant ID
 * @param {Object} settings - Settings to save
 */
async function saveSettings(merchantId, settings) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    for (const [key, value] of Object.entries(settings)) {
        await db.query(`
            INSERT INTO gmc_settings (merchant_id, setting_key, setting_value)
            VALUES ($1, $2, $3)
            ON CONFLICT (merchant_id, setting_key)
            DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
        `, [merchantId, key, value]);
    }
}

module.exports = {
    generateFeedData,
    generateTsvContent,
    saveTsvFile,
    importBrands,
    importGoogleTaxonomy,
    getSettings,
    saveSettings,
    getLocationSettings,
    saveLocationSettings,
    generateLocalInventoryFeed,
    generateLocalInventoryTsvContent
};
