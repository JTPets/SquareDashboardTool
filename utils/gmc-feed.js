/**
 * Google Merchant Center Feed Generator
 * Generates product feeds in TSV format for Google Merchant Center
 */

const db = require('./database');
const logger = require('./logger');
const fs = require('fs').promises;
const path = require('path');

/**
 * Get GMC settings from database
 */
async function getSettings() {
    const result = await db.query('SELECT setting_key, setting_value FROM gmc_settings');
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
 * @returns {Promise<Object>} Feed data and statistics
 */
async function generateFeedData(options = {}) {
    const startTime = Date.now();
    logger.info('Starting GMC feed generation');

    try {
        const settings = await getSettings();
        const baseUrl = settings.website_base_url || 'https://your-store-url.com';
        const urlPattern = settings.product_url_pattern || '/product/{slug}/{variation_id}';
        const currency = settings.currency || 'CAD';
        const defaultCondition = settings.default_condition || 'new';
        const adultContent = settings.adult_content || 'no';
        const isBundle = settings.is_bundle || 'no';

        // Query to get all product data with brands and taxonomy
        const query = `
            SELECT
                v.id as variation_id,
                v.name as variation_name,
                v.sku,
                v.upc,
                v.price_money,
                v.currency,
                v.images as variation_images,
                i.id as item_id,
                i.name as item_name,
                i.description,
                i.category_id,
                i.category_name,
                i.images as item_images,
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
                       ${options.locationId ? 'AND ic.location_id = $1' : ''}
                    ), 0
                ) as quantity
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN item_brands ib ON i.id = ib.item_id
            LEFT JOIN brands b ON ib.brand_id = b.id
            LEFT JOIN category_taxonomy_mapping ctm ON i.category_id = ctm.category_id
            LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
            WHERE v.is_deleted = FALSE
              AND i.is_deleted = FALSE
              AND i.available_online = TRUE
            ORDER BY i.name, v.name
        `;

        const params = options.locationId ? [options.locationId] : [];
        const result = await db.query(query, params);

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

                // Get image URLs
                let imageLink = '';
                const additionalImages = [];

                // Try variation images first, then item images
                const images = row.variation_images || row.item_images || [];
                if (Array.isArray(images) && images.length > 0) {
                    // Images might be IDs or URLs depending on how they're stored
                    for (let i = 0; i < images.length; i++) {
                        const img = images[i];
                        const imgUrl = typeof img === 'string' ? img : img?.url;
                        if (imgUrl) {
                            if (i === 0) {
                                imageLink = imgUrl;
                            } else {
                                additionalImages.push(imgUrl);
                            }
                        }
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
        logger.error('GMC feed generation failed', { error: error.message, stack: error.stack });
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
    const feedsDir = path.join(__dirname, '..', 'public', 'feeds');

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
 * Record feed generation in history
 */
async function recordFeedHistory(stats, tsvPath, sheetUrl = null, error = null) {
    try {
        await db.query(`
            INSERT INTO gmc_feed_history
            (total_products, products_with_errors, tsv_file_path, google_sheet_url, duration_seconds, status, error_message)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            stats.total,
            stats.withErrors,
            tsvPath,
            sheetUrl,
            stats.duration,
            error ? 'failed' : 'success',
            error
        ]);
    } catch (err) {
        logger.error('Failed to record feed history', { error: err.message });
    }
}

/**
 * Full feed generation - generates data, saves TSV, records history
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Generation result
 */
async function generateFeed(options = {}) {
    try {
        // Generate feed data
        const { products, stats, settings } = await generateFeedData(options);

        // Generate and save TSV
        const tsvContent = generateTsvContent(products);
        const tsvPath = await saveTsvFile(tsvContent, options.filename || 'gmc-feed.tsv');

        // Record in history
        await recordFeedHistory(stats, tsvPath, null, null);

        return {
            success: true,
            stats,
            tsvPath,
            feedUrl: '/feeds/gmc-feed.tsv',
            products: options.includeProducts ? products : undefined
        };
    } catch (error) {
        await recordFeedHistory({ total: 0, withErrors: 0, duration: 0 }, null, null, error.message);
        throw error;
    }
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

module.exports = {
    generateFeedData,
    generateTsvContent,
    saveTsvFile,
    generateFeed,
    importBrands,
    importGoogleTaxonomy,
    getSettings
};
