/**
 * Square Catalog Sync
 *
 * Handles full and delta catalog synchronization from Square's Catalog API.
 * Syncs categories, images, items, and variations (including vendor info,
 * custom attributes, and expiration data).
 *
 * Exports:
 *   syncCatalog(merchantId)      — full catalog sync with deletion detection
 *   deltaSyncCatalog(merchantId) — incremental sync since last timestamp
 *
 * Usage:
 *   const { syncCatalog, deltaSyncCatalog } = require('./square-catalog-sync');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep } = require('./square-client');
const { ensureVendorsExist } = require('./square-vendors');

const { SQUARE: { MAX_PAGINATION_ITERATIONS }, SYNC: { BATCH_DELAY_MS } } = require('../../config/constants');

// Maximum objects from delta sync before falling back to full sync
// At higher counts, individual upserts are less efficient than a full sync
const DELTA_SYNC_FALLBACK_THRESHOLD = 100;

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
        let paginationIterations = 0;

        // Fetch ALL catalog objects in one pass - building maps first
        // ITEM_VARIATION removed from types — variations are extracted from item_data.variations
        // on each ITEM object, reducing API response size and page count
        // Use include_related_objects=true to get category associations
        logger.info('Starting catalog fetch', { merchantId });
        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/catalog/list' });
                break;
            }
            const endpoint = `/v2/catalog/list?types=ITEM,IMAGE,CATEGORY&include_deleted_objects=false&include_related_objects=true${cursor ? `&cursor=${cursor}` : ''}`;
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
                        // Extract variations from item_data.variations (full CatalogObject representations)
                        if (obj.item_data?.variations) {
                            for (const varObj of obj.item_data.variations) {
                                variationsMap.set(varObj.id, varObj);
                            }
                        }
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

            if (cursor) await sleep(BATCH_DELAY_MS);
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
                logger.error('Failed to sync category', { id, error: error.message, stack: error.stack });
            }
        }
        logger.info('Categories synced', { count: stats.categories });

        // 2. Insert images
        for (const [id, img] of imagesMap) {
            try {
                await syncImage({ id, image_data: img }, merchantId);
                stats.images++;
            } catch (error) {
                logger.error('Failed to sync image', { id, error: error.message, stack: error.stack });
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
                logger.error('Failed to sync item', { id, error: error.message, stack: error.stack });
            }
        }
        logger.info('Items synced', { count: stats.items });

        // 4. Insert variations
        const variationInventorySummary = { tracked: 0, alertEnabled: 0, totalOverrides: 0 };
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

                // Collect inventory summary
                if (varData.track_inventory) variationInventorySummary.tracked++;
                if (varData.location_overrides?.some(o => o.inventory_alert_type === 'LOW_QUANTITY')) {
                    variationInventorySummary.alertEnabled++;
                }
                variationInventorySummary.totalOverrides += varData.location_overrides?.length || 0;
            } catch (error) {
                logger.error('Failed to sync variation', { id, error: error.message, stack: error.stack });
            }
        }

        logger.info('Synced inventory fields for variations', {
            merchantId,
            variationsSynced: stats.variations,
            trackingInventory: variationInventorySummary.tracked,
            lowQuantityAlerts: variationInventorySummary.alertEnabled,
            locationOverrides: variationInventorySummary.totalOverrides
        });

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

        // Seed delta timestamp so next webhook can use delta sync instead of full
        // Use current time in RFC 3339 format (Square's expected format)
        const now = new Date().toISOString();
        await _updateDeltaTimestamp(merchantId, now);
        logger.info('Delta timestamp seeded after full sync', { merchantId, timestamp: now });

        return stats;
    } catch (error) {
        logger.error('Catalog sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Delta sync catalog — fetch only objects changed since last sync.
 * Uses Square's SearchCatalogObjects with begin_time filter.
 * Falls back to full syncCatalog if no prior timestamp or too many changes.
 *
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} Sync stats (items, variations, categories, images, etc.)
 */
async function deltaSyncCatalog(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for deltaSyncCatalog');
    }

    // Get last delta timestamp from sync_history
    const historyResult = await db.query(
        'SELECT last_delta_timestamp FROM sync_history WHERE sync_type = $1 AND merchant_id = $2',
        ['catalog', merchantId]
    );

    const lastTimestamp = historyResult.rows[0]?.last_delta_timestamp;

    if (!lastTimestamp) {
        logger.info('No previous delta timestamp — falling back to full catalog sync', { merchantId });
        return syncCatalog(merchantId);
    }

    logger.info('Starting delta catalog sync', { merchantId, since: lastTimestamp });

    const stats = {
        categories: 0,
        images: 0,
        items: 0,
        variations: 0,
        variationVendors: 0,
        items_deleted: 0,
        variations_deleted: 0,
        deltaSync: true
    };

    const itemsMap = new Map();
    const variationsMap = new Map();
    const imagesMap = new Map();
    const categoriesMap = new Map();
    const deletedItemIds = [];
    const deletedVariationIds = [];

    try {
        const accessToken = await getMerchantToken(merchantId);
        let cursor = null;
        let totalObjects = 0;
        let latestTime = null;
        let paginationIterations = 0;

        // Fetch changed objects using SearchCatalogObjects with begin_time
        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/catalog/search' });
                break;
            }
            const requestBody = {
                begin_time: lastTimestamp,
                object_types: ['ITEM', 'ITEM_VARIATION', 'IMAGE', 'CATEGORY'],
                include_related_objects: true,
                include_deleted_objects: true,
                limit: 1000
            };
            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/catalog/search', {
                accessToken,
                method: 'POST',
                body: JSON.stringify(requestBody)
            });

            const objects = data.objects || [];
            const relatedObjects = data.related_objects || [];
            totalObjects += objects.length;

            // Capture latest_time from response (use for next delta sync)
            if (data.latest_time) {
                latestTime = data.latest_time;
            }

            // Check if too many changes — fall back to full sync
            if (totalObjects > DELTA_SYNC_FALLBACK_THRESHOLD) {
                logger.warn('Delta sync returned too many objects — falling back to full sync', {
                    merchantId,
                    objectCount: totalObjects,
                    threshold: DELTA_SYNC_FALLBACK_THRESHOLD
                });
                return syncCatalog(merchantId);
            }

            // Process related objects (categories referenced by changed items)
            for (const obj of relatedObjects) {
                if (obj.type === 'CATEGORY') {
                    const categoryName = obj.category_data?.name || obj.name || 'Uncategorized';
                    categoriesMap.set(obj.id, { name: categoryName });
                }
            }

            // Classify changed objects
            for (const obj of objects) {
                // Handle deleted objects
                if (obj.is_deleted) {
                    if (obj.type === 'ITEM') {
                        deletedItemIds.push(obj.id);
                    } else if (obj.type === 'ITEM_VARIATION') {
                        deletedVariationIds.push(obj.id);
                    }
                    continue;
                }

                switch (obj.type) {
                    case 'ITEM':
                        itemsMap.set(obj.id, obj);
                        // Also extract nested variations from item_data.variations
                        // Guards against cases where Square returns a changed ITEM
                        // but doesn't separately emit its variations as ITEM_VARIATION objects
                        if (obj.item_data?.variations) {
                            for (const varObj of obj.item_data.variations) {
                                if (!varObj.is_deleted) {
                                    variationsMap.set(varObj.id, varObj);
                                } else {
                                    deletedVariationIds.push(varObj.id);
                                }
                            }
                        }
                        break;
                    case 'ITEM_VARIATION':
                        variationsMap.set(obj.id, obj);
                        break;
                    case 'IMAGE':
                        imagesMap.set(obj.id, obj.image_data);
                        break;
                    case 'CATEGORY':
                        const categoryName = obj.category_data?.name || obj.name || 'Uncategorized';
                        categoriesMap.set(obj.id, { name: categoryName });
                        break;
                }
            }

            cursor = data.cursor;
        } while (cursor);

        logger.info('Delta sync objects fetched', {
            merchantId,
            items: itemsMap.size,
            variations: variationsMap.size,
            images: imagesMap.size,
            categories: categoriesMap.size,
            deletedItems: deletedItemIds.length,
            deletedVariations: deletedVariationIds.length,
            totalObjects
        });

        // If nothing changed, just update timestamp and return
        if (totalObjects === 0) {
            logger.info('Delta sync: no changes since last sync', { merchantId });
            if (latestTime) {
                await _updateDeltaTimestamp(merchantId, latestTime);
            }
            return stats;
        }

        // Upsert categories
        for (const [id, cat] of categoriesMap) {
            try {
                await syncCategory({ id, category_data: cat }, merchantId);
                stats.categories++;
            } catch (error) {
                logger.error('Delta sync: failed to sync category', { id, error: error.message });
            }
        }

        // Upsert images
        for (const [id, img] of imagesMap) {
            try {
                await syncImage({ id, image_data: img }, merchantId);
                stats.images++;
            } catch (error) {
                logger.error('Delta sync: failed to sync image', { id, error: error.message });
            }
        }

        // Upsert items (need category name resolution)
        for (const [id, itemObj] of itemsMap) {
            try {
                const itemData = itemObj.item_data;
                let categoryId = null;
                let categoryName = null;

                if (itemData.categories && itemData.categories.length > 0) {
                    categoryId = itemData.categories[0].id;
                    categoryName = categoriesMap.get(categoryId)?.name || null;
                }
                if (!categoryId && itemData.category_id) {
                    categoryId = itemData.category_id;
                    categoryName = categoriesMap.get(categoryId)?.name || null;
                }
                if (!categoryId && itemData.reporting_category?.id) {
                    categoryId = itemData.reporting_category.id;
                    categoryName = categoriesMap.get(categoryId)?.name || null;
                }

                // If category not in delta response, look up from DB
                if (categoryId && !categoryName) {
                    const catResult = await db.query(
                        'SELECT name FROM categories WHERE id = $1 AND merchant_id = $2',
                        [categoryId, merchantId]
                    );
                    categoryName = catResult.rows[0]?.name || null;
                }

                itemObj.item_data.category_id = categoryId;
                await syncItem(itemObj, categoryName, merchantId);
                stats.items++;
            } catch (error) {
                logger.error('Delta sync: failed to sync item', { id, error: error.message });
            }
        }

        // Upsert variations
        let variationInventorySummary = { tracked: 0, alertEnabled: 0, totalOverrides: 0 };
        for (const [id, varObj] of variationsMap) {
            try {
                const varData = varObj.item_variation_data;
                // For delta sync, parent item may not be in this batch — check DB
                if (!itemsMap.has(varData.item_id)) {
                    const parentCheck = await db.query(
                        'SELECT id FROM items WHERE id = $1 AND merchant_id = $2 AND is_deleted = FALSE',
                        [varData.item_id, merchantId]
                    );
                    if (parentCheck.rows.length === 0) {
                        logger.warn('Delta sync: skipping variation — parent item not found', {
                            variation_id: id,
                            item_id: varData.item_id
                        });
                        continue;
                    }
                }
                const vendorCount = await syncVariation(varObj, merchantId);
                stats.variations++;
                stats.variationVendors += vendorCount;

                // Collect summary instead of per-variation logging
                if (varData.track_inventory) variationInventorySummary.tracked++;
                if (varData.location_overrides?.some(o => o.inventory_alert_type === 'LOW_QUANTITY')) {
                    variationInventorySummary.alertEnabled++;
                }
                variationInventorySummary.totalOverrides += varData.location_overrides?.length || 0;
            } catch (error) {
                logger.error('Delta sync: failed to sync variation', { id, error: error.message });
            }
        }

        if (stats.variations > 0) {
            logger.info('Delta sync: variation inventory summary', {
                merchantId,
                variationsSynced: stats.variations,
                trackingInventory: variationInventorySummary.tracked,
                lowQuantityAlerts: variationInventorySummary.alertEnabled,
                locationOverrides: variationInventorySummary.totalOverrides
            });
        }

        // Process deletions from delta response (objects with is_deleted: true)
        for (const itemId of deletedItemIds) {
            try {
                await db.query(
                    'UPDATE items SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND merchant_id = $2',
                    [itemId, merchantId]
                );
                const invResult = await db.query(`
                    UPDATE inventory_counts SET quantity = 0, updated_at = CURRENT_TIMESTAMP
                    WHERE merchant_id = $2 AND catalog_object_id IN (
                        SELECT id FROM variations WHERE item_id = $1 AND merchant_id = $2
                    )
                `, [itemId, merchantId]);
                stats.items_deleted++;
                logger.info('Delta sync: item marked deleted', { itemId, inventoryZeroed: invResult.rowCount });
            } catch (error) {
                logger.error('Delta sync: failed to mark item deleted', { itemId, error: error.message });
            }
        }

        for (const variationId of deletedVariationIds) {
            try {
                await db.query(
                    'UPDATE variations SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND merchant_id = $2',
                    [variationId, merchantId]
                );
                await db.query(
                    'UPDATE inventory_counts SET quantity = 0, updated_at = CURRENT_TIMESTAMP WHERE catalog_object_id = $1 AND merchant_id = $2',
                    [variationId, merchantId]
                );
                stats.variations_deleted++;
            } catch (error) {
                logger.error('Delta sync: failed to mark variation deleted', { variationId, error: error.message });
            }
        }

        // Update stored timestamp for next delta sync
        if (latestTime) {
            await _updateDeltaTimestamp(merchantId, latestTime);
        }

        logger.info('Delta catalog sync complete', { merchantId, ...stats });
        return stats;
    } catch (error) {
        // On any error, log and fall back to full sync
        logger.error('Delta catalog sync failed — falling back to full sync', {
            merchantId,
            error: error.message,
            stack: error.stack
        });
        return syncCatalog(merchantId);
    }
}

/**
 * Update the stored delta timestamp for next SearchCatalogObjects call.
 * @param {number} merchantId
 * @param {string} latestTime - Square's latest_time from SearchCatalogObjects response
 * @private
 */
async function _updateDeltaTimestamp(merchantId, latestTime) {
    try {
        await db.query(`
            INSERT INTO sync_history (sync_type, merchant_id, last_delta_timestamp, status, started_at, completed_at)
            VALUES ('catalog', $1, $2, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                last_delta_timestamp = EXCLUDED.last_delta_timestamp
        `, [merchantId, latestTime]);
    } catch (error) {
        logger.warn('Failed to update delta timestamp', { merchantId, error: error.message });
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

    // Per-variation inventory logging removed — see summary log in syncCatalog/deltaSyncCatalog

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
                logger.error('Error syncing location override', { variation_id: obj.id, location_id: override.location_id, error: error.message, stack: error.stack });
            }
        }
    }

    // Sync vendor information - clear existing and replace with fresh data from Square
    // First, delete all existing vendor relationships for this variation
    await db.query('DELETE FROM variation_vendors WHERE variation_id = $1 AND merchant_id = $2', [obj.id, merchantId]);

    if (data.vendor_information && Array.isArray(data.vendor_information)) {
        // Ensure referenced vendors exist locally before inserting (prevents FK violations
        // when deltaSyncCatalog runs before vendor webhooks are processed)
        const vendorIds = data.vendor_information
            .map(vi => vi.vendor_id)
            .filter(Boolean);
        await ensureVendorsExist(vendorIds, merchantId);

        for (const vendorInfo of data.vendor_information) {
            // Skip entries without vendor_id - these are just cost data without a linked vendor
            // (This is normal for items with costs but no vendor assigned)
            if (!vendorInfo.vendor_id) {
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
                // Vendor deleted from Square and on-demand fetch also failed — skip this link
                logger.warn('Skipping variation_vendor — vendor not in DB after on-demand fetch', {
                    vendor_id: vendorInfo.vendor_id, variation_id: obj.id, error: error.message
                });
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

module.exports = {
    syncCatalog,
    deltaSyncCatalog
};
