/**
 * Google Merchant Center API Integration (Multi-Tenant)
 * Handles direct API calls to push products and local inventory to GMC
 *
 * Each merchant connects their own GMC account - supports:
 * - Product catalog sync
 * - Local inventory sync per store location
 *
 * Uses the Content API for Shopping (Merchant API)
 * https://developers.google.com/shopping-content/guides/quickstart
 */

const { google } = require('googleapis');
const db = require('./database');
const logger = require('./logger');

// OAuth2 scopes for Merchant Center
const SCOPES = ['https://www.googleapis.com/auth/content'];

/**
 * Get OAuth2 client for a merchant
 * Reuses the same Google OAuth tokens from google_oauth_tokens table
 */
async function getAuthClient(merchantId) {
    // Get stored tokens
    const tokenResult = await db.query(
        'SELECT * FROM google_oauth_tokens WHERE merchant_id = $1',
        [merchantId]
    );

    if (tokenResult.rows.length === 0) {
        throw new Error('Google account not connected. Please connect your Google account first.');
    }

    const tokens = tokenResult.rows[0];

    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date
    });

    // Handle token refresh
    oauth2Client.on('tokens', async (newTokens) => {
        try {
            await db.query(`
                UPDATE google_oauth_tokens
                SET access_token = $1,
                    expiry_date = $2,
                    updated_at = NOW()
                WHERE merchant_id = $3
            `, [newTokens.access_token, newTokens.expiry_date, merchantId]);
            logger.info('Refreshed Google OAuth tokens for merchant', { merchantId });
        } catch (err) {
            logger.error('Failed to save refreshed tokens', { error: err.message });
        }
    });

    return oauth2Client;
}

/**
 * Get GMC settings for a merchant (including Merchant Center ID)
 */
async function getGmcApiSettings(merchantId) {
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
 * Save GMC API settings
 */
async function saveGmcApiSettings(merchantId, settings) {
    for (const [key, value] of Object.entries(settings)) {
        await db.query(`
            INSERT INTO gmc_settings (merchant_id, setting_key, setting_value)
            VALUES ($1, $2, $3)
            ON CONFLICT (merchant_id, setting_key)
            DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
        `, [merchantId, key, value]);
    }
}

// ==================== PRODUCT CATALOG SYNC ====================

/**
 * Insert or update a single product in GMC
 */
async function upsertProduct(options) {
    const { merchantId, gmcMerchantId, product } = options;

    const auth = await getAuthClient(merchantId);
    const content = google.content({ version: 'v2.1', auth });

    try {
        const response = await content.products.insert({
            merchantId: gmcMerchantId,
            requestBody: product
        });

        return { success: true, data: response.data };
    } catch (error) {
        logger.error('Failed to upsert product in GMC', {
            error: error.message,
            productId: product.offerId
        });
        throw error;
    }
}

/**
 * Batch insert/update products in GMC
 */
async function batchUpsertProducts(options) {
    const { merchantId, gmcMerchantId, products } = options;

    const auth = await getAuthClient(merchantId);
    const content = google.content({ version: 'v2.1', auth });

    const entries = products.map((product, index) => ({
        batchId: index,
        merchantId: gmcMerchantId,
        method: 'insert',
        product: product
    }));

    try {
        const response = await content.products.custombatch({
            requestBody: { entries }
        });

        const results = {
            success: true,
            total: entries.length,
            succeeded: 0,
            failed: 0,
            errors: []
        };

        for (const entry of response.data.entries || []) {
            if (entry.errors && entry.errors.length > 0) {
                results.failed++;
                results.errors.push({
                    batchId: entry.batchId,
                    offerId: products[entry.batchId]?.offerId,
                    errors: entry.errors
                });
            } else {
                results.succeeded++;
            }
        }

        return results;
    } catch (error) {
        logger.error('Failed to batch upsert products in GMC', { error: error.message });
        throw error;
    }
}

/**
 * Build GMC product object from database product data
 */
function buildGmcProduct(row, settings) {
    const baseUrl = settings.website_base_url || 'https://example.com';
    const currency = settings.currency || 'CAD';
    const country = settings.target_country || 'CA';
    const language = settings.content_language || 'en';

    // Use SKU as offer ID (required to be unique)
    const offerId = row.sku || row.upc || row.variation_id;

    const product = {
        offerId: offerId,
        title: row.variation_name && row.variation_name !== 'Regular'
            ? `${row.item_name} - ${row.variation_name}`
            : row.item_name,
        description: row.description || row.item_name,
        link: `${baseUrl}/product/${row.item_id}`,
        imageLink: row.image_url || undefined,
        contentLanguage: language,
        targetCountry: country,
        channel: 'online',
        availability: row.quantity > 0 ? 'in_stock' : 'out_of_stock',
        condition: settings.default_condition || 'new',
        price: {
            value: (row.price_money / 100).toFixed(2),
            currency: currency
        }
    };

    // Optional fields
    if (row.upc) product.gtin = row.upc;
    if (row.brand_name) product.brand = row.brand_name;
    if (row.google_product_category) product.googleProductCategory = row.google_product_category;

    return product;
}

/**
 * Sync all products to GMC
 */
async function syncProductCatalog(merchantId) {
    const settings = await getGmcApiSettings(merchantId);
    const gmcMerchantId = settings.gmc_merchant_id;

    if (!gmcMerchantId) {
        throw new Error('Google Merchant Center ID not configured');
    }

    // Get all products with required data
    const result = await db.query(`
        SELECT
            v.id as variation_id,
            v.name as variation_name,
            v.sku,
            v.upc,
            v.price_money,
            i.id as item_id,
            i.name as item_name,
            i.description,
            b.name as brand_name,
            gt.name as google_product_category,
            (SELECT img.url FROM images img
             WHERE img.id = (i.images->0)::text
               AND img.merchant_id = $1
             LIMIT 1) as image_url,
            COALESCE(
                (SELECT SUM(ic.quantity)
                 FROM inventory_counts ic
                 WHERE ic.catalog_object_id = v.id
                   AND ic.state = 'IN_STOCK'
                   AND ic.merchant_id = $1
                ), 0
            )::integer as quantity
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN item_brands ib ON i.id = ib.item_id AND ib.merchant_id = $1
        LEFT JOIN brands b ON ib.brand_id = b.id
        LEFT JOIN category_taxonomy_mapping ctm ON i.category_id = ctm.category_id AND ctm.merchant_id = $1
        LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
        WHERE v.is_deleted = FALSE
          AND i.is_deleted = FALSE
          AND i.available_online = TRUE
          AND v.merchant_id = $1
          AND (v.sku IS NOT NULL OR v.upc IS NOT NULL)
    `, [merchantId]);

    if (result.rows.length === 0) {
        return {
            success: true,
            message: 'No products with SKUs found to sync',
            synced: 0
        };
    }

    // Build GMC products
    const products = result.rows.map(row => buildGmcProduct(row, settings));

    // Batch sync in chunks of 100
    const BATCH_SIZE = 100;
    let totalSucceeded = 0;
    let totalFailed = 0;
    const allErrors = [];

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);

        try {
            const batchResult = await batchUpsertProducts({
                merchantId,
                gmcMerchantId,
                products: batch
            });

            totalSucceeded += batchResult.succeeded;
            totalFailed += batchResult.failed;
            allErrors.push(...batchResult.errors);
        } catch (error) {
            totalFailed += batch.length;
            allErrors.push({ error: error.message, batch: i / BATCH_SIZE });
        }
    }

    logger.info('Product catalog sync completed', {
        merchantId,
        total: products.length,
        succeeded: totalSucceeded,
        failed: totalFailed
    });

    return {
        success: totalFailed === 0,
        total: products.length,
        synced: totalSucceeded,
        failed: totalFailed,
        errors: allErrors.slice(0, 10)
    };
}

// ==================== LOCAL INVENTORY SYNC ====================

/**
 * Batch update local inventory for multiple products
 * Uses the Content API batch endpoint for efficiency
 */
async function batchUpdateLocalInventory(options) {
    const { merchantId, gmcMerchantId, storeCode, items } = options;

    const auth = await getAuthClient(merchantId);
    const content = google.content({ version: 'v2.1', auth });

    // Build batch entries
    const entries = items.map((item, index) => ({
        batchId: index,
        merchantId: gmcMerchantId,
        method: 'insert',
        productId: `online:en:CA:${item.productId}`,
        localInventory: {
            storeCode: storeCode,
            availability: item.quantity > 0 ? 'in_stock' : 'out_of_stock',
            quantity: item.quantity.toString()
        }
    }));

    try {
        const response = await content.localinventory.custombatch({
            requestBody: { entries }
        });

        const results = {
            success: true,
            total: entries.length,
            succeeded: 0,
            failed: 0,
            errors: []
        };

        // Process results
        for (const entry of response.data.entries || []) {
            if (entry.errors && entry.errors.length > 0) {
                results.failed++;
                results.errors.push({
                    batchId: entry.batchId,
                    productId: items[entry.batchId]?.productId,
                    errors: entry.errors
                });
            } else {
                results.succeeded++;
            }
        }

        logger.info('Batch updated local inventory in GMC', {
            merchantId,
            gmcMerchantId,
            storeCode,
            total: results.total,
            succeeded: results.succeeded,
            failed: results.failed
        });

        return results;
    } catch (error) {
        logger.error('Failed to batch update local inventory in GMC', {
            error: error.message,
            merchantId,
            gmcMerchantId,
            storeCode
        });
        throw error;
    }
}

/**
 * Sync all local inventory for a specific location to GMC
 */
async function syncLocationInventory(options) {
    const { merchantId, locationId } = options;

    // Get GMC settings
    const settings = await getGmcApiSettings(merchantId);
    const gmcMerchantId = settings.gmc_merchant_id;

    if (!gmcMerchantId) {
        throw new Error('Google Merchant Center ID not configured. Go to Settings to add your Merchant Center ID.');
    }

    // Get location settings (store code)
    const locationResult = await db.query(`
        SELECT
            l.id,
            l.name as location_name,
            COALESCE(gls.google_store_code, l.id) as store_code
        FROM locations l
        LEFT JOIN gmc_location_settings gls ON l.id = gls.location_id AND gls.merchant_id = $1
        WHERE l.id = $2 AND l.merchant_id = $1
    `, [merchantId, locationId]);

    if (locationResult.rows.length === 0) {
        throw new Error(`Location ${locationId} not found`);
    }

    const location = locationResult.rows[0];

    // Get inventory data for this location
    const inventoryResult = await db.query(`
        SELECT
            v.id as variation_id,
            COALESCE(v.sku, v.upc, v.id) as product_id,
            COALESCE(
                (SELECT SUM(ic.quantity)
                 FROM inventory_counts ic
                 WHERE ic.catalog_object_id = v.id
                   AND ic.state = 'IN_STOCK'
                   AND ic.merchant_id = $1
                   AND ic.location_id = $2
                ), 0
            )::integer as quantity
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        WHERE v.is_deleted = FALSE
          AND i.is_deleted = FALSE
          AND i.available_online = TRUE
          AND v.merchant_id = $1
          AND v.sku IS NOT NULL
    `, [merchantId, locationId]);

    if (inventoryResult.rows.length === 0) {
        return {
            success: true,
            location: location.location_name,
            storeCode: location.store_code,
            message: 'No products with SKUs found to sync',
            synced: 0
        };
    }

    // Prepare items for batch update
    const items = inventoryResult.rows.map(row => ({
        productId: row.product_id,
        quantity: row.quantity
    }));

    // Batch update in chunks of 100 (API limit)
    const BATCH_SIZE = 100;
    let totalSucceeded = 0;
    let totalFailed = 0;
    const allErrors = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        try {
            const result = await batchUpdateLocalInventory({
                merchantId,
                gmcMerchantId,
                storeCode: location.store_code,
                items: batch
            });

            totalSucceeded += result.succeeded;
            totalFailed += result.failed;
            allErrors.push(...result.errors);
        } catch (error) {
            // If batch fails entirely, count all as failed
            totalFailed += batch.length;
            allErrors.push({ error: error.message, batch: i / BATCH_SIZE });
        }
    }

    return {
        success: totalFailed === 0,
        location: location.location_name,
        storeCode: location.store_code,
        total: items.length,
        synced: totalSucceeded,
        failed: totalFailed,
        errors: allErrors.slice(0, 10) // Limit error details
    };
}

/**
 * Sync all locations' inventory to GMC
 */
async function syncAllLocationsInventory(merchantId) {
    // Get all enabled locations
    const locationsResult = await db.query(`
        SELECT
            l.id,
            l.name,
            COALESCE(gls.google_store_code, l.id) as store_code,
            COALESCE(gls.enabled, true) as enabled
        FROM locations l
        LEFT JOIN gmc_location_settings gls ON l.id = gls.location_id AND gls.merchant_id = $1
        WHERE l.merchant_id = $1 AND l.active = true
        ORDER BY l.name
    `, [merchantId]);

    const results = {
        success: true,
        locations: [],
        totalSynced: 0,
        totalFailed: 0
    };

    for (const location of locationsResult.rows) {
        if (!location.enabled) {
            results.locations.push({
                locationId: location.id,
                locationName: location.name,
                skipped: true,
                reason: 'Location disabled for GMC'
            });
            continue;
        }

        try {
            const syncResult = await syncLocationInventory({
                merchantId,
                locationId: location.id
            });

            results.locations.push({
                locationId: location.id,
                locationName: location.name,
                storeCode: location.store_code,
                ...syncResult
            });

            results.totalSynced += syncResult.synced || 0;
            results.totalFailed += syncResult.failed || 0;
        } catch (error) {
            results.locations.push({
                locationId: location.id,
                locationName: location.name,
                error: error.message
            });
            results.success = false;
        }
    }

    return results;
}

/**
 * Update local inventory for a single product at a specific store
 */
async function updateLocalInventory(options) {
    const { merchantId, gmcMerchantId, storeCode, productId, quantity, availability } = options;

    const auth = await getAuthClient(merchantId);
    const content = google.content({ version: 'v2.1', auth });

    const inventoryAvailability = availability || (quantity > 0 ? 'in_stock' : 'out_of_stock');

    const localInventory = {
        storeCode: storeCode,
        availability: inventoryAvailability,
        quantity: quantity.toString()
    };

    try {
        const response = await content.localinventory.insert({
            merchantId: gmcMerchantId,
            productId: `online:en:CA:${productId}`,
            requestBody: localInventory
        });

        logger.info('Updated local inventory in GMC', {
            merchantId,
            gmcMerchantId,
            storeCode,
            productId
        });

        return { success: true, data: response.data };
    } catch (error) {
        logger.error('Failed to update local inventory in GMC', {
            error: error.message,
            merchantId,
            gmcMerchantId,
            storeCode,
            productId
        });
        throw error;
    }
}

/**
 * Test GMC API connection
 */
async function testConnection(merchantId) {
    try {
        const settings = await getGmcApiSettings(merchantId);
        const gmcMerchantId = settings.gmc_merchant_id;

        if (!gmcMerchantId) {
            return {
                success: false,
                error: 'Merchant Center ID not configured'
            };
        }

        const auth = await getAuthClient(merchantId);
        const content = google.content({ version: 'v2.1', auth });

        // Try to get account info
        const response = await content.accounts.get({
            merchantId: gmcMerchantId,
            accountId: gmcMerchantId
        });

        return {
            success: true,
            accountName: response.data.name,
            accountId: response.data.id
        };
    } catch (error) {
        logger.error('GMC API connection test failed', { error: error.message, merchantId });
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    // Settings
    getGmcApiSettings,
    saveGmcApiSettings,
    // Product catalog sync
    upsertProduct,
    batchUpsertProducts,
    syncProductCatalog,
    // Local inventory sync
    updateLocalInventory,
    batchUpdateLocalInventory,
    syncLocationInventory,
    syncAllLocationsInventory,
    // Utilities
    testConnection
};
