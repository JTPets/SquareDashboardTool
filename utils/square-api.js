/**
 * Square API Integration Module
 * Handles all Square API calls and data synchronization
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('./database');
const logger = require('./logger');
const { decryptToken, isEncryptedToken, encryptToken } = require('./token-encryption');

// Square API configuration
const SQUARE_API_VERSION = '2025-10-16';
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// Rate limiting and retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Cache for merchants without INVOICES_READ scope (avoid repeated API calls and log spam)
// Map<merchantId, timestamp> - expires after 1 hour
const merchantsWithoutInvoicesScope = new Map();
const INVOICES_SCOPE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Prune expired cache entries to prevent memory leaks
function pruneInvoicesScopeCache() {
    const now = Date.now();
    for (const [merchantId, timestamp] of merchantsWithoutInvoicesScope) {
        if (now - timestamp > INVOICES_SCOPE_CACHE_TTL) {
            merchantsWithoutInvoicesScope.delete(merchantId);
        }
    }
}

// Run cache pruning every hour
setInterval(pruneInvoicesScopeCache, INVOICES_SCOPE_CACHE_TTL);

/**
 * Get decrypted access token for a merchant
 * @param {number} merchantId - The merchant ID (REQUIRED)
 * @returns {Promise<string>} Decrypted access token
 */
async function getMerchantToken(merchantId) {
    // NOTE: Legacy single-tenant fallback removed (2026-01-05)
    // merchantId is now required - no more fallback to ACCESS_TOKEN env var
    if (!merchantId) {
        throw new Error('merchantId is required - legacy single-tenant mode removed');
    }

    const result = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (result.rows.length === 0) {
        throw new Error(`Merchant ${merchantId} not found or inactive`);
    }

    const token = result.rows[0].square_access_token;

    if (!token) {
        throw new Error(`Merchant ${merchantId} has no access token configured`);
    }

    // Check if token is encrypted - if not, it's a legacy unencrypted token
    if (!isEncryptedToken(token)) {
        logger.warn('Found unencrypted legacy token, encrypting for future use', { merchantId });
        // Token is not encrypted - this is a legacy token
        // Encrypt it and save for next time, but return the raw token for this request
        try {
            const encryptedToken = encryptToken(token);
            await db.query(
                'UPDATE merchants SET square_access_token = $1 WHERE id = $2',
                [encryptedToken, merchantId]
            );
            logger.info('Legacy token encrypted and saved', { merchantId });
        } catch (encryptError) {
            logger.error('Failed to encrypt legacy token', { merchantId, error: encryptError.message });
        }
        return token; // Return the raw token for this request
    }

    return decryptToken(token);
}

/**
 * Generate a unique idempotency key for Square API requests
 * Uses crypto.randomUUID() for guaranteed uniqueness
 * @param {string} prefix - Prefix to identify the operation type
 * @returns {string} Unique idempotency key
 */
function generateIdempotencyKey(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Make a Square API request with error handling and retry logic
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options (can include accessToken for multi-tenant)
 * @returns {Promise<Object>} Response data
 */
async function makeSquareRequest(endpoint, options = {}) {
    const url = `${SQUARE_BASE_URL}${endpoint}`;
    // NOTE: Legacy single-tenant fallback removed (2026-01-05)
    // accessToken is now required for all requests
    const token = options.accessToken;
    if (!token) {
        throw new Error('accessToken is required in options - legacy single-tenant mode removed');
    }
    const headers = {
        'Square-Version': SQUARE_API_VERSION,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    // Remove accessToken from options so it doesn't get passed to fetch
    delete options.accessToken;

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers
            });

            const data = await response.json();

            if (!response.ok) {
                // Handle rate limiting - this is retryable
                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '5');
                    logger.warn(`Rate limited. Retrying after ${retryAfter} seconds`);
                    await sleep(retryAfter * 1000);
                    continue;
                }

                // Handle auth errors - don't retry
                if (response.status === 401) {
                    throw new Error('Square API authentication failed. Check your access token.');
                }

                // Check for non-retryable errors (idempotency conflicts, version conflicts, validation errors)
                const errorCodes = (data.errors || []).map(e => e.code);
                const nonRetryableErrors = [
                    'IDEMPOTENCY_KEY_REUSED',
                    'VERSION_MISMATCH',
                    'CONFLICT',
                    'INVALID_REQUEST_ERROR'
                ];
                const hasNonRetryableError = errorCodes.some(code => nonRetryableErrors.includes(code));

                // Don't retry 400/409 errors or specific non-retryable error codes
                if (response.status === 400 || response.status === 409 || hasNonRetryableError) {
                    // Throw immediately without retry by breaking out of the loop
                    const err = new Error(`Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`);
                    err.nonRetryable = true;
                    throw err;
                }

                throw new Error(`Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`);
            }

            return data;
        } catch (error) {
            lastError = error;

            // Don't retry non-retryable errors
            if (error.nonRetryable) {
                throw error;
            }

            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                logger.warn(`Request failed, retrying in ${delay}ms`, { attempt: attempt + 1, max_retries: MAX_RETRIES });
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

/**
 * Sleep utility for delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sync locations from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of locations synced
 */
async function syncLocations(merchantId) {
    logger.info('Starting location sync', { merchantId });

    try {
        // Get merchant-specific token
        const accessToken = await getMerchantToken(merchantId);
        const data = await makeSquareRequest('/v2/locations', { accessToken });
        const locations = data.locations || [];

        let synced = 0;
        for (const loc of locations) {
            await db.query(`
                INSERT INTO locations (id, name, square_location_id, active, address, timezone, merchant_id, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    square_location_id = EXCLUDED.square_location_id,
                    active = EXCLUDED.active,
                    address = EXCLUDED.address,
                    timezone = EXCLUDED.timezone,
                    merchant_id = EXCLUDED.merchant_id,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                loc.id,
                loc.name,
                loc.id,
                loc.status === 'ACTIVE',
                loc.address ? JSON.stringify(loc.address) : null,
                loc.timezone,
                merchantId
            ]);
            synced++;
        }

        logger.info('Location sync complete', { merchantId, count: synced });
        return synced;
    } catch (error) {
        logger.error('Location sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync vendors from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of vendors synced
 */
async function syncVendors(merchantId) {
    logger.info('Starting vendor sync', { merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);
        let cursor = null;
        let totalSynced = 0;

        do {
            const requestBody = {
                filter: {
                    status: ['ACTIVE', 'INACTIVE']  // ✅ CORRECT (singular, not plural)
                },
                limit: 100  // Add for better performance
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/vendors/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });

            const vendors = data.vendors || [];

            for (const vendor of vendors) {
                await db.query(`
                    INSERT INTO vendors (
                        id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        status = EXCLUDED.status,
                        contact_name = EXCLUDED.contact_name,
                        contact_email = EXCLUDED.contact_email,
                        contact_phone = EXCLUDED.contact_phone,
                        merchant_id = EXCLUDED.merchant_id,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    vendor.id,
                    vendor.name,
                    vendor.status,
                    vendor.contacts?.[0]?.name || null,
                    vendor.contacts?.[0]?.email_address || null,
                    vendor.contacts?.[0]?.phone_number || null,
                    merchantId
                ]);
                totalSynced++;
            }

            cursor = data.cursor;
            logger.info('Vendor sync progress', { merchantId, count: totalSynced });

        } while (cursor);

        logger.info('Vendor sync complete', { merchantId, count: totalSynced });
        return totalSynced;
    } catch (error) {
        logger.error('Vendor sync failed', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync catalog (categories, images, items, variations) from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<Object>} Sync statistics
 */
async function syncCatalog(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for syncCatalog');
    }
    logger.info('Starting catalog sync', { merchantId });

    // Note: merchantId is passed as parameter - no global variable needed

    const stats = {
        categories: 0,
        images: 0,
        items: 0,
        variations: 0,
        variationVendors: 0,
        items_deleted: 0,
        variations_deleted: 0,
        inventory_zeroed: 0
    };

    // Track all IDs returned by Square API
    const syncedItemIds = new Set();
    const syncedVariationIds = new Set();

    // Build maps for all catalog objects (like legacy exp_tracker approach)
    const itemsMap = new Map();
    const variationsMap = new Map();
    const imagesMap = new Map();
    const categoriesMap = new Map();

    try {
        const accessToken = await getMerchantToken(merchantId);
        let cursor = null;

        // Fetch ALL catalog objects in one pass - building maps first
        // Use include_related_objects=true to get category associations
        logger.info('Starting catalog fetch', { merchantId });
        do {
            const endpoint = `/v2/catalog/list?types=ITEM,ITEM_VARIATION,IMAGE,CATEGORY&include_deleted_objects=false&include_related_objects=true${cursor ? `&cursor=${cursor}` : ''}`;
            const data = await makeSquareRequest(endpoint, { accessToken });

            const objects = data.objects || [];
            const relatedObjects = data.related_objects || [];

            // Process related objects first (includes categories linked to items)
            for (const obj of relatedObjects) {
                if (obj.type === 'CATEGORY') {
                    const categoryName = obj.category_data?.name || obj.name || 'Uncategorized';
                    categoriesMap.set(obj.id, { name: categoryName });
                }
            }

            // Build maps (don't insert to DB yet - just collect)
            for (const obj of objects) {
                switch (obj.type) {
                    case 'ITEM':
                        // Store full object to preserve top-level fields like present_at_all_locations
                        itemsMap.set(obj.id, obj);
                        break;
                    case 'ITEM_VARIATION':
                        // Store full object to preserve custom_attribute_values and other top-level fields
                        variationsMap.set(obj.id, obj);
                        break;
                    case 'IMAGE':
                        imagesMap.set(obj.id, obj.image_data);
                        break;
                    case 'CATEGORY':
                        // Normalize category structure to always have .name as direct property
                        const categoryName = obj.category_data?.name || obj.name || 'Uncategorized';
                        categoriesMap.set(obj.id, { name: categoryName });
                        break;
                }
            }

            cursor = data.cursor;

        } while (cursor);

        // Log category details for debugging
        const categoryList = Array.from(categoriesMap.entries()).map(([id, cat]) => ({
            id: id.substring(0, 20) + '...',
            name: cat.name
        }));
        logger.info('All catalog objects fetched', {
            items: itemsMap.size,
            variations: variationsMap.size,
            images: imagesMap.size,
            categories: categoriesMap.size,
            categoryNames: categoryList.slice(0, 10) // Log first 10 categories for debugging
        });

        // Now process the maps - insert to database

        // 1. Insert categories first
        for (const [id, cat] of categoriesMap) {
            try {
                await syncCategory({ id, category_data: cat }, merchantId);
                stats.categories++;
            } catch (error) {
                logger.error('Failed to sync category', { id, error: error.message });
            }
        }
        logger.info('Categories synced', { count: stats.categories });

        // 2. Insert images
        for (const [id, img] of imagesMap) {
            try {
                await syncImage({ id, image_data: img }, merchantId);
                stats.images++;
            } catch (error) {
                logger.error('Failed to sync image', { id, error: error.message });
            }
        }

        // 3. Insert items with category names looked up from map
        for (const [id, itemObj] of itemsMap) {
            try {
                const itemData = itemObj.item_data;

                // Handle category assignment - check both deprecated category_id and newer categories array
                let categoryId = null;
                let categoryName = null;

                // First check the newer 'categories' array (preferred)
                if (itemData.categories && itemData.categories.length > 0) {
                    // Use the first category (primary category)
                    categoryId = itemData.categories[0].id;
                    categoryName = categoriesMap.get(categoryId)?.name || null;
                }

                // Fallback to deprecated 'category_id' field if no categories array
                if (!categoryId && itemData.category_id) {
                    categoryId = itemData.category_id;
                    categoryName = categoriesMap.get(categoryId)?.name || null;
                }

                // Also check 'reporting_category' as another fallback
                if (!categoryId && itemData.reporting_category?.id) {
                    categoryId = itemData.reporting_category.id;
                    categoryName = categoriesMap.get(categoryId)?.name || null;
                }

                // Update the itemObj with resolved category info for syncItem
                itemObj.item_data.category_id = categoryId;

                await syncItem(itemObj, categoryName, merchantId);
                stats.items++;
                syncedItemIds.add(id);
            } catch (error) {
                logger.error('Failed to sync item', { id, error: error.message });
            }
        }
        logger.info('Items synced', { count: stats.items });

        // 4. Insert variations
        for (const [id, varObj] of variationsMap) {
            try {
                const varData = varObj.item_variation_data;
                if (!itemsMap.has(varData.item_id)) {
                    logger.warn('Skipping variation - parent item not found', {
                        variation_id: id,
                        item_id: varData.item_id
                    });
                    continue;
                }
                // Pass full object to preserve custom_attribute_values
                const vendorCount = await syncVariation(varObj, merchantId);
                stats.variations++;
                stats.variationVendors += vendorCount;
                syncedVariationIds.add(id);
            } catch (error) {
                logger.error('Failed to sync variation', { id, error: error.message });
            }
        }

        logger.info('Catalog sync complete', stats);

        // ===== DETECT DELETIONS =====
        logger.info('Detecting deleted items');

        // Get all non-deleted items from database FOR THIS MERCHANT ONLY
        const dbItemsResult = await db.query(`
            SELECT id, name FROM items WHERE is_deleted = FALSE AND merchant_id = $1
        `, [merchantId]);

        const dbVariationsResult = await db.query(`
            SELECT id, name, sku FROM variations WHERE is_deleted = FALSE AND merchant_id = $1
        `, [merchantId]);

        // SAFEGUARD: Skip deletion detection if sync returned suspiciously few items
        // This prevents API errors or empty responses from causing mass deletion
        const syncedItemCount = syncedItemIds.size;
        const dbItemCount = dbItemsResult.rows.length;
        const deletionThreshold = 0.5; // If more than 50% would be deleted, something is wrong

        if (syncedItemCount === 0 && dbItemCount > 0) {
            logger.warn('SKIPPING deletion detection: sync returned 0 items but database has items', {
                merchantId,
                syncedItems: syncedItemCount,
                dbItems: dbItemCount
            });
            return stats;
        }

        if (dbItemCount > 10 && syncedItemCount < dbItemCount * deletionThreshold) {
            logger.warn('SKIPPING deletion detection: too many items would be deleted (likely API error)', {
                merchantId,
                syncedItems: syncedItemCount,
                dbItems: dbItemCount,
                wouldDelete: dbItemCount - syncedItemCount,
                threshold: `${deletionThreshold * 100}%`
            });
            return stats;
        }

        // Find items in DB but NOT in Square sync (they were deleted)
        let itemsMarkedDeleted = 0;
        let variationsMarkedDeleted = 0;
        let inventoryZeroed = 0;

        for (const row of dbItemsResult.rows) {
            if (!syncedItemIds.has(row.id)) {
                // Item was deleted in Square
                await db.query(`
                    UPDATE items
                    SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND merchant_id = $2
                `, [row.id, merchantId]);

                // Zero inventory for all variations of this item (for this merchant only)
                const invResult = await db.query(`
                    UPDATE inventory_counts
                    SET quantity = 0, updated_at = CURRENT_TIMESTAMP
                    WHERE merchant_id = $2 AND catalog_object_id IN (
                        SELECT id FROM variations WHERE item_id = $1 AND merchant_id = $2
                    )
                `, [row.id, merchantId]);

                inventoryZeroed += invResult.rowCount;
                itemsMarkedDeleted++;
                logger.info('Item marked as deleted', { name: row.name, id: row.id, locations_zeroed: invResult.rowCount });
            }
        }

        for (const row of dbVariationsResult.rows) {
            if (!syncedVariationIds.has(row.id)) {
                // Variation was deleted in Square
                await db.query(`
                    UPDATE variations
                    SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND merchant_id = $2
                `, [row.id, merchantId]);

                // Zero inventory for this variation (for this merchant only)
                const invResult = await db.query(`
                    UPDATE inventory_counts
                    SET quantity = 0, updated_at = CURRENT_TIMESTAMP
                    WHERE catalog_object_id = $1 AND merchant_id = $2
                `, [row.id, merchantId]);

                inventoryZeroed += invResult.rowCount;
                variationsMarkedDeleted++;
                logger.info('Variation marked as deleted', { name: row.name, sku: row.sku || 'N/A', locations_zeroed: invResult.rowCount });
            }
        }

        logger.info('Deletion detection complete', { items_deleted: itemsMarkedDeleted, variations_deleted: variationsMarkedDeleted });

        // Add to stats
        stats.items_deleted = itemsMarkedDeleted;
        stats.variations_deleted = variationsMarkedDeleted;
        stats.inventory_zeroed += inventoryZeroed;

        return stats;
    } catch (error) {
        logger.error('Catalog sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync a category object
 * @param {Object} obj - Category object from Square API
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 */
async function syncCategory(obj, merchantId) {
    await db.query(`
        INSERT INTO categories (id, name, merchant_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            merchant_id = EXCLUDED.merchant_id
    `, [
        obj.id,
        obj.category_data?.name || 'Uncategorized',
        merchantId
    ]);
}

/**
 * Sync an image object
 * @param {Object} obj - Image object from Square API
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 */
async function syncImage(obj, merchantId) {
    await db.query(`
        INSERT INTO images (id, name, url, caption, merchant_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            url = EXCLUDED.url,
            caption = EXCLUDED.caption,
            merchant_id = EXCLUDED.merchant_id
    `, [
        obj.id,
        obj.image_data?.name || null,
        obj.image_data?.url || null,
        obj.image_data?.caption || null,
        merchantId
    ]);
}

/**
 * Sync an item object
 * @param {Object} obj - Item object from Square API
 * @param {string} category_name - Category name (already looked up from categoriesMap)
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 */
async function syncItem(obj, category_name, merchantId) {
    const data = obj.item_data;

    // Square uses ecom_visibility in item_data for e-commerce visibility
    // Values: UNINDEXED, VISIBLE, HIDDEN (map to our PRIVATE, PUBLIC, HIDDEN)
    let visibility = 'PRIVATE';
    if (data.ecom_visibility === 'VISIBLE') {
        visibility = 'PUBLIC';
    } else if (data.ecom_visibility === 'HIDDEN') {
        visibility = 'HIDDEN';
    } else if (data.ecom_visibility) {
        visibility = data.ecom_visibility; // Store as-is if unknown value
    }

    // Extract SEO data from ecom_seo_data object
    const seoTitle = data.ecom_seo_data?.page_title || null;
    const seoDescription = data.ecom_seo_data?.page_description || null;

    // Square uses ecom_visibility for online store availability
    // VISIBLE = available online, HIDDEN/UNINDEXED = not available online
    // Note: channels array contains channel IDs, not named values like 'SQUARE_ONLINE'
    const availableOnline = data.ecom_visibility === 'VISIBLE';

    // Square uses is_archived in item_data to indicate archived items
    // Archived items are hidden in Square Dashboard but still operational via API
    const isArchived = data.is_archived === true;

    await db.query(`
        INSERT INTO items (
            id, name, description, category_id, category_name, product_type,
            taxable, tax_ids, visibility, present_at_all_locations, present_at_location_ids,
            absent_at_location_ids, modifier_list_info, item_options, images,
            available_online, available_for_pickup, seo_title, seo_description,
            is_archived, archived_at, merchant_id, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            category_id = EXCLUDED.category_id,
            category_name = EXCLUDED.category_name,
            product_type = EXCLUDED.product_type,
            taxable = EXCLUDED.taxable,
            tax_ids = EXCLUDED.tax_ids,
            visibility = EXCLUDED.visibility,
            present_at_all_locations = EXCLUDED.present_at_all_locations,
            present_at_location_ids = EXCLUDED.present_at_location_ids,
            absent_at_location_ids = EXCLUDED.absent_at_location_ids,
            modifier_list_info = EXCLUDED.modifier_list_info,
            item_options = EXCLUDED.item_options,
            images = EXCLUDED.images,
            available_online = EXCLUDED.available_online,
            available_for_pickup = EXCLUDED.available_for_pickup,
            seo_title = EXCLUDED.seo_title,
            seo_description = EXCLUDED.seo_description,
            is_archived = EXCLUDED.is_archived,
            archived_at = CASE
                WHEN EXCLUDED.is_archived = TRUE AND (items.is_archived = FALSE OR items.is_archived IS NULL) THEN CURRENT_TIMESTAMP
                WHEN EXCLUDED.is_archived = FALSE THEN NULL
                ELSE items.archived_at
            END,
            merchant_id = EXCLUDED.merchant_id,
            updated_at = CURRENT_TIMESTAMP
    `, [
        obj.id,
        data.name,
        data.description || null,
        data.category_id || null,
        category_name || null,
        data.product_type || null,
        data.is_taxable || false,
        data.tax_ids ? JSON.stringify(data.tax_ids) : null,
        visibility,
        obj.present_at_all_locations !== false,
        obj.present_at_location_ids ? JSON.stringify(obj.present_at_location_ids) : null,
        obj.absent_at_location_ids ? JSON.stringify(obj.absent_at_location_ids) : null,
        data.modifier_list_info ? JSON.stringify(data.modifier_list_info) : null,
        data.item_options ? JSON.stringify(data.item_options) : null,
        data.image_ids ? JSON.stringify(data.image_ids) : null,
        availableOnline,  // Derived from ecom_visibility === 'VISIBLE'
        false,  // availableForPickup - Square doesn't expose this per-item via API
        seoTitle,
        seoDescription,
        isArchived,
        isArchived ? new Date() : null,  // archived_at - set when first archived
        merchantId
    ]);

    // Sync brand custom attribute from Square
    if (obj.custom_attribute_values?.brand?.string_value) {
        const brandName = obj.custom_attribute_values.brand.string_value.trim();
        if (brandName) {
            try {
                // Ensure brand exists in brands table (per-merchant)
                await db.query(
                    'INSERT INTO brands (name, merchant_id) VALUES ($1, $2) ON CONFLICT (name, merchant_id) DO NOTHING',
                    [brandName, merchantId]
                );

                // Get brand ID for this merchant
                const brandResult = await db.query(
                    'SELECT id FROM brands WHERE name = $1 AND merchant_id = $2',
                    [brandName, merchantId]
                );

                if (brandResult.rows.length > 0) {
                    const brandId = brandResult.rows[0].id;

                    // Link item to brand (per-merchant)
                    await db.query(`
                        INSERT INTO item_brands (item_id, brand_id, merchant_id)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
                    `, [obj.id, brandId, merchantId]);
                }
            } catch (error) {
                logger.error('Error syncing brand from Square', {
                    item_id: obj.id,
                    brand: brandName,
                    error: error.message
                });
            }
        }
    }
}

/**
 * Sync a variation object and its vendor information
 * @param {Object} obj - Variation object from Square API
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {number} Number of vendor relationships created
 */
async function syncVariation(obj, merchantId) {
    const data = obj.item_variation_data;
    let vendorCount = 0;

    // Square stores inventory_alert settings per-location in location_overrides
    // Check ALL location_overrides and use any that has LOW_QUANTITY alert enabled
    let inventoryAlertType = data.inventory_alert_type || null;
    let inventoryAlertThreshold = data.inventory_alert_threshold || null;

    if (data.location_overrides && data.location_overrides.length > 0) {
        // Find any location with LOW_QUANTITY alert enabled (not just the first)
        for (const override of data.location_overrides) {
            if (!inventoryAlertType && override.inventory_alert_type === 'LOW_QUANTITY') {
                inventoryAlertType = override.inventory_alert_type;
                if (inventoryAlertThreshold === null && override.inventory_alert_threshold !== undefined) {
                    inventoryAlertThreshold = override.inventory_alert_threshold;
                }
                break; // Found one with alerts enabled, use it
            }
        }
        // If no LOW_QUANTITY found, fall back to first override's type (if any)
        if (!inventoryAlertType && data.location_overrides[0].inventory_alert_type) {
            inventoryAlertType = data.location_overrides[0].inventory_alert_type;
        }
        if (inventoryAlertThreshold === null && data.location_overrides[0].inventory_alert_threshold !== undefined) {
            inventoryAlertThreshold = data.location_overrides[0].inventory_alert_threshold;
        }
    }

    // Log inventory alert fields for debugging
    if (Math.random() < 0.02) {
        logger.info('Variation inventory fields from Square', {
            variation_id: obj.id,
            sku: data.sku,
            track_inventory: data.track_inventory,
            inventory_alert_type: inventoryAlertType,
            inventory_alert_threshold: inventoryAlertThreshold,
            location_overrides_count: data.location_overrides?.length || 0
        });
    }

    // Insert/update variation
    await db.query(`
        INSERT INTO variations (
            id, item_id, name, sku, upc, price_money, currency, pricing_type,
            track_inventory, inventory_alert_type, inventory_alert_threshold,
            present_at_all_locations, present_at_location_ids, absent_at_location_ids,
            item_option_values, custom_attributes, images, merchant_id, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            item_id = EXCLUDED.item_id,
            name = EXCLUDED.name,
            sku = EXCLUDED.sku,
            upc = EXCLUDED.upc,
            price_money = EXCLUDED.price_money,
            currency = EXCLUDED.currency,
            pricing_type = EXCLUDED.pricing_type,
            track_inventory = EXCLUDED.track_inventory,
            inventory_alert_type = EXCLUDED.inventory_alert_type,
            inventory_alert_threshold = EXCLUDED.inventory_alert_threshold,
            present_at_all_locations = EXCLUDED.present_at_all_locations,
            present_at_location_ids = EXCLUDED.present_at_location_ids,
            absent_at_location_ids = EXCLUDED.absent_at_location_ids,
            item_option_values = EXCLUDED.item_option_values,
            custom_attributes = EXCLUDED.custom_attributes,
            images = EXCLUDED.images,
            merchant_id = EXCLUDED.merchant_id,
            updated_at = CURRENT_TIMESTAMP
    `, [
        obj.id,
        data.item_id,
        data.name || 'Regular',
        data.sku || null,
        data.upc || null,
        data.price_money?.amount || null,
        data.price_money?.currency || 'CAD',
        data.pricing_type || 'FIXED_PRICING',
        data.track_inventory === true,  // Only true if explicitly enabled in Square
        inventoryAlertType,  // From variation or first location_override
        inventoryAlertThreshold,  // From variation or first location_override
        obj.present_at_all_locations !== false,
        obj.present_at_location_ids ? JSON.stringify(obj.present_at_location_ids) : null,
        obj.absent_at_location_ids ? JSON.stringify(obj.absent_at_location_ids) : null,
        data.item_option_values ? JSON.stringify(data.item_option_values) : null,
        obj.custom_attribute_values ? JSON.stringify(obj.custom_attribute_values) : null,
        data.image_ids ? JSON.stringify(data.image_ids) : null,
        merchantId
    ]);

    // Sync location-specific settings from location_overrides
    if (data.location_overrides && Array.isArray(data.location_overrides)) {
        for (const override of data.location_overrides) {
            try {
                await db.query(`
                    INSERT INTO variation_location_settings (
                        variation_id, location_id,
                        stock_alert_min, stock_alert_max,
                        active, merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3, $4, true, $5, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, location_id, merchant_id) DO UPDATE SET
                        stock_alert_min = EXCLUDED.stock_alert_min,
                        stock_alert_max = EXCLUDED.stock_alert_max,
                        active = EXCLUDED.active,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    obj.id,
                    override.location_id,
                    override.inventory_alert_threshold || null,
                    null,  // stock_alert_max not available in Square API
                    merchantId
                ]);
            } catch (error) {
                logger.error('Error syncing location override', { variation_id: obj.id, location_id: override.location_id, error: error.message });
            }
        }
    }

    // Sync vendor information - clear existing and replace with fresh data from Square
    // First, delete all existing vendor relationships for this variation
    await db.query('DELETE FROM variation_vendors WHERE variation_id = $1 AND merchant_id = $2', [obj.id, merchantId]);

    if (data.vendor_information && Array.isArray(data.vendor_information)) {
        for (const vendorInfo of data.vendor_information) {
            // Skip entries without vendor_id - these are just cost data without a linked vendor
            // (This is normal for items with costs but no vendor assigned)
            if (!vendorInfo.vendor_id) {
                // Only log at debug level since this is expected
                logger.debug('Vendor info without vendor_id (cost-only entry)', {
                    variation_id: obj.id,
                    has_unit_cost_money: !!vendorInfo.unit_cost_money
                });
                continue;
            }
            try {
                await db.query(`
                    INSERT INTO variation_vendors (
                        variation_id, vendor_id, vendor_code, unit_cost_money, currency, merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
                        vendor_code = EXCLUDED.vendor_code,
                        unit_cost_money = EXCLUDED.unit_cost_money,
                        currency = EXCLUDED.currency,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    obj.id,
                    vendorInfo.vendor_id,
                    vendorInfo.vendor_code || null,
                    vendorInfo.unit_cost_money?.amount || null,
                    vendorInfo.unit_cost_money?.currency || 'CAD',
                    merchantId
                ]);
                vendorCount++;
            } catch (error) {
                // Vendor might not exist yet, skip
                logger.warn('Skipping vendor - not found in database', { vendor_id: vendorInfo.vendor_id, variation_id: obj.id });
            }
        }
    }

    // Sync custom attributes from Square (Square is source of truth)
    if (obj.custom_attribute_values) {
        const customAttrs = obj.custom_attribute_values;

        // Sync case_pack_quantity
        if (customAttrs.case_pack_quantity?.number_value) {
            try {
                const casePackQty = parseInt(customAttrs.case_pack_quantity.number_value, 10);
                if (!isNaN(casePackQty) && casePackQty > 0) {
                    await db.query(`
                        UPDATE variations
                        SET case_pack_quantity = $1, updated_at = CURRENT_TIMESTAMP
                        WHERE id = $2 AND merchant_id = $3
                    `, [casePackQty, obj.id, merchantId]);
                }
            } catch (error) {
                logger.error('Error syncing case_pack_quantity from Square', {
                    variation_id: obj.id,
                    error: error.message
                });
            }
        }

        // Sync expiration data
        const expirationDateAttr = customAttrs.expiration_date;
        const doesNotExpireAttr = customAttrs.does_not_expire;
        const expiryReviewedAtAttr = customAttrs.expiry_reviewed_at;
        const expiryReviewedByAttr = customAttrs.expiry_reviewed_by;

        if (expirationDateAttr || doesNotExpireAttr || expiryReviewedAtAttr || expiryReviewedByAttr) {
            try {
                let expirationDate = null;
                let doesNotExpire = false;
                let reviewedAt = null;
                let reviewedBy = null;

                // Extract expiration_date (stored as string YYYY-MM-DD)
                if (expirationDateAttr?.string_value) {
                    expirationDate = expirationDateAttr.string_value;
                }

                // Extract does_not_expire boolean
                if (doesNotExpireAttr?.boolean_value !== undefined) {
                    doesNotExpire = doesNotExpireAttr.boolean_value === true;
                }

                // Extract expiry_reviewed_at (stored as ISO timestamp string)
                if (expiryReviewedAtAttr?.string_value) {
                    reviewedAt = expiryReviewedAtAttr.string_value;
                }

                // Extract expiry_reviewed_by (user who reviewed)
                if (expiryReviewedByAttr?.string_value) {
                    reviewedBy = expiryReviewedByAttr.string_value;
                }

                // Update local variation_expiration table
                // Use COALESCE to preserve local values when Square has null (don't overwrite with null)
                await db.query(`
                    INSERT INTO variation_expiration (variation_id, expiration_date, does_not_expire, reviewed_at, reviewed_by, merchant_id, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, merchant_id) DO UPDATE SET
                        expiration_date = COALESCE(EXCLUDED.expiration_date, variation_expiration.expiration_date),
                        does_not_expire = COALESCE(EXCLUDED.does_not_expire, variation_expiration.does_not_expire),
                        reviewed_at = COALESCE(EXCLUDED.reviewed_at, variation_expiration.reviewed_at),
                        reviewed_by = COALESCE(EXCLUDED.reviewed_by, variation_expiration.reviewed_by),
                        updated_at = CURRENT_TIMESTAMP
                `, [obj.id, expirationDate, doesNotExpire, reviewedAt, reviewedBy, merchantId]);

            } catch (error) {
                logger.error('Error syncing expiration data from Square', {
                    variation_id: obj.id,
                    error: error.message
                });
            }
        }
    }

    return vendorCount;
}

/**
 * Sync inventory counts from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of inventory records synced
 */
async function syncInventory(merchantId) {
    logger.info('Starting inventory sync', { merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Get all locations for this merchant
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found. Run location sync first', { merchantId });
            return 0;
        }

        // Get all variation IDs for this merchant
        const variationsResult = await db.query('SELECT id FROM variations WHERE merchant_id = $1', [merchantId]);
        const catalogObjectIds = variationsResult.rows.map(r => r.id);

        if (catalogObjectIds.length === 0) {
            logger.warn('No variations found. Run catalog sync first', { merchantId });
            return 0;
        }

        let totalSynced = 0;

        // Process in batches of 100 (Square API limit)
        const batchSize = 100;
        for (let i = 0; i < catalogObjectIds.length; i += batchSize) {
            const batch = catalogObjectIds.slice(i, i + batchSize);

            const requestBody = {
                catalog_object_ids: batch,
                location_ids: locationIds,
                states: ['IN_STOCK', 'RESERVED_FOR_SALE']
            };

            try {
                const data = await makeSquareRequest('/v2/inventory/counts/batch-retrieve', {
                    method: 'POST',
                    body: JSON.stringify(requestBody),
                    accessToken
                });

                const counts = data.counts || [];

                // Log counts by state for debugging
                const stateCount = counts.reduce((acc, c) => {
                    acc[c.state] = (acc[c.state] || 0) + 1;
                    return acc;
                }, {});
                logger.info('Inventory counts by state', { merchantId, batch: Math.floor(i / batchSize) + 1, states: stateCount });

                for (const count of counts) {
                    await db.query(`
                        INSERT INTO inventory_counts (
                            catalog_object_id, location_id, state, quantity, merchant_id, updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                        ON CONFLICT (catalog_object_id, location_id, state, merchant_id) DO UPDATE SET
                            quantity = EXCLUDED.quantity,
                            updated_at = CURRENT_TIMESTAMP
                    `, [
                        count.catalog_object_id,
                        count.location_id,
                        count.state,
                        parseInt(count.quantity) || 0,
                        merchantId
                    ]);
                    totalSynced++;
                }

                logger.info('Inventory sync batch complete', { merchantId, batch: Math.floor(i / batchSize) + 1, total_synced: totalSynced });
            } catch (error) {
                logger.error('Inventory sync batch failed', { merchantId, batch: Math.floor(i / batchSize) + 1, error: error.message });
                // Continue with next batch
            }

            // Small delay to avoid rate limiting
            await sleep(100);
        }

        logger.info('Inventory sync complete', { merchantId, records: totalSynced });
        return totalSynced;
    } catch (error) {
        logger.error('Inventory sync failed', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync sales velocity for a specific time period
 * @param {number} periodDays - Number of days to analyze (91, 182, or 365)
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of variations with velocity data
 */
async function syncSalesVelocity(periodDays = 91, merchantId) {
    logger.info('Starting sales velocity sync', { period_days: periodDays, merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - periodDays);

        // Get all active locations for this merchant
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found');
            return 0;
        }

        // Aggregate sales data by variation and location
        const salesData = new Map();

        let cursor = null;
        let ordersProcessed = 0;

        do {
            const requestBody = {
                location_ids: locationIds,
                query: {
                    filter: {
                        state_filter: {
                            states: ['COMPLETED']
                        },
                        date_time_filter: {
                            closed_at: {
                                start_at: startDate.toISOString(),
                                end_at: endDate.toISOString()
                            }
                        }
                    }
                },
                limit: 50
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/orders/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });

            const orders = data.orders || [];

            // Process each order
            for (const order of orders) {
                if (!order.line_items) continue;

                for (const lineItem of order.line_items) {
                    const variationId = lineItem.catalog_object_id;
                    const locationId = order.location_id;

                    if (!variationId || !locationId) continue;

                    const key = `${variationId}:${locationId}`;

                    if (!salesData.has(key)) {
                        salesData.set(key, {
                            variation_id: variationId,
                            location_id: locationId,
                            total_quantity: 0,
                            total_revenue: 0
                        });
                    }

                    const data = salesData.get(key);
                    data.total_quantity += parseFloat(lineItem.quantity) || 0;
                    data.total_revenue += parseInt(lineItem.total_money?.amount) || 0;
                }
            }

            ordersProcessed += orders.length;
            cursor = data.cursor;
            logger.info('Sales velocity sync progress', { orders_processed: ordersProcessed });

        } while (cursor);

        // Validate which variations exist in our database before inserting
        // This prevents foreign key constraint violations for deleted variations
        const uniqueVariationIds = [...new Set([...salesData.values()].map(d => d.variation_id))];

        if (uniqueVariationIds.length === 0) {
            logger.info('No sales data to sync');
            return 0;
        }

        // Query to check which variation IDs exist FOR THIS MERCHANT
        const placeholders = uniqueVariationIds.map((_, i) => `$${i + 1}`).join(',');
        const existingVariationsResult = await db.query(
            `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${uniqueVariationIds.length + 1}`,
            [...uniqueVariationIds, merchantId]
        );

        const existingVariationIds = new Set(existingVariationsResult.rows.map(row => row.id));
        const missingCount = uniqueVariationIds.length - existingVariationIds.size;

        if (missingCount > 0) {
            logger.info('Filtering out deleted variations from sales velocity', {
                total_variations: uniqueVariationIds.length,
                existing: existingVariationIds.size,
                missing: missingCount
            });
        }

        // Save velocity data to database (only for existing variations)
        let savedCount = 0;
        let skippedCount = 0;

        for (const [key, data] of salesData.entries()) {
            // Skip variations that don't exist in our database
            if (!existingVariationIds.has(data.variation_id)) {
                skippedCount++;
                continue;
            }

            const dailyAvg = data.total_quantity / periodDays;
            const weeklyAvg = data.total_quantity / (periodDays / 7);
            const monthlyAvg = data.total_quantity / (periodDays / 30);
            const dailyRevenueAvg = data.total_revenue / periodDays;

            await db.query(`
                INSERT INTO sales_velocity (
                    variation_id, location_id, period_days,
                    total_quantity_sold, total_revenue_cents,
                    period_start_date, period_end_date,
                    daily_avg_quantity, daily_avg_revenue_cents,
                    weekly_avg_quantity, monthly_avg_quantity,
                    merchant_id, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
                ON CONFLICT (variation_id, location_id, period_days, merchant_id) DO UPDATE SET
                    total_quantity_sold = EXCLUDED.total_quantity_sold,
                    total_revenue_cents = EXCLUDED.total_revenue_cents,
                    period_start_date = EXCLUDED.period_start_date,
                    period_end_date = EXCLUDED.period_end_date,
                    daily_avg_quantity = EXCLUDED.daily_avg_quantity,
                    daily_avg_revenue_cents = EXCLUDED.daily_avg_revenue_cents,
                    weekly_avg_quantity = EXCLUDED.weekly_avg_quantity,
                    monthly_avg_quantity = EXCLUDED.monthly_avg_quantity,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                data.variation_id,
                data.location_id,
                periodDays,
                data.total_quantity,
                data.total_revenue,
                startDate,
                endDate,
                dailyAvg,
                dailyRevenueAvg,
                weeklyAvg,
                monthlyAvg,
                merchantId
            ]);
            savedCount++;
        }

        if (skippedCount > 0) {
            logger.info('Skipped sales velocity entries for deleted variations', {
                skipped: skippedCount
            });
        }

        logger.info('Sales velocity sync complete', { combinations: savedCount, period_days: periodDays });
        return savedCount;
    } catch (error) {
        logger.error('Sales velocity sync failed', { period_days: periodDays, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync sales velocity for multiple periods with a SINGLE API fetch.
 * This optimized function fetches orders once for the specified max period and calculates
 * all periods up to that max, eliminating redundant API calls.
 *
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @param {number} [maxPeriod=365] - Maximum period to fetch (91, 182, or 365).
 *                                   Will calculate all periods <= maxPeriod.
 *                                   e.g., maxPeriod=182 fetches 182d and calculates 91d + 182d
 * @returns {Promise<Object>} Summary with counts for each period synced { '91d': count, '182d': count, ... }
 */
async function syncSalesVelocityAllPeriods(merchantId, maxPeriod = 365, options = {}) {
    const { loyaltyBackfill = false } = options;  // Disabled by default - use manual customer audit instead

    const ALL_PERIODS = [91, 182, 365];
    // Only sync periods up to maxPeriod
    const PERIODS = ALL_PERIODS.filter(p => p <= maxPeriod);
    const MAX_PERIOD = Math.max(...PERIODS);

    logger.info('Starting optimized sales velocity sync', {
        periods: PERIODS,
        maxPeriod: MAX_PERIOD,
        merchantId,
        loyaltyBackfill,
        optimization: `single fetch for ${PERIODS.length} period(s)`
    });

    // Lazy-load loyalty service to avoid circular dependency
    let loyaltyService = null;
    if (loyaltyBackfill) {
        try {
            loyaltyService = require('./loyalty-service');
        } catch (err) {
            logger.warn('Could not load loyalty-service for backfill', { error: err.message });
        }
    }

    // Initialize summary with only the periods we're syncing
    const summary = {
        ordersProcessed: 0,
        apiCallsSaved: 0,
        periodssynced: PERIODS,
        loyaltyOrdersChecked: 0,
        loyaltyOrdersBackfilled: 0
    };
    for (const days of PERIODS) {
        summary[`${days}d`] = 0;
    }

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Calculate date range for the longest period (365 days)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - MAX_PERIOD);

        // Pre-calculate period boundaries for efficient date filtering
        const periodBoundaries = {};
        for (const days of PERIODS) {
            const boundary = new Date();
            boundary.setDate(boundary.getDate() - days);
            periodBoundaries[days] = boundary;
        }

        // Get all active locations for this merchant
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found for optimized sales velocity sync');
            return summary;
        }

        // Aggregate sales data by variation, location, AND period
        // Structure: Map<"variationId:locationId:periodDays", { data }>
        const salesDataByPeriod = new Map();

        // Initialize maps for each period
        for (const days of PERIODS) {
            salesDataByPeriod.set(days, new Map());
        }

        let cursor = null;
        let ordersProcessed = 0;
        let apiCalls = 0;

        // Single fetch loop for ALL 365 days of orders
        do {
            const requestBody = {
                location_ids: locationIds,
                query: {
                    filter: {
                        state_filter: {
                            states: ['COMPLETED']
                        },
                        date_time_filter: {
                            closed_at: {
                                start_at: startDate.toISOString(),
                                end_at: endDate.toISOString()
                            }
                        }
                    }
                },
                limit: 50
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/orders/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });
            apiCalls++;

            const orders = data.orders || [];

            // Process each order and assign to appropriate periods based on closed_at date
            for (const order of orders) {
                if (!order.line_items) continue;

                // LOYALTY BACKFILL HOOK: Process order for loyalty if not already done
                // Order history is append-only, so we only need to process each order once
                if (loyaltyService && order.customer_id) {
                    try {
                        summary.loyaltyOrdersChecked++;
                        const loyaltyResult = await loyaltyService.processOrderForLoyaltyIfNeeded(order, merchantId);
                        if (loyaltyResult.processed) {
                            summary.loyaltyOrdersBackfilled++;
                        }
                    } catch (loyaltyErr) {
                        // Non-fatal - log and continue with velocity sync
                        logger.warn('Loyalty backfill failed for order', {
                            orderId: order.id,
                            error: loyaltyErr.message
                        });
                    }
                }

                const orderClosedAt = new Date(order.closed_at);

                for (const lineItem of order.line_items) {
                    const variationId = lineItem.catalog_object_id;
                    const locationId = order.location_id;

                    if (!variationId || !locationId) continue;

                    const quantity = parseFloat(lineItem.quantity) || 0;
                    const revenue = parseInt(lineItem.total_money?.amount) || 0;

                    // Add this line item to ALL periods where it falls within the date range
                    for (const days of PERIODS) {
                        if (orderClosedAt >= periodBoundaries[days]) {
                            const key = `${variationId}:${locationId}`;
                            const periodMap = salesDataByPeriod.get(days);

                            if (!periodMap.has(key)) {
                                periodMap.set(key, {
                                    variation_id: variationId,
                                    location_id: locationId,
                                    total_quantity: 0,
                                    total_revenue: 0
                                });
                            }

                            const itemData = periodMap.get(key);
                            itemData.total_quantity += quantity;
                            itemData.total_revenue += revenue;
                        }
                    }
                }
            }

            ordersProcessed += orders.length;
            cursor = data.cursor;

            if (ordersProcessed % 500 === 0) {
                logger.info('Optimized sales velocity sync progress', {
                    orders_processed: ordersProcessed,
                    api_calls: apiCalls
                });
            }

        } while (cursor);

        summary.ordersProcessed = ordersProcessed;
        // Estimate API calls saved: normally would be ~3x the calls for each period
        summary.apiCallsSaved = apiCalls * 2; // We made apiCalls, would have made ~3x

        // Build period_counts dynamically based on which periods we're actually tracking
        const period_counts = {};
        for (const days of PERIODS) {
            const periodMap = salesDataByPeriod.get(days);
            period_counts[`${days}d`] = periodMap ? periodMap.size : 0;
        }

        logger.info('Order fetch complete, processing periods', {
            ordersProcessed,
            apiCalls,
            period_counts
        });

        // Collect all unique variation IDs across all periods for validation
        const allVariationIds = new Set();
        for (const days of PERIODS) {
            for (const data of salesDataByPeriod.get(days).values()) {
                allVariationIds.add(data.variation_id);
            }
        }

        if (allVariationIds.size === 0) {
            logger.info('No sales data to sync across any period');
            return summary;
        }

        // Query to check which variation IDs exist FOR THIS MERCHANT
        const uniqueVariationIds = [...allVariationIds];
        const placeholders = uniqueVariationIds.map((_, i) => `$${i + 1}`).join(',');
        const existingVariationsResult = await db.query(
            `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${uniqueVariationIds.length + 1}`,
            [...uniqueVariationIds, merchantId]
        );

        const existingVariationIds = new Set(existingVariationsResult.rows.map(row => row.id));
        const missingCount = uniqueVariationIds.length - existingVariationIds.size;

        if (missingCount > 0) {
            logger.info('Filtering out deleted variations from sales velocity (all periods)', {
                total_variations: uniqueVariationIds.length,
                existing: existingVariationIds.size,
                missing: missingCount
            });
        }

        // Save velocity data for each period
        for (const periodDays of PERIODS) {
            const periodStartDate = new Date();
            periodStartDate.setDate(periodStartDate.getDate() - periodDays);

            const periodMap = salesDataByPeriod.get(periodDays);
            let savedCount = 0;
            let skippedCount = 0;

            for (const [key, data] of periodMap.entries()) {
                // Skip variations that don't exist in our database
                if (!existingVariationIds.has(data.variation_id)) {
                    skippedCount++;
                    continue;
                }

                const dailyAvg = data.total_quantity / periodDays;
                const weeklyAvg = data.total_quantity / (periodDays / 7);
                const monthlyAvg = data.total_quantity / (periodDays / 30);
                const dailyRevenueAvg = data.total_revenue / periodDays;

                await db.query(`
                    INSERT INTO sales_velocity (
                        variation_id, location_id, period_days,
                        total_quantity_sold, total_revenue_cents,
                        period_start_date, period_end_date,
                        daily_avg_quantity, daily_avg_revenue_cents,
                        weekly_avg_quantity, monthly_avg_quantity,
                        merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, location_id, period_days, merchant_id) DO UPDATE SET
                        total_quantity_sold = EXCLUDED.total_quantity_sold,
                        total_revenue_cents = EXCLUDED.total_revenue_cents,
                        period_start_date = EXCLUDED.period_start_date,
                        period_end_date = EXCLUDED.period_end_date,
                        daily_avg_quantity = EXCLUDED.daily_avg_quantity,
                        daily_avg_revenue_cents = EXCLUDED.daily_avg_revenue_cents,
                        weekly_avg_quantity = EXCLUDED.weekly_avg_quantity,
                        monthly_avg_quantity = EXCLUDED.monthly_avg_quantity,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    data.variation_id,
                    data.location_id,
                    periodDays,
                    data.total_quantity,
                    data.total_revenue,
                    periodStartDate,
                    endDate,
                    dailyAvg,
                    dailyRevenueAvg,
                    weeklyAvg,
                    monthlyAvg,
                    merchantId
                ]);
                savedCount++;
            }

            if (skippedCount > 0) {
                logger.info(`Skipped sales velocity entries for deleted variations (${periodDays}d)`, {
                    skipped: skippedCount
                });
            }

            summary[`${periodDays}d`] = savedCount;
            logger.info(`Sales velocity sync complete for ${periodDays}d period`, {
                combinations: savedCount,
                period_days: periodDays
            });
        }

        logger.info('Optimized sales velocity sync complete (all periods)', {
            summary,
            performance: {
                ordersProcessed,
                apiCalls,
                estimatedCallsSaved: summary.apiCallsSaved
            }
        });

        return summary;
    } catch (error) {
        logger.error('Optimized sales velocity sync failed', {
            error: error.message,
            stack: error.stack,
            merchantId
        });
        throw error;
    }
}

/**
 * Get current inventory count from Square for a specific variation and location
 * @param {string} catalogObjectId - The variation ID
 * @param {string} locationId - The location ID
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @returns {Promise<number>} Current quantity in Square
 */
async function getSquareInventoryCount(catalogObjectId, locationId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getSquareInventoryCount');
    }
    logger.info('Fetching inventory count from Square', { catalogObjectId, locationId, merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);
        const requestBody = {
            catalog_object_ids: [catalogObjectId],
            location_ids: [locationId],
            states: ['IN_STOCK']
        };

        const data = await makeSquareRequest('/v2/inventory/counts/batch-retrieve', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken
        });

        const counts = data.counts || [];

        // Find the matching count
        const count = counts.find(c =>
            c.catalog_object_id === catalogObjectId &&
            c.location_id === locationId &&
            c.state === 'IN_STOCK'
        );

        const quantity = count ? parseInt(count.quantity) || 0 : 0;
        logger.info('Square inventory count retrieved', { catalogObjectId, locationId, quantity });

        return quantity;
    } catch (error) {
        logger.error('Failed to get Square inventory count', {
            catalogObjectId,
            locationId,
            merchantId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Adjust inventory in Square using physical count
 * Sets the inventory to the specified quantity (not a delta)
 * @param {string} catalogObjectId - The variation ID
 * @param {string} locationId - The location ID
 * @param {number} quantity - The new absolute quantity to set
 * @param {string} reason - Reason for the adjustment (for memo)
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @returns {Promise<Object>} Result of the inventory change
 */
async function setSquareInventoryCount(catalogObjectId, locationId, quantity, reason = 'Cycle count adjustment', merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for setSquareInventoryCount');
    }
    logger.info('Setting Square inventory count', { catalogObjectId, locationId, quantity, reason, merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);
        // Generate idempotency key for the request
        const idempotencyKey = generateIdempotencyKey(`cycle-count-${catalogObjectId}-${locationId}`);

        const requestBody = {
            idempotency_key: idempotencyKey,
            changes: [{
                type: 'PHYSICAL_COUNT',
                physical_count: {
                    catalog_object_id: catalogObjectId,
                    state: 'IN_STOCK',
                    location_id: locationId,
                    quantity: quantity.toString(),
                    occurred_at: new Date().toISOString(),
                    reference_id: `cycle-count-${Date.now()}`
                }
            }]
        };

        const data = await makeSquareRequest('/v2/inventory/changes/batch-create', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken
        });

        logger.info('Square inventory updated successfully', {
            catalogObjectId,
            locationId,
            newQuantity: quantity,
            changes: data.changes?.length || 0
        });

        return {
            success: true,
            changes: data.changes || [],
            counts: data.counts || []
        };
    } catch (error) {
        logger.error('Failed to set Square inventory count', {
            catalogObjectId,
            locationId,
            quantity,
            merchantId,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Update inventory alert threshold (min stock) for a variation at a specific location in Square
 * Uses location_overrides to set location-specific low stock alerts
 * @param {string} catalogObjectId - The variation ID
 * @param {string} locationId - The location ID for the alert
 * @param {number|null} threshold - The new threshold value (null to disable alerts)
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Result of the catalog update
 */
async function setSquareInventoryAlertThreshold(catalogObjectId, locationId, threshold, options = {}) {
    const { merchantId } = options;
    const MAX_RETRIES = 3;

    if (!merchantId) {
        throw new Error('merchantId is required for setSquareInventoryAlertThreshold');
    }

    logger.info('Updating Square inventory alert threshold', { catalogObjectId, locationId, threshold, merchantId });

    // Get merchant-specific access token
    const accessToken = await getMerchantToken(merchantId);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Retrieve the current catalog object to get its version and existing overrides
            // This is done inside the retry loop to get the latest version on each attempt
            const retrieveData = await makeSquareRequest(`/v2/catalog/object/${catalogObjectId}?include_related_objects=false`, { accessToken });

            if (!retrieveData.object) {
                throw new Error(`Catalog object not found: ${catalogObjectId}`);
            }

            const currentObject = retrieveData.object;

            if (currentObject.type !== 'ITEM_VARIATION') {
                throw new Error(`Object is not a variation: ${currentObject.type}`);
            }

            const currentVariationData = currentObject.item_variation_data || {};
            const existingOverrides = currentVariationData.location_overrides || [];

            // Determine alert type based on threshold
            const alertType = (threshold !== null && threshold > 0) ? 'LOW_QUANTITY' : 'NONE';

            // Build new location_overrides array
            // Keep existing overrides for other locations, update/add the one for our location
            let newOverrides = existingOverrides.filter(o => o.location_id !== locationId);

            // Add/update the override for our target location
            const newOverride = {
                location_id: locationId,
                inventory_alert_type: alertType
            };

            if (alertType === 'LOW_QUANTITY' && threshold !== null) {
                newOverride.inventory_alert_threshold = threshold;
            }

            newOverrides.push(newOverride);

            // Build the update request - use unique key per attempt to avoid idempotency conflicts
            const idempotencyKey = generateIdempotencyKey(`inv-alert-v2-${attempt}`);

            logger.info('Generated idempotency key for alert threshold update', {
                idempotencyKey,
                catalogObjectId,
                locationId,
                version: currentObject.version,
                attempt
            });

            const updateBody = {
                idempotency_key: idempotencyKey,
                object: {
                    type: 'ITEM_VARIATION',
                    id: catalogObjectId,
                    version: currentObject.version,
                    item_variation_data: {
                        ...currentVariationData,
                        location_overrides: newOverrides
                    }
                }
            };

            const data = await makeSquareRequest('/v2/catalog/object', {
                method: 'POST',
                body: JSON.stringify(updateBody),
                accessToken
            });

            logger.info('Square inventory alert threshold updated (location-specific)', {
                catalogObjectId,
                locationId,
                threshold,
                alertType,
                newVersion: data.catalog_object?.version,
                attempts: attempt
            });

            return {
                success: true,
                catalog_object: data.catalog_object,
                id_mappings: data.id_mappings
            };
        } catch (error) {
            // Check if this is a VERSION_MISMATCH error that we can retry
            const isVersionMismatch = error.message && error.message.includes('VERSION_MISMATCH');

            if (isVersionMismatch && attempt < MAX_RETRIES) {
                logger.warn('VERSION_MISMATCH on inventory alert update, retrying with fresh version', {
                    catalogObjectId,
                    locationId,
                    attempt,
                    maxRetries: MAX_RETRIES
                });
                // Small delay before retry to allow concurrent updates to complete
                await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                continue;
            }

            logger.error('Failed to update Square inventory alert threshold', {
                catalogObjectId,
                locationId,
                threshold,
                error: error.message,
                stack: error.stack,
                attempts: attempt
            });
            throw error;
        }
    }
}

/**
 * Sync committed inventory from open/unpaid invoices
 * This calculates quantities reserved for invoices that haven't been paid yet
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<number>} Number of committed inventory records synced
 */
async function syncCommittedInventory(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for syncCommittedInventory');
    }

    // Check if merchant is known to lack INVOICES_READ scope (cached)
    const cachedTimestamp = merchantsWithoutInvoicesScope.get(merchantId);
    if (cachedTimestamp && Date.now() - cachedTimestamp < INVOICES_SCOPE_CACHE_TTL) {
        // Silently skip - already logged once when cached
        return { skipped: true, reason: 'INVOICES_READ scope not authorized (cached)', count: 0 };
    }

    logger.info('Starting committed inventory sync from invoices', { merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Get all active locations FOR THIS MERCHANT ONLY
        const locationsResult = await db.query(
            'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
            [merchantId]
        );
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found for committed inventory sync', { merchantId });
            return 0;
        }

        // Clear existing RESERVED_FOR_SALE records FOR THIS MERCHANT ONLY before recalculating
        await db.query(
            "DELETE FROM inventory_counts WHERE state = 'RESERVED_FOR_SALE' AND merchant_id = $1",
            [merchantId]
        );

        // Track committed quantities: Map<variationId:locationId, quantity>
        const committedQuantities = new Map();

        // Search for open invoices - Square doesn't support status filtering,
        // so we fetch all and filter in code
        let cursor = null;
        let invoicesProcessed = 0;
        const openStatuses = ['DRAFT', 'UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'];

        do {
            const requestBody = {
                query: {
                    filter: {
                        location_ids: locationIds
                    },
                    sort: {
                        field: 'INVOICE_SORT_DATE',
                        order: 'DESC'
                    }
                },
                limit: 200
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            let data;
            try {
                data = await makeSquareRequest('/v2/invoices/search', {
                    method: 'POST',
                    body: JSON.stringify(requestBody),
                    accessToken
                });
            } catch (apiError) {
                // Gracefully handle missing INVOICES_READ scope
                if (apiError.message && apiError.message.includes('INSUFFICIENT_SCOPES')) {
                    // Cache this to avoid repeated API calls and log spam
                    merchantsWithoutInvoicesScope.set(merchantId, Date.now());
                    logger.info('Skipping committed inventory sync - merchant does not have INVOICES_READ scope (will cache for 1 hour)', { merchantId });
                    return { skipped: true, reason: 'INVOICES_READ scope not authorized', count: 0 };
                }
                // Re-throw other errors
                throw apiError;
            }

            const invoices = data.invoices || [];
            cursor = data.cursor;

            for (const invoice of invoices) {
                // Filter by status in code (Square API doesn't support status filter)
                if (!openStatuses.includes(invoice.status)) continue;

                // Skip if no location
                if (!invoice.location_id) continue;

                // Get the full invoice details to get line items
                // The search endpoint may not return all line item details
                try {
                    const invoiceDetail = await makeSquareRequest(`/v2/invoices/${invoice.id}`, {
                        method: 'GET',
                        accessToken
                    });

                    const fullInvoice = invoiceDetail.invoice;
                    if (!fullInvoice || !fullInvoice.order_id) continue;

                    // Fetch the order to get line items with catalog_object_id
                    const orderData = await makeSquareRequest(`/v2/orders/${fullInvoice.order_id}`, {
                        method: 'GET',
                        accessToken
                    });

                    const order = orderData.order;
                    if (!order || !order.line_items) continue;

                    for (const lineItem of order.line_items) {
                        const variationId = lineItem.catalog_object_id;
                        const locationId = order.location_id || invoice.location_id;
                        const quantity = parseInt(lineItem.quantity) || 0;

                        if (!variationId || quantity <= 0) continue;

                        const key = `${variationId}:${locationId}`;
                        const existing = committedQuantities.get(key) || 0;
                        committedQuantities.set(key, existing + quantity);
                    }

                    invoicesProcessed++;
                } catch (error) {
                    logger.warn('Failed to process invoice for committed inventory', {
                        invoice_id: invoice.id,
                        error: error.message
                    });
                }

                // Small delay to avoid rate limiting
                await sleep(50);
            }
        } while (cursor);

        // Insert committed quantities into inventory_counts
        let recordsInserted = 0;
        for (const [key, quantity] of committedQuantities) {
            const [variationId, locationId] = key.split(':');

            try {
                await db.query(`
                    INSERT INTO inventory_counts (
                        catalog_object_id, location_id, state, quantity, merchant_id, updated_at
                    )
                    VALUES ($1, $2, 'RESERVED_FOR_SALE', $3, $4, CURRENT_TIMESTAMP)
                    ON CONFLICT (catalog_object_id, location_id, state, merchant_id) DO UPDATE SET
                        quantity = EXCLUDED.quantity,
                        updated_at = CURRENT_TIMESTAMP
                `, [variationId, locationId, quantity, merchantId]);
                recordsInserted++;
            } catch (error) {
                logger.warn('Failed to insert committed inventory record', {
                    variation_id: variationId,
                    location_id: locationId,
                    quantity,
                    merchantId,
                    error: error.message
                });
            }
        }

        logger.info('Committed inventory sync complete', {
            invoices_processed: invoicesProcessed,
            committed_records: recordsInserted,
            total_committed_items: committedQuantities.size
        });

        return recordsInserted;
    } catch (error) {
        logger.error('Committed inventory sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Run full sync of all data from Square
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} Sync summary
 */
async function fullSync(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for fullSync');
    }
    logger.info('Starting full Square sync', { merchantId });
    const startTime = Date.now();

    const summary = {
        success: true,
        errors: [],
        locations: 0,
        vendors: 0,
        catalog: {},
        inventory: 0,
        committedInventory: 0,
        salesVelocity: {}
    };

    try {
        // Step 1: Sync locations
        try {
            summary.locations = await syncLocations(merchantId);
        } catch (error) {
            summary.errors.push(`Locations: ${error.message}`);
        }

        // Step 2: Sync vendors
        try {
            summary.vendors = await syncVendors(merchantId);
        } catch (error) {
            summary.errors.push(`Vendors: ${error.message}`);
        }

        // Step 3: Sync catalog
        try {
            summary.catalog = await syncCatalog(merchantId);
        } catch (error) {
            summary.errors.push(`Catalog: ${error.message}`);
        }

        // Step 4: Sync inventory
        try {
            summary.inventory = await syncInventory(merchantId);
        } catch (error) {
            summary.errors.push(`Inventory: ${error.message}`);
        }

        // Step 5: Sync committed inventory from open invoices
        try {
            summary.committedInventory = await syncCommittedInventory(merchantId);
        } catch (error) {
            summary.errors.push(`Committed inventory: ${error.message}`);
        }

        // Step 6: Sync sales velocity for all periods (optimized - single API fetch)
        try {
            summary.salesVelocity = await syncSalesVelocityAllPeriods(merchantId);
        } catch (error) {
            summary.errors.push(`Sales velocity: ${error.message}`);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info('Full Square sync complete', { duration_seconds: duration });

        if (summary.errors.length > 0) {
            logger.warn('Errors encountered during full sync', { errors: summary.errors });
            summary.success = false;
        }

        return summary;
    } catch (error) {
        logger.error('Full sync failed', { error: error.message, stack: error.stack });
        summary.success = false;
        summary.errors.push(error.message);
        return summary;
    }
}

/**
 * Fix location mismatches by setting items and variations to present_at_all_locations = true
 * This resolves issues where variations are enabled at different locations than their parent items
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @returns {Promise<Object>} Summary of fixes applied
 */
async function fixLocationMismatches(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for fixLocationMismatches');
    }
    logger.info('Starting location mismatch fix', { merchantId });

    const summary = {
        success: true,
        itemsFixed: 0,
        variationsFixed: 0,
        errors: [],
        details: []
    };

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Fetch all catalog items with their variations
        let cursor = null;
        const itemsToFix = [];
        const variationsToFix = [];

        do {
            const params = new URLSearchParams({
                types: 'ITEM,ITEM_VARIATION'
            });
            if (cursor) {
                params.append('cursor', cursor);
            }

            const data = await makeSquareRequest(`/v2/catalog/list?${params.toString()}`, { accessToken });
            const objects = data.objects || [];

            for (const obj of objects) {
                // Check if has any location-specific settings that need clearing
                const hasLocationRestrictions = !obj.present_at_all_locations ||
                    (obj.present_at_location_ids && obj.present_at_location_ids.length > 0) ||
                    (obj.absent_at_location_ids && obj.absent_at_location_ids.length > 0);

                if (hasLocationRestrictions) {
                    if (obj.type === 'ITEM') {
                        itemsToFix.push({
                            id: obj.id,
                            version: obj.version,
                            type: 'ITEM',
                            name: obj.item_data?.name || 'Unknown',
                            item_data: obj.item_data,  // Store full data for update
                            present_at_location_ids: obj.present_at_location_ids || [],
                            absent_at_location_ids: obj.absent_at_location_ids || []
                        });
                    } else if (obj.type === 'ITEM_VARIATION') {
                        variationsToFix.push({
                            id: obj.id,
                            version: obj.version,
                            type: 'ITEM_VARIATION',
                            name: obj.item_variation_data?.name || 'Unknown',
                            sku: obj.item_variation_data?.sku || '',
                            item_id: obj.item_variation_data?.item_id,
                            item_variation_data: obj.item_variation_data,  // Store full data for update
                            present_at_location_ids: obj.present_at_location_ids || [],
                            absent_at_location_ids: obj.absent_at_location_ids || []
                        });
                    }
                }
            }

            cursor = data.cursor;
        } while (cursor);

        // Dedupe by ID (in case same object appears multiple times)
        const seenIds = new Set();
        const uniqueItems = itemsToFix.filter(obj => {
            if (seenIds.has(obj.id)) return false;
            seenIds.add(obj.id);
            return true;
        });
        const uniqueVariations = variationsToFix.filter(obj => {
            if (seenIds.has(obj.id)) return false;
            seenIds.add(obj.id);
            return true;
        });

        logger.info('Found items/variations with location restrictions to clear', {
            itemsCount: uniqueItems.length,
            variationsCount: uniqueVariations.length
        });

        const batchSize = 100;

        // Helper function to process a batch
        const processBatch = async (batch, batchNumber, objectType) => {
            // Build objects with required data fields - clear all location restrictions
            const objectsForBatch = batch.map(obj => {
                const updateObj = {
                    type: obj.type,
                    id: obj.id,
                    version: obj.version,
                    present_at_all_locations: true,
                    present_at_location_ids: [],  // Clear specific location IDs
                    absent_at_location_ids: []    // Clear absent location IDs
                };

                // Include required data field based on type
                if (obj.type === 'ITEM' && obj.item_data) {
                    updateObj.item_data = obj.item_data;
                } else if (obj.type === 'ITEM_VARIATION' && obj.item_variation_data) {
                    updateObj.item_variation_data = obj.item_variation_data;
                }

                return updateObj;
            });

            const idempotencyKey = generateIdempotencyKey('fix-locations-batch');

            try {
                const response = await makeSquareRequest('/v2/catalog/batch-upsert', {
                    method: 'POST',
                    body: JSON.stringify({
                        idempotency_key: idempotencyKey,
                        batches: [{ objects: objectsForBatch }]
                    }),
                    accessToken
                });

                const updatedCount = response.objects?.length || 0;

                for (const obj of batch) {
                    if (obj.type === 'ITEM') {
                        summary.itemsFixed++;
                    } else {
                        summary.variationsFixed++;
                    }
                    summary.details.push({
                        type: obj.type,
                        id: obj.id,
                        name: obj.name,
                        sku: obj.sku || '',
                        status: 'fixed'
                    });
                }

                logger.info(`${objectType} batch updated successfully`, {
                    batchNumber,
                    objectsInBatch: batch.length,
                    updatedCount
                });

                return true;
            } catch (batchError) {
                logger.error(`${objectType} batch update failed`, {
                    batchNumber,
                    error: batchError.message
                });
                summary.errors.push(`${objectType} batch ${batchNumber} failed: ${batchError.message}`);

                for (const obj of batch) {
                    summary.details.push({
                        type: obj.type,
                        id: obj.id,
                        name: obj.name,
                        sku: obj.sku || '',
                        status: 'failed',
                        error: batchError.message
                    });
                }
                return false;
            }
        };

        // PHASE 1: Process all ITEMS first (parent items must be fixed before variations)
        logger.info('Phase 1: Fixing parent items first');
        for (let i = 0; i < uniqueItems.length; i += batchSize) {
            const batch = uniqueItems.slice(i, i + batchSize);
            await processBatch(batch, Math.floor(i / batchSize) + 1, 'ITEM');
            if (i + batchSize < uniqueItems.length) {
                await sleep(500);
            }
        }

        // PHASE 2: Process all VARIATIONS (now that parent items are fixed)
        logger.info('Phase 2: Fixing variations');
        for (let i = 0; i < uniqueVariations.length; i += batchSize) {
            const batch = uniqueVariations.slice(i, i + batchSize);
            await processBatch(batch, Math.floor(i / batchSize) + 1, 'VARIATION');
            if (i + batchSize < uniqueVariations.length) {
                await sleep(500);
            }
        }

        logger.info('Location mismatch fix complete', {
            itemsFixed: summary.itemsFixed,
            variationsFixed: summary.variationsFixed,
            errors: summary.errors.length
        });

        if (summary.errors.length > 0) {
            summary.success = false;
        }

        return summary;

    } catch (error) {
        logger.error('Location mismatch fix failed', { error: error.message, stack: error.stack });
        summary.success = false;
        summary.errors.push(error.message);
        return summary;
    }
}

// ========================================
// CUSTOM ATTRIBUTE MANAGEMENT
// ========================================

/**
 * List all custom attribute definitions from Square Catalog
 * @param {Object} options - Options object
 * @param {number} options.merchantId - The merchant ID (required)
 * @returns {Promise<Array>} Array of custom attribute definitions
 */
async function listCustomAttributeDefinitions(options = {}) {
    const { merchantId } = options;
    logger.info('Fetching custom attribute definitions from Square', { merchantId });

    // Get access token for this merchant
    const accessToken = await getMerchantToken(merchantId);

    try {
        let cursor = null;
        const definitions = [];

        do {
            const endpoint = `/v2/catalog/list?types=CUSTOM_ATTRIBUTE_DEFINITION${cursor ? `&cursor=${cursor}` : ''}`;
            const data = await makeSquareRequest(endpoint, { accessToken });

            const objects = data.objects || [];
            for (const obj of objects) {
                if (obj.type === 'CUSTOM_ATTRIBUTE_DEFINITION') {
                    definitions.push({
                        id: obj.id,
                        version: obj.version,
                        key: obj.custom_attribute_definition_data?.key,
                        name: obj.custom_attribute_definition_data?.name,
                        description: obj.custom_attribute_definition_data?.description,
                        type: obj.custom_attribute_definition_data?.type,
                        allowed_object_types: obj.custom_attribute_definition_data?.allowed_object_types,
                        seller_visibility: obj.custom_attribute_definition_data?.seller_visibility,
                        app_visibility: obj.custom_attribute_definition_data?.app_visibility,
                        source_application: obj.custom_attribute_definition_data?.source_application
                    });
                }
            }

            cursor = data.cursor;
        } while (cursor);

        logger.info('Custom attribute definitions fetched', { count: definitions.length });
        return definitions;
    } catch (error) {
        logger.error('Failed to list custom attribute definitions', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Create or update a custom attribute definition in Square
 * @param {Object} definition - Definition configuration
 * @param {string} definition.key - Unique key for the attribute (lowercase, underscores)
 * @param {string} definition.name - Display name
 * @param {string} definition.description - Description
 * @param {string} definition.type - STRING, NUMBER, SELECTION, etc.
 * @param {Array} definition.allowed_object_types - ITEM, ITEM_VARIATION, etc.
 * @param {Object} options - Options object
 * @param {number} options.merchantId - The merchant ID (required)
 * @returns {Promise<Object>} Created/updated definition
 */
async function upsertCustomAttributeDefinition(definition, options = {}) {
    const { merchantId } = options;
    logger.info('Creating/updating custom attribute definition', { key: definition.key, merchantId });

    // Get access token for this merchant
    const accessToken = await getMerchantToken(merchantId);

    try {
        const idempotencyKey = generateIdempotencyKey('custom-attr-def');

        const requestBody = {
            idempotency_key: idempotencyKey,
            object: {
                type: 'CUSTOM_ATTRIBUTE_DEFINITION',
                id: definition.id || `#${definition.key}`,  // Use temp ID if creating new
                custom_attribute_definition_data: {
                    type: definition.type || 'STRING',
                    name: definition.name,
                    description: definition.description || '',
                    allowed_object_types: definition.allowed_object_types || ['ITEM_VARIATION'],
                    seller_visibility: definition.seller_visibility || 'SELLER_VISIBILITY_READ_WRITE_VALUES',
                    app_visibility: definition.app_visibility || 'APP_VISIBILITY_READ_WRITE_VALUES',
                    key: definition.key
                }
            }
        };

        // Add version if updating existing definition
        if (definition.version) {
            requestBody.object.version = definition.version;
        }

        // For NUMBER type, add number_config
        if (definition.type === 'NUMBER') {
            requestBody.object.custom_attribute_definition_data.number_config = {
                precision: definition.precision || 0  // 0 = integer
            };
        }

        // For SELECTION type, add selection_config
        if (definition.type === 'SELECTION' && definition.selections) {
            requestBody.object.custom_attribute_definition_data.selection_config = {
                allowed_selections: definition.selections.map((sel, idx) => ({
                    uid: sel.uid || `sel-${idx}`,
                    name: sel.name
                })),
                max_allowed_selections: definition.max_selections || 1
            };
        }

        const data = await makeSquareRequest('/v2/catalog/object', {
            accessToken,
            method: 'POST',
            body: JSON.stringify(requestBody)
        });

        logger.info('Custom attribute definition created/updated', {
            key: definition.key,
            id: data.catalog_object?.id
        });

        return {
            success: true,
            definition: data.catalog_object,
            id_mappings: data.id_mappings
        };
    } catch (error) {
        logger.error('Failed to create/update custom attribute definition', {
            key: definition.key,
            error: error.message
        });
        throw error;
    }
}

/**
 * Update custom attribute values on a catalog object (item or variation)
 * @param {string} catalogObjectId - The item or variation ID
 * @param {Object} customAttributeValues - Key-value pairs of custom attributes
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Updated catalog object
 */
async function updateCustomAttributeValues(catalogObjectId, customAttributeValues, options = {}) {
    const { merchantId } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for updateCustomAttributeValues');
    }

    logger.info('Updating custom attribute values', { catalogObjectId, keys: Object.keys(customAttributeValues), merchantId });

    // Get merchant-specific access token
    const accessToken = await getMerchantToken(merchantId);

    try {
        // First, retrieve the current catalog object to get its version and type
        const retrieveData = await makeSquareRequest(`/v2/catalog/object/${catalogObjectId}?include_related_objects=false`, { accessToken });

        if (!retrieveData.object) {
            throw new Error(`Catalog object not found: ${catalogObjectId}`);
        }

        const currentObject = retrieveData.object;
        const objectType = currentObject.type;

        // Merge new custom attributes with existing ones (preserve existing values)
        const existingCustomAttrs = currentObject.custom_attribute_values || {};
        const mergedCustomAttrs = {
            ...existingCustomAttrs,
            ...customAttributeValues
        };

        // Build the update request
        const idempotencyKey = generateIdempotencyKey('custom-attr-update');

        const updateObj = {
            type: objectType,
            id: catalogObjectId,
            version: currentObject.version,
            custom_attribute_values: mergedCustomAttrs
        };

        // Include required data field based on type
        if (objectType === 'ITEM' && currentObject.item_data) {
            updateObj.item_data = currentObject.item_data;
        } else if (objectType === 'ITEM_VARIATION' && currentObject.item_variation_data) {
            updateObj.item_variation_data = currentObject.item_variation_data;
        }

        const requestBody = {
            idempotency_key: idempotencyKey,
            object: updateObj
        };

        const data = await makeSquareRequest('/v2/catalog/object', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken
        });

        logger.info('Custom attribute values updated', {
            catalogObjectId,
            merchantId,
            newVersion: data.catalog_object?.version
        });

        return {
            success: true,
            catalog_object: data.catalog_object,
            id_mappings: data.id_mappings
        };
    } catch (error) {
        logger.error('Failed to update custom attribute values', {
            catalogObjectId,
            merchantId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Batch update custom attribute values on multiple catalog objects
 * @param {Array<Object>} updates - Array of {catalogObjectId, customAttributeValues}
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Batch update result
 */
async function batchUpdateCustomAttributeValues(updates, options = {}) {
    const { merchantId } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for batchUpdateCustomAttributeValues');
    }

    logger.info('Batch updating custom attribute values', { count: updates.length, merchantId });

    // Get merchant-specific access token
    const accessToken = await getMerchantToken(merchantId);

    const results = {
        success: true,
        updated: 0,
        failed: 0,
        errors: []
    };

    // Process in batches of 100 (Square API limit)
    const batchSize = 100;

    for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);

        // For batch upsert, we need to fetch all objects first to get their versions
        const objectIds = batch.map(u => u.catalogObjectId);

        try {
            // Batch retrieve objects
            const retrieveData = await makeSquareRequest('/v2/catalog/batch-retrieve', {
                method: 'POST',
                body: JSON.stringify({
                    object_ids: objectIds,
                    include_related_objects: false
                }),
                accessToken
            });

            const objectMap = new Map();
            for (const obj of (retrieveData.objects || [])) {
                objectMap.set(obj.id, obj);
            }

            // Build batch update objects
            const updateObjects = [];

            for (const update of batch) {
                const currentObject = objectMap.get(update.catalogObjectId);
                if (!currentObject) {
                    results.failed++;
                    results.errors.push({ id: update.catalogObjectId, error: 'Object not found' });
                    continue;
                }

                const updateObj = {
                    type: currentObject.type,
                    id: update.catalogObjectId,
                    version: currentObject.version,
                    custom_attribute_values: update.customAttributeValues
                };

                // Include required data field based on type
                if (currentObject.type === 'ITEM' && currentObject.item_data) {
                    updateObj.item_data = currentObject.item_data;
                } else if (currentObject.type === 'ITEM_VARIATION' && currentObject.item_variation_data) {
                    updateObj.item_variation_data = currentObject.item_variation_data;
                }

                updateObjects.push(updateObj);
            }

            if (updateObjects.length === 0) continue;

            // Batch upsert
            const idempotencyKey = generateIdempotencyKey('custom-attr-batch');

            const upsertData = await makeSquareRequest('/v2/catalog/batch-upsert', {
                method: 'POST',
                body: JSON.stringify({
                    idempotency_key: idempotencyKey,
                    batches: [{ objects: updateObjects }]
                }),
                accessToken
            });

            results.updated += upsertData.objects?.length || 0;

        } catch (error) {
            logger.error('Batch custom attribute update failed', {
                batchStart: i,
                merchantId,
                error: error.message
            });
            results.failed += batch.length;
            results.errors.push({ batch: Math.floor(i / batchSize), error: error.message });
        }

        // Small delay between batches
        if (i + batchSize < updates.length) {
            await sleep(200);
        }
    }

    results.success = results.failed === 0;
    logger.info('Batch custom attribute update complete', results);
    return results;
}

/**
 * Initialize custom attribute definitions in Square
 * Creates the standard attribute definitions we use (case_pack_quantity, brand)
 * @param {Object} options - Options object
 * @param {number} options.merchantId - The merchant ID (required)
 * @returns {Promise<Object>} Initialization result
 */
async function initializeCustomAttributes(options = {}) {
    const { merchantId } = options;
    logger.info('Initializing custom attribute definitions', { merchantId });

    // In multi-tenant mode, merchantId is required
    if (!merchantId) {
        logger.warn('initializeCustomAttributes called without merchantId - skipping in multi-tenant mode');
        return {
            success: false,
            skipped: true,
            error: 'merchantId is required in multi-tenant mode',
            definitions: [],
            errors: []
        };
    }

    const results = {
        success: true,
        definitions: [],
        errors: []
    };

    // Define our custom attributes
    // Note: reorder_multiple removed - case_pack_quantity serves the same purpose
    const customDefinitions = [
        {
            key: 'case_pack_quantity',
            name: 'Case Pack Quantity',
            description: 'Number of units per case for ordering full cases',
            type: 'NUMBER',
            precision: 0,  // Integer
            allowed_object_types: ['ITEM_VARIATION']
        },
        {
            key: 'brand',
            name: 'Brand',
            description: 'Product brand name for Google Merchant Center and marketing',
            type: 'STRING',
            allowed_object_types: ['ITEM']
        },
        {
            key: 'expiration_date',
            name: 'Expiration Date',
            description: 'Product expiration/best-by date for inventory management',
            type: 'STRING',  // Store as YYYY-MM-DD string
            allowed_object_types: ['ITEM_VARIATION']
        },
        {
            key: 'does_not_expire',
            name: 'Does Not Expire',
            description: 'Flag indicating product does not have an expiration date',
            type: 'BOOLEAN',
            allowed_object_types: ['ITEM_VARIATION']
        },
        {
            key: 'expiry_reviewed_at',
            name: 'Expiry Reviewed At',
            description: 'Timestamp when expiration date was last verified/audited',
            type: 'STRING',  // Store as ISO timestamp string
            allowed_object_types: ['ITEM_VARIATION']
        },
        {
            key: 'expiry_reviewed_by',
            name: 'Expiry Reviewed By',
            description: 'User who last verified/audited the expiration date',
            type: 'STRING',
            allowed_object_types: ['ITEM_VARIATION']
        }
    ];

    // Check existing definitions
    const existingDefs = await listCustomAttributeDefinitions({ merchantId });
    const existingByKey = new Map(existingDefs.map(d => [d.key, d]));

    for (const def of customDefinitions) {
        try {
            const existing = existingByKey.get(def.key);
            if (existing) {
                // Update with existing ID and version
                def.id = existing.id;
                def.version = existing.version;
                logger.info('Updating existing custom attribute definition', { key: def.key, id: existing.id });
            }

            const result = await upsertCustomAttributeDefinition(def, { merchantId });
            results.definitions.push({
                key: def.key,
                id: result.definition?.id,
                status: existing ? 'updated' : 'created'
            });
        } catch (error) {
            results.errors.push({ key: def.key, error: error.message });
            results.success = false;
        }
    }

    logger.info('Custom attributes initialization complete', {
        created: results.definitions.filter(d => d.status === 'created').length,
        updated: results.definitions.filter(d => d.status === 'updated').length,
        errors: results.errors.length
    });

    return results;
}

/**
 * Push local case_pack_quantity values to Square for all variations
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Push result
 */
async function pushCasePackToSquare(options = {}) {
    const { merchantId } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for pushCasePackToSquare');
    }

    logger.info('Pushing case pack quantities to Square', { merchantId });

    try {
        // Get all variations with case_pack_quantity set for this merchant
        const result = await db.query(`
            SELECT id, case_pack_quantity
            FROM variations
            WHERE case_pack_quantity IS NOT NULL
              AND case_pack_quantity > 0
              AND is_deleted = FALSE
              AND merchant_id = $1
        `, [merchantId]);

        if (result.rows.length === 0) {
            logger.info('No case pack quantities to push', { merchantId });
            return { success: true, updated: 0, message: 'No case pack quantities found' };
        }

        const updates = result.rows.map(row => ({
            catalogObjectId: row.id,
            customAttributeValues: {
                case_pack_quantity: {
                    number_value: row.case_pack_quantity.toString()
                }
            }
        }));

        logger.info('Pushing case pack quantities', { count: updates.length, merchantId });
        return await batchUpdateCustomAttributeValues(updates, { merchantId });
    } catch (error) {
        logger.error('Failed to push case pack quantities', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Push local brand assignments to Square for all items
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Push result
 */
async function pushBrandsToSquare(options = {}) {
    const { merchantId } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for pushBrandsToSquare');
    }

    logger.info('Pushing brands to Square', { merchantId });

    try {
        // Get all items with brand assignments for this merchant
        const result = await db.query(`
            SELECT i.id, b.name as brand_name
            FROM items i
            JOIN item_brands ib ON i.id = ib.item_id AND ib.merchant_id = $1
            JOIN brands b ON ib.brand_id = b.id AND b.merchant_id = $1
            WHERE i.is_deleted = FALSE
              AND i.merchant_id = $1
        `, [merchantId]);

        if (result.rows.length === 0) {
            logger.info('No brand assignments to push', { merchantId });
            return { success: true, updated: 0, message: 'No brand assignments found' };
        }

        const updates = result.rows.map(row => ({
            catalogObjectId: row.id,
            customAttributeValues: {
                brand: {
                    string_value: row.brand_name
                }
            }
        }));

        logger.info('Pushing brand assignments', { count: updates.length, merchantId });
        return await batchUpdateCustomAttributeValues(updates, { merchantId });
    } catch (error) {
        logger.error('Failed to push brand assignments', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Push local expiration dates to Square for all variations
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Push result
 */
async function pushExpiryDatesToSquare(options = {}) {
    const { merchantId } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for pushExpiryDatesToSquare');
    }

    logger.info('Pushing expiry dates to Square', { merchantId });

    try {
        // Get all variations with expiration data for this merchant
        const result = await db.query(`
            SELECT ve.variation_id, ve.expiration_date, ve.does_not_expire
            FROM variation_expiration ve
            JOIN variations v ON ve.variation_id = v.id AND v.merchant_id = $1
            WHERE v.is_deleted = FALSE
              AND ve.merchant_id = $1
              AND (ve.expiration_date IS NOT NULL OR ve.does_not_expire = TRUE)
        `, [merchantId]);

        if (result.rows.length === 0) {
            logger.info('No expiry dates to push', { merchantId });
            return { success: true, updated: 0, message: 'No expiry dates found' };
        }

        const updates = result.rows.map(row => {
            const customAttributeValues = {};

            // Add expiration_date if set
            if (row.expiration_date) {
                // Format date as YYYY-MM-DD string
                const dateStr = new Date(row.expiration_date).toISOString().split('T')[0];
                customAttributeValues.expiration_date = {
                    string_value: dateStr
                };
            }

            // Add does_not_expire flag
            if (row.does_not_expire === true) {
                customAttributeValues.does_not_expire = {
                    boolean_value: true
                };
            } else if (row.does_not_expire === false && row.expiration_date) {
                // Only set to false if there's an actual expiration date
                customAttributeValues.does_not_expire = {
                    boolean_value: false
                };
            }

            return {
                catalogObjectId: row.variation_id,
                customAttributeValues
            };
        });

        // Filter out any updates with empty customAttributeValues
        const validUpdates = updates.filter(u => Object.keys(u.customAttributeValues).length > 0);

        if (validUpdates.length === 0) {
            logger.info('No valid expiry date updates to push', { merchantId });
            return { success: true, updated: 0, message: 'No valid expiry dates to push' };
        }

        logger.info('Pushing expiry dates', { count: validUpdates.length, merchantId });
        return await batchUpdateCustomAttributeValues(validUpdates, { merchantId });
    } catch (error) {
        logger.error('Failed to push expiry dates', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Delete a custom attribute definition from Square
 * WARNING: This also deletes all custom attribute values using this definition
 * @param {string} definitionIdOrKey - The definition ID or key
 * @returns {Promise<Object>} Deletion result
 */
async function deleteCustomAttributeDefinition(definitionIdOrKey, options = {}) {
    const { merchantId } = options;
    logger.info('Deleting custom attribute definition', { definitionIdOrKey, merchantId });

    // Get access token for this merchant
    const accessToken = await getMerchantToken(merchantId);

    try {
        let definitionId = definitionIdOrKey;

        // If it looks like a key (no hyphens/typical Square ID format), look it up
        if (!definitionIdOrKey.includes('-') && definitionIdOrKey.length < 30) {
            const definitions = await listCustomAttributeDefinitions({ merchantId });
            const found = definitions.find(d => d.key === definitionIdOrKey);
            if (!found) {
                throw new Error(`Custom attribute definition not found with key: ${definitionIdOrKey}`);
            }
            definitionId = found.id;
            logger.info('Found definition ID for key', { key: definitionIdOrKey, id: definitionId });
        }

        const data = await makeSquareRequest(`/v2/catalog/object/${definitionId}`, {
            accessToken,
            method: 'DELETE'
        });

        logger.info('Custom attribute definition deleted', { definitionId });

        return {
            success: true,
            deleted_object_ids: data.deleted_object_ids || [definitionId]
        };
    } catch (error) {
        logger.error('Failed to delete custom attribute definition', {
            definitionIdOrKey,
            error: error.message
        });
        throw error;
    }
}

/**
 * Update a single variation's price in Square
 * @param {string} variationId - The variation ID
 * @param {number} newPriceCents - The new price in cents
 * @param {string} currency - Currency code (default: CAD)
 * @param {number} merchantId - The merchant ID (required for multi-tenant)
 * @returns {Promise<Object>} Result of the catalog update
 */
async function updateVariationPrice(variationId, newPriceCents, currency = 'CAD', merchantId = null) {
    logger.info('Updating variation price in Square', { variationId, newPriceCents, currency, merchantId });

    if (!merchantId) {
        throw new Error('merchantId is required for updateVariationPrice');
    }

    // Get access token for this merchant
    const accessToken = await getMerchantToken(merchantId);

    try {
        // First, retrieve the current catalog object to get its version and existing data
        const retrieveData = await makeSquareRequest(`/v2/catalog/object/${variationId}?include_related_objects=false`, { accessToken });

        if (!retrieveData.object) {
            throw new Error(`Catalog object not found: ${variationId}`);
        }

        const currentObject = retrieveData.object;

        if (currentObject.type !== 'ITEM_VARIATION') {
            throw new Error(`Object is not a variation: ${currentObject.type}`);
        }

        const currentVariationData = currentObject.item_variation_data || {};

        // Update the price_money field
        const updatedVariationData = {
            ...currentVariationData,
            price_money: {
                amount: newPriceCents,
                currency: currency
            }
        };

        // Build the update request
        const idempotencyKey = generateIdempotencyKey('price-update');

        const updateBody = {
            idempotency_key: idempotencyKey,
            object: {
                type: 'ITEM_VARIATION',
                id: variationId,
                version: currentObject.version,
                item_variation_data: updatedVariationData
            }
        };

        const data = await makeSquareRequest('/v2/catalog/object', {
            accessToken,
            method: 'POST',
            body: JSON.stringify(updateBody)
        });

        logger.info('Variation price updated in Square', {
            variationId,
            oldPrice: currentVariationData.price_money?.amount,
            newPrice: newPriceCents,
            newVersion: data.catalog_object?.version
        });

        // Update local database to reflect the change
        await db.query(`
            UPDATE variations
            SET price_money = $1, currency = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3 AND merchant_id = $4
        `, [newPriceCents, currency, variationId, merchantId]);

        return {
            success: true,
            variationId,
            oldPriceCents: currentVariationData.price_money?.amount,
            newPriceCents,
            catalog_object: data.catalog_object
        };
    } catch (error) {
        logger.error('Failed to update variation price', {
            variationId,
            newPriceCents,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Batch update variation prices in Square
 * @param {Array<Object>} priceUpdates - Array of {variationId, newPriceCents, currency}
 * @param {number} merchantId - The merchant ID for database updates
 * @returns {Promise<Object>} Batch update result
 */
async function batchUpdateVariationPrices(priceUpdates, merchantId) {
    logger.info('Batch updating variation prices in Square', { count: priceUpdates.length, merchantId });

    const results = {
        success: true,
        updated: 0,
        failed: 0,
        errors: [],
        details: []
    };

    // Get access token for this merchant
    const accessToken = await getMerchantToken(merchantId);

    // Process in batches of 100 (Square API limit)
    const batchSize = 100;

    for (let i = 0; i < priceUpdates.length; i += batchSize) {
        const batch = priceUpdates.slice(i, i + batchSize);
        const variationIds = batch.map(u => u.variationId);

        try {
            // Batch retrieve objects to get current versions
            const retrieveData = await makeSquareRequest('/v2/catalog/batch-retrieve', {
                accessToken,
                method: 'POST',
                body: JSON.stringify({
                    object_ids: variationIds,
                    include_related_objects: false
                })
            });

            const objectMap = new Map();
            for (const obj of (retrieveData.objects || [])) {
                objectMap.set(obj.id, obj);
            }

            // Build batch update objects
            const updateObjects = [];

            for (const update of batch) {
                const currentObject = objectMap.get(update.variationId);
                if (!currentObject) {
                    results.failed++;
                    results.errors.push({ variationId: update.variationId, error: 'Object not found' });
                    results.details.push({
                        variationId: update.variationId,
                        success: false,
                        error: 'Object not found'
                    });
                    continue;
                }

                if (currentObject.type !== 'ITEM_VARIATION') {
                    results.failed++;
                    results.errors.push({ variationId: update.variationId, error: 'Not a variation' });
                    results.details.push({
                        variationId: update.variationId,
                        success: false,
                        error: 'Not a variation'
                    });
                    continue;
                }

                const currentVariationData = currentObject.item_variation_data || {};
                const oldPrice = currentVariationData.price_money?.amount;

                const updatedVariationData = {
                    ...currentVariationData,
                    price_money: {
                        amount: update.newPriceCents,
                        currency: update.currency || 'CAD'
                    }
                };

                updateObjects.push({
                    type: 'ITEM_VARIATION',
                    id: update.variationId,
                    version: currentObject.version,
                    item_variation_data: updatedVariationData
                });

                results.details.push({
                    variationId: update.variationId,
                    oldPriceCents: oldPrice,
                    newPriceCents: update.newPriceCents,
                    pending: true
                });
            }

            if (updateObjects.length === 0) continue;

            // Batch upsert
            const idempotencyKey = generateIdempotencyKey('price-batch');

            const upsertData = await makeSquareRequest('/v2/catalog/batch-upsert', {
                accessToken,
                method: 'POST',
                body: JSON.stringify({
                    idempotency_key: idempotencyKey,
                    batches: [{ objects: updateObjects }]
                })
            });

            // Count only ITEM_VARIATION objects, not related parent items returned by API
            const updatedCount = (upsertData.objects || []).filter(obj => obj.type === 'ITEM_VARIATION').length;
            results.updated += updatedCount;

            // Update local database for successfully updated variations
            for (const obj of updateObjects) {
                const update = batch.find(u => u.variationId === obj.id);
                if (update) {
                    await db.query(`
                        UPDATE variations
                        SET price_money = $1, currency = $2, updated_at = CURRENT_TIMESTAMP
                        WHERE id = $3 AND merchant_id = $4
                    `, [update.newPriceCents, update.currency || 'CAD', obj.id, merchantId]);

                    // Update the detail entry
                    const detailEntry = results.details.find(d => d.variationId === obj.id);
                    if (detailEntry) {
                        detailEntry.success = true;
                        delete detailEntry.pending;
                    }
                }
            }

            logger.info('Price batch updated successfully', {
                batchNumber: Math.floor(i / batchSize) + 1,
                objectsInBatch: updateObjects.length,
                updatedCount
            });

        } catch (error) {
            logger.error('Price batch update failed', {
                batchNumber: Math.floor(i / batchSize) + 1,
                error: error.message
            });

            // Mark all items in this batch as failed
            for (const update of batch) {
                const existingDetail = results.details.find(d => d.variationId === update.variationId);
                if (existingDetail && existingDetail.pending) {
                    // Item already has a pending detail entry - mark it as failed
                    existingDetail.success = false;
                    existingDetail.error = error.message;
                    delete existingDetail.pending;
                    results.failed++;
                } else if (!existingDetail) {
                    // No detail entry yet (error happened before processing) - create one
                    results.details.push({
                        variationId: update.variationId,
                        success: false,
                        error: error.message
                    });
                    results.failed++;
                }
            }
            results.errors.push({ batch: Math.floor(i / batchSize) + 1, error: error.message });
        }

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < priceUpdates.length) {
            await sleep(200);
        }
    }

    results.success = results.failed === 0;
    logger.info('Batch price update complete', {
        updated: results.updated,
        failed: results.failed,
        total: priceUpdates.length
    });

    return results;
}

/**
 * Update variation unit cost (vendor cost) in Square and local database
 * @param {string} variationId - The Square catalog object ID for the variation
 * @param {string} vendorId - The vendor ID for this cost
 * @param {number} newCostCents - The new cost in cents
 * @param {string} currency - The currency (default CAD)
 * @param {Object} options - Additional options
 * @param {number} options.merchantId - The merchant ID for multi-tenant support
 * @returns {Promise<Object>} Result with old/new cost info
 */
async function updateVariationCost(variationId, vendorId, newCostCents, currency = 'CAD', options = {}) {
    const { merchantId } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for updateVariationCost');
    }

    logger.info('Updating variation cost in Square', { variationId, vendorId, newCostCents, currency, merchantId });

    // Get merchant-specific access token
    const accessToken = await getMerchantToken(merchantId);

    try {
        // First, retrieve the current catalog object to get its version and existing data
        const retrieveData = await makeSquareRequest(`/v2/catalog/object/${variationId}?include_related_objects=false`, { accessToken });

        if (!retrieveData.object) {
            throw new Error(`Catalog object not found: ${variationId}`);
        }

        const currentObject = retrieveData.object;

        if (currentObject.type !== 'ITEM_VARIATION') {
            throw new Error(`Object is not a variation: ${currentObject.type}`);
        }

        const currentVariationData = currentObject.item_variation_data || {};
        const currentVendorInfo = currentVariationData.vendor_information || [];

        // Find old cost for the specified vendor
        const existingVendorIdx = currentVendorInfo.findIndex(v => v.vendor_id === vendorId);
        const oldCostCents = existingVendorIdx >= 0
            ? currentVendorInfo[existingVendorIdx].unit_cost_money?.amount
            : null;

        // Update or add vendor information
        let updatedVendorInfo;
        if (existingVendorIdx >= 0) {
            // Update existing vendor entry
            updatedVendorInfo = [...currentVendorInfo];
            updatedVendorInfo[existingVendorIdx] = {
                ...updatedVendorInfo[existingVendorIdx],
                unit_cost_money: {
                    amount: newCostCents,
                    currency: currency
                }
            };
        } else {
            // Add new vendor entry
            updatedVendorInfo = [
                ...currentVendorInfo,
                {
                    vendor_id: vendorId,
                    unit_cost_money: {
                        amount: newCostCents,
                        currency: currency
                    }
                }
            ];
        }

        // Build the update request
        const idempotencyKey = generateIdempotencyKey('cost-update');

        const updateBody = {
            idempotency_key: idempotencyKey,
            object: {
                type: 'ITEM_VARIATION',
                id: variationId,
                version: currentObject.version,
                item_variation_data: {
                    ...currentVariationData,
                    vendor_information: updatedVendorInfo
                }
            }
        };

        const data = await makeSquareRequest('/v2/catalog/object', {
            method: 'POST',
            body: JSON.stringify(updateBody),
            accessToken
        });

        logger.info('Variation cost updated in Square', {
            variationId,
            vendorId,
            merchantId,
            oldCost: oldCostCents,
            newCost: newCostCents,
            newVersion: data.catalog_object?.version
        });

        // Update local database to reflect the change (upsert)
        await db.query(`
            INSERT INTO variation_vendors (variation_id, vendor_id, unit_cost_money, currency, merchant_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
                unit_cost_money = EXCLUDED.unit_cost_money,
                currency = EXCLUDED.currency,
                updated_at = CURRENT_TIMESTAMP
        `, [variationId, vendorId, newCostCents, currency, merchantId]);

        return {
            success: true,
            variationId,
            vendorId,
            oldCostCents,
            newCostCents,
            catalog_object: data.catalog_object
        };
    } catch (error) {
        logger.error('Failed to update variation cost', {
            variationId,
            vendorId,
            merchantId,
            newCostCents,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

module.exports = {
    syncLocations,
    syncVendors,
    syncCatalog,
    syncInventory,
    syncCommittedInventory,
    syncSalesVelocity,
    syncSalesVelocityAllPeriods,
    fullSync,
    getSquareInventoryCount,
    setSquareInventoryCount,
    setSquareInventoryAlertThreshold,
    fixLocationMismatches,
    // Custom attribute functions
    listCustomAttributeDefinitions,
    upsertCustomAttributeDefinition,
    updateCustomAttributeValues,
    batchUpdateCustomAttributeValues,
    initializeCustomAttributes,
    pushCasePackToSquare,
    pushBrandsToSquare,
    pushExpiryDatesToSquare,
    deleteCustomAttributeDefinition,
    // Price update functions
    updateVariationPrice,
    batchUpdateVariationPrices,
    // Cost update functions
    updateVariationCost,
    // Utility functions (for expiry discount module)
    generateIdempotencyKey,
    makeSquareRequest,
    getMerchantToken
};
