/**
 * Google Merchant Center API Service (Multi-Tenant)
 *
 * Handles direct API calls to push products to GMC.
 * Provides:
 * - Product catalog sync to GMC
 * - OAuth2 token management and refresh
 * - Sync logging and history
 * - Connection testing
 *
 * Uses the NEW Merchant API (replacing deprecated Content API)
 * https://developers.google.com/merchant/api
 *
 * This service was extracted from utils/merchant-center-api.js as part of P1-3.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getAuthenticatedClient } = require('../../utils/google-auth');

// LOGIC CHANGE: use centralized retry config from constants (C-1)
const { RETRY: { MAX_ATTEMPTS: MAX_RETRIES, BASE_DELAY_MS: RETRY_DELAY_MS } } = require('../../config/constants');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get OAuth2 client for a merchant
 * LOGIC CHANGE: delegate to google-auth.js:getAuthenticatedClient (GMC-BUG-001)
 * Previously read tokens from DB without decrypting — since SEC-6 added AES-256-GCM
 * encryption, ciphertext was sent to Google as Bearer token causing 401.
 * google-auth.js correctly decrypts tokens on load and encrypts on refresh/save.
 */
async function getAuthClient(merchantId) {
    return getAuthenticatedClient(merchantId);
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
    const entries = Object.entries(settings);
    if (entries.length === 0) return;

    const keys = entries.map(([k]) => k);
    const values = entries.map(([, v]) => v);

    await db.query(`
        INSERT INTO gmc_settings (merchant_id, setting_key, setting_value)
        SELECT $1, UNNEST($2::text[]), UNNEST($3::text[])
        ON CONFLICT (merchant_id, setting_key)
        DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `, [merchantId, keys, values]);
}

// ==================== SYNC LOGGING ====================

/**
 * Create a sync log entry (call at start of sync)
 */
async function createSyncLog(options) {
    const { merchantId, syncType, locationId, locationName } = options;

    const result = await db.query(`
        INSERT INTO gmc_sync_logs (merchant_id, sync_type, status, location_id, location_name, started_at)
        VALUES ($1, $2, 'in_progress', $3, $4, NOW())
        RETURNING id
    `, [merchantId, syncType, locationId || null, locationName || null]);

    return result.rows[0].id;
}

/**
 * Update a sync log entry (call at end of sync)
 */
async function updateSyncLog(logId, results) {
    const { status, total, succeeded, failed, errors } = results;

    await db.query(`
        UPDATE gmc_sync_logs
        SET status = $2,
            total_items = $3,
            succeeded = $4,
            failed = $5,
            error_details = $6,
            completed_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
        WHERE id = $1
    `, [logId, status, total || 0, succeeded || 0, failed || 0, JSON.stringify(errors || [])]);
}

/**
 * Get sync history for a merchant
 */
async function getSyncHistory(merchantId, limit = 20) {
    const result = await db.query(`
        SELECT
            id,
            sync_type,
            status,
            total_items,
            succeeded,
            failed,
            error_details,
            location_id,
            location_name,
            started_at,
            completed_at,
            duration_ms
        FROM gmc_sync_logs
        WHERE merchant_id = $1
        ORDER BY started_at DESC
        LIMIT $2
    `, [merchantId, limit]);

    return result.rows;
}

/**
 * Get the last sync status for each sync type
 */
async function getLastSyncStatus(merchantId) {
    const result = await db.query(`
        SELECT DISTINCT ON (sync_type)
            sync_type,
            status,
            total_items,
            succeeded,
            failed,
            started_at,
            completed_at,
            duration_ms
        FROM gmc_sync_logs
        WHERE merchant_id = $1
        ORDER BY sync_type, started_at DESC
    `, [merchantId]);

    const statusMap = {};
    for (const row of result.rows) {
        statusMap[row.sync_type] = row;
    }
    return statusMap;
}

// ==================== MERCHANT API HELPERS ====================

/**
 * Make authenticated request to Merchant API
 * The new Merchant API uses REST endpoints directly
 */
async function merchantApiRequest(auth, method, path, body = null) {
    const baseUrl = 'https://merchantapi.googleapis.com';
    const url = `${baseUrl}${path}`;

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const headers = {
            'Authorization': `Bearer ${(await auth.getAccessToken()).token}`,
            'Content-Type': 'application/json'
        };

        const options = {
            method,
            headers
        };

        if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, options);

            // Handle rate limiting (429) — retryable
            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
                lastError = new Error(`GMC API rate limited after ${MAX_RETRIES} attempts`);
                lastError.status = 429;
                logger.warn('GMC API rate limited, retrying', {
                    attempt: attempt + 1,
                    retryAfterSeconds: retryAfter,
                    method,
                    path
                });
                await sleep(retryAfter * 1000);
                continue;
            }

            const data = await response.json();

            if (!response.ok) {
                const error = new Error(data.error?.message || `API error: ${response.status}`);
                error.status = response.status;
                error.details = data.error;

                // Don't retry client errors (4xx) other than 429
                if (response.status >= 400 && response.status < 500) {
                    throw error;
                }

                // Server errors (5xx) are retryable
                lastError = error;
                if (attempt < MAX_RETRIES - 1) {
                    const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                    logger.warn('GMC API server error, retrying', {
                        attempt: attempt + 1,
                        delayMs: delay,
                        status: response.status,
                        path
                    });
                    await sleep(delay);
                    continue;
                }
                throw lastError;
            }

            return data;
        } catch (error) {
            lastError = error;

            // Don't retry non-retryable errors (client errors already thrown above)
            if (error.status && error.status >= 400 && error.status < 500) {
                throw error;
            }

            // Network errors are retryable
            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                logger.warn('GMC API request failed, retrying', {
                    attempt: attempt + 1,
                    delayMs: delay,
                    error: error.message,
                    path
                });
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

/**
 * Get data source info from GMC to check its configuration
 */
async function getDataSourceInfo(merchantId, gmcMerchantId, dataSourceId) {
    // LOGIC CHANGE: moved path declaration before try so catch block can reference it
    let path;
    try {
        const auth = await getAuthClient(merchantId);
        path = `/datasources/v1/accounts/${gmcMerchantId}/dataSources/${dataSourceId}`;
        const response = await merchantApiRequest(auth, 'GET', path);
        logger.info('GMC Data Source info', {
            dataSourceId,
            response: JSON.stringify(response, null, 2)
        });
        return response;
    } catch (error) {
        logger.error('Failed to get data source info', {
            error: error.message,
            stack: error.stack,
            url: path ? `https://merchantapi.googleapis.com${path}` : 'N/A',
            httpStatus: error.status || 'N/A',
            responseBody: error.details ? JSON.stringify(error.details).substring(0, 500) : 'N/A'
        });
        return null;
    }
}

// ==================== PRODUCT CATALOG SYNC ====================

// LOGIC CHANGE: removed write-only debug files and shared module state (MT-4, MT-13)

/**
 * Insert or update a single product in GMC using Merchant API
 * @param {Object} options - Options including merchantId, gmcMerchantId, dataSourceId, product, channel
 */
async function upsertProduct(options) {
    const { merchantId, gmcMerchantId, dataSourceId, product, channel = 'ONLINE' } = options;

    const auth = await getAuthClient(merchantId);

    // LOGIC CHANGE: moved apiPath declaration before try so catch block can reference it
    let apiPath;
    try {
        // dataSource must be passed as query parameter, not in body
        const dataSourceName = `accounts/${gmcMerchantId}/dataSources/${dataSourceId}`;
        apiPath = `/products/v1/accounts/${gmcMerchantId}/productInputs:insert?dataSource=${encodeURIComponent(dataSourceName)}`;

        // Convert to Merchant API format (without dataSource in body)
        const productInput = buildMerchantApiProduct(product, gmcMerchantId, channel);

        const response = await merchantApiRequest(auth, 'POST', apiPath, productInput);

        return { success: true, data: response };
    } catch (error) {
        logger.error('Failed to upsert product in GMC', {
            error: error.message,
            merchantId,
            productId: product.offerId,
            channel,
            feedLabel: product.feedLabel || '(not set)',
            contentLanguage: product.contentLanguage || '(not set)',
            url: apiPath ? `https://merchantapi.googleapis.com${apiPath}` : 'N/A',
            httpStatus: error.status || 'N/A',
            responseBody: error.details ? JSON.stringify(error.details).substring(0, 500) : 'N/A'
        });
        throw error;
    }
}

/**
 * Batch insert/update products in GMC
 * Note: New Merchant API doesn't have a batch endpoint like the old one,
 * so we process products individually but in parallel
 *
 * @param {Object} options - Options including merchantId, gmcMerchantId, dataSourceId, products, channel
 */
async function batchUpsertProducts(options) {
    const { merchantId, gmcMerchantId, dataSourceId, products, channel = 'ONLINE' } = options;

    const results = {
        success: true,
        total: products.length,
        succeeded: 0,
        failed: 0,
        errors: []
    };

    // Process in parallel with concurrency limit
    const CONCURRENCY = 10;
    for (let i = 0; i < products.length; i += CONCURRENCY) {
        const batch = products.slice(i, i + CONCURRENCY);
        const promises = batch.map(async (product, idx) => {
            try {
                await upsertProduct({ merchantId, gmcMerchantId, dataSourceId, product, channel });
                return { success: true, index: i + idx };
            } catch (error) {
                return {
                    success: false,
                    index: i + idx,
                    error: error.message,
                    offerId: product.offerId
                };
            }
        });

        const batchResults = await Promise.all(promises);
        for (const result of batchResults) {
            if (result.success) {
                results.succeeded++;
            } else {
                results.failed++;
                results.errors.push({
                    offerId: result.offerId,
                    error: result.error
                });
            }
        }
    }

    return results;
}

/**
 * Build Merchant API product input from our product data
 * Merchant API uses a different structure than Content API
 * Note: dataSource is passed as query param, not in body
 *
 * IMPORTANT: feedLabel and contentLanguage must match the data source configuration:
 * - If data source has feedLabel/contentLanguage SET, products must match exactly
 * - If data source has them UNSET, products can have any value OR omit them
 *
 * @param {Object} product - Product data
 * @param {string} gmcMerchantId - GMC merchant ID
 * @param {string} channel - Channel: 'ONLINE' or 'LOCAL' (default: 'ONLINE')
 */
function buildMerchantApiProduct(product, gmcMerchantId, channel = 'ONLINE') {
    // Merchant API productInput format
    // https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs
    const productInput = {
        offerId: product.offerId,
        channel: channel.toUpperCase(),
        attributes: {
            title: product.title,
            description: product.description,
            link: product.link,
            imageLink: product.imageLink,
            availability: product.availability === 'in_stock' ? 'in_stock' : 'out_of_stock',
            condition: product.condition || 'new',
            price: {
                amountMicros: Math.round(parseFloat(product.price.value) * 1000000).toString(),
                currencyCode: product.price.currency
            },
            gtin: product.gtin || undefined,
            brand: product.brand || undefined,
            googleProductCategory: product.googleProductCategory || undefined
        }
    };

    // Only include feedLabel if explicitly set (not empty)
    // If data source has feedLabel unset, omitting it should work
    if (product.feedLabel) {
        productInput.feedLabel = product.feedLabel;
    }

    // Only include contentLanguage if explicitly set (not empty)
    if (product.contentLanguage) {
        productInput.contentLanguage = product.contentLanguage;
    }

    return productInput;
}

/**
 * Build GMC product object from database product data (internal format)
 *
 * IMPORTANT: feedLabel and contentLanguage are OPTIONAL
 * - Only set them if explicitly configured in settings
 * - If data source has them unset, omitting them allows products to sync without restriction
 * - If data source has them set, they must match exactly
 *
 * @param {Object} row - Database row with product data
 * @param {Object} settings - GMC settings
 * @param {string} channel - Channel: 'online' or 'local' (default: 'online')
 */
function buildGmcProduct(row, settings, channel = 'online') {
    const baseUrl = settings.website_base_url || 'https://example.com';
    const currency = settings.currency || 'CAD';

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
        channel: channel.toLowerCase(),
        availability: row.quantity > 0 ? 'in_stock' : 'out_of_stock',
        condition: settings.default_condition || 'new',
        price: {
            value: (row.price_money / 100).toFixed(2),
            currency: currency
        }
    };

    // Only set feedLabel if explicitly configured (not falling back to defaults)
    // This allows syncing to data sources that have feedLabel unset
    if (settings.feed_label) {
        product.feedLabel = settings.feed_label;
    }

    // Only set contentLanguage if explicitly configured
    if (settings.content_language) {
        product.contentLanguage = settings.content_language;
    }

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
    // Create sync log entry
    const logId = await createSyncLog({
        merchantId,
        syncType: 'product_catalog'
    });

    try {
        const settings = await getGmcApiSettings(merchantId);
        const gmcMerchantId = settings.gmc_merchant_id;
        const dataSourceId = settings.gmc_data_source_id;

        if (!gmcMerchantId) {
            await updateSyncLog(logId, {
                status: 'failed',
                total: 0,
                succeeded: 0,
                failed: 0,
                errors: [{ error: 'Google Merchant Center ID not configured' }]
            });
            throw new Error('Google Merchant Center ID not configured');
        }

        if (!dataSourceId) {
            await updateSyncLog(logId, {
                status: 'failed',
                total: 0,
                succeeded: 0,
                failed: 0,
                errors: [{ error: 'Data Source ID not configured. Add your GMC Data Source ID in Settings.' }]
            });
            throw new Error('Data Source ID not configured. Add your GMC Data Source ID in Settings.');
        }

        // Log settings being used for debugging
        logger.info('GMC sync settings', {
            merchantId,
            gmcMerchantId,
            dataSourceId,
            feedLabel: settings.feed_label || '(not set)',
            contentLanguage: settings.content_language || '(not set)'
        });

        // Try to get data source info to verify configuration
        const dataSourceInfo = await getDataSourceInfo(merchantId, gmcMerchantId, dataSourceId);
        if (dataSourceInfo) {
            logger.info('Data source configuration from GMC', { dataSourceInfo });
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
             WHERE img.id = i.images->>0
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
            await updateSyncLog(logId, {
                status: 'success',
                total: 0,
                succeeded: 0,
                failed: 0,
                errors: []
            });
            return {
                success: true,
                message: 'No products with SKUs found to sync',
                synced: 0
            };
        }

        // Build GMC products for ONLINE channel
        const products = result.rows.map(row => buildGmcProduct(row, settings, 'online'));

        // Sync to ONLINE channel only
        // (Local inventory is handled via TSV feed which references products by offer ID)
        logger.info('Syncing products to ONLINE channel...', { count: products.length });
        const syncResult = await batchUpsertProducts({
            merchantId,
            gmcMerchantId,
            dataSourceId,
            products,
            channel: 'ONLINE'
        });

        const totalProducts = products.length;

        logger.info('Product catalog sync completed', {
            merchantId,
            totalProducts,
            succeeded: syncResult.succeeded,
            failed: syncResult.failed
        });

        // Log sync completion
        await updateSyncLog(logId, {
            status: syncResult.failed === 0 ? 'success' : (syncResult.succeeded > 0 ? 'partial' : 'failed'),
            total: totalProducts,
            succeeded: syncResult.succeeded,
            failed: syncResult.failed,
            errors: syncResult.errors.slice(0, 10)
        });

        return {
            success: syncResult.failed === 0,
            total: totalProducts,
            synced: syncResult.succeeded,
            failed: syncResult.failed,
            errors: syncResult.errors.slice(0, 10)
        };

    } catch (error) {
        // Log sync failure
        await updateSyncLog(logId, {
            status: 'failed',
            total: 0,
            succeeded: 0,
            failed: 0,
            errors: [{ error: error.message }]
        });
        throw error;
    }
}

/**
 * Test GMC API connection using new Merchant API
 */
async function testConnection(merchantId) {
    let apiPath;
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

        // LOGIC CHANGE: v1beta → v1 (BACKLOG-61 — Google deprecated v1beta Feb 28 2026)
        // GET /accounts/v1/accounts/{account}
        apiPath = `/accounts/v1/accounts/${gmcMerchantId}`;
        const path = apiPath;

        const response = await merchantApiRequest(auth, 'GET', path);

        return {
            success: true,
            accountName: response.accountName || response.name,
            accountId: gmcMerchantId
        };
    } catch (error) {
        logger.error('GMC API connection test failed', {
            error: error.message,
            stack: error.stack,
            merchantId,
            url: apiPath ? `https://merchantapi.googleapis.com${apiPath}` : 'N/A',
            httpStatus: error.status || 'N/A',
            responseBody: error.details ? JSON.stringify(error.details).substring(0, 500) : 'N/A'
        });
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
    // Sync history/status
    getSyncHistory,
    getLastSyncStatus,
    // Data source info
    getDataSourceInfo,
    // Product catalog sync (ONLINE channel only)
    upsertProduct,
    batchUpsertProducts,
    syncProductCatalog,
    // Utilities
    testConnection
    // Note: Local inventory sync removed - use TSV feed instead
    // (/api/gmc/local-inventory-feed.tsv?token=xxx)
};
