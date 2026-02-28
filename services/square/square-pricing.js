/**
 * Square Pricing — Price, Cost & Catalog Content Updates
 *
 * Handles variation price updates, vendor cost updates, and catalog content
 * (description, SEO) batch updates. Cross-module dependency on square-vendors.js
 * for ensureVendorsExist (used by updateVariationCost).
 *
 * Exports:
 *   batchUpdateVariationPrices(priceUpdates, merchantId)
 *   updateVariationCost(variationId, vendorId, newCostCents, currency, options)
 *   batchUpdateCatalogContent(merchantId, updates)
 *
 * Usage:
 *   const { batchUpdateVariationPrices } = require('./square-pricing');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('./square-client');
const { ensureVendorsExist } = require('./square-vendors');

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
    const COST_UPDATE_MAX_RETRIES = 3;

    if (!merchantId) {
        throw new Error('merchantId is required for updateVariationCost');
    }

    logger.info('Updating variation cost in Square', { variationId, vendorId, newCostCents, currency, merchantId });

    // Get merchant-specific access token
    const accessToken = await getMerchantToken(merchantId);

    let oldCostCents = null;

    for (let attempt = 1; attempt <= COST_UPDATE_MAX_RETRIES; attempt++) {
        try {
            // Retrieve the current catalog object to get its version and existing data
            // This is done inside the retry loop to get the latest version on each attempt
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
            oldCostCents = existingVendorIdx >= 0
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

            // Build the update request - use unique key per attempt to avoid idempotency conflicts
            const idempotencyKey = generateIdempotencyKey(`cost-update-${attempt}`);

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
                newVersion: data.catalog_object?.version,
                attempt
            });

            // Ensure vendor exists locally before upserting variation_vendors
            await ensureVendorsExist([vendorId], merchantId);

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
            // Check if this is a VERSION_MISMATCH error that we can retry
            const isVersionMismatch = error.message && error.message.includes('VERSION_MISMATCH');

            if (isVersionMismatch && attempt < COST_UPDATE_MAX_RETRIES) {
                logger.warn('VERSION_MISMATCH on cost update, retrying with fresh version', {
                    variationId,
                    vendorId,
                    attempt,
                    maxRetries: COST_UPDATE_MAX_RETRIES
                });
                // Small delay before retry to allow concurrent updates to complete
                await sleep(100 * attempt);
                continue;
            }

            // Check if parent item is not enabled at the location
            // Detect via structured Square error fields (preferred) or message string (fallback)
            // NOTE: O-4 scoping bug — currentVariationData may be undefined if error occurs
            // before the retrieve succeeds. Preserved as-is per extraction rules (document, don't fix).
            const squareErrors = error.squareErrors || [];
            const hasStructuredLocationMismatch = squareErrors.some(e =>
                e.code === 'INVALID_VALUE' && e.field === 'item_id'
            );
            const hasMessageLocationMismatch = error.message &&
                error.message.includes('is enabled at unit') &&
                error.message.includes('of type ITEM is not');
            const isLocationMismatch = hasStructuredLocationMismatch || hasMessageLocationMismatch;

            if (isLocationMismatch) {
                const parentItemId = currentVariationData?.item_id || null;
                logger.warn('Parent item not enabled at location - location mismatch', {
                    variationId,
                    parentItemId,
                    merchantId,
                    error: error.message
                });
                error.code = 'ITEM_NOT_AT_LOCATION';
                error.parentItemId = parentItemId;
            }

            // Non-retryable error or max retries reached
            logger.error('Failed to update variation cost', {
                variationId,
                vendorId,
                merchantId,
                newCostCents,
                attempt,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
}

/**
 * Batch update catalog content (description, SEO title, SEO description)
 * Used by AI autofill feature to push generated content to Square
 *
 * @param {number} merchantId - The merchant ID
 * @param {Array<Object>} updates - Array of { itemId, fieldType, value }
 *   - fieldType: 'description' | 'seo_title' | 'seo_description'
 * @returns {Promise<Object>} - { succeeded: [], failed: [] }
 */
async function batchUpdateCatalogContent(merchantId, updates) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }
    if (!updates || updates.length === 0) {
        return { succeeded: [], failed: [] };
    }

    const accessToken = await getMerchantToken(merchantId);
    const results = { succeeded: [], failed: [] };

    // Get unique item IDs
    const itemIds = [...new Set(updates.map(u => u.itemId))];

    try {
        // Batch retrieve current catalog objects to get versions
        const retrieveData = await makeSquareRequest('/v2/catalog/batch-retrieve', {
            method: 'POST',
            body: JSON.stringify({
                object_ids: itemIds,
                include_related_objects: false
            }),
            accessToken
        });

        const objectMap = new Map();
        for (const obj of (retrieveData.objects || [])) {
            if (obj.type === 'ITEM') {
                objectMap.set(obj.id, obj);
            }
        }

        // Group updates by item ID for merging
        const updatesByItem = new Map();
        for (const update of updates) {
            if (!updatesByItem.has(update.itemId)) {
                updatesByItem.set(update.itemId, []);
            }
            updatesByItem.get(update.itemId).push(update);
        }

        // Build batch update objects
        const updateObjects = [];

        for (const [itemId, itemUpdates] of updatesByItem) {
            const currentObject = objectMap.get(itemId);
            if (!currentObject) {
                for (const u of itemUpdates) {
                    results.failed.push({ itemId, fieldType: u.fieldType, error: 'Item not found in Square' });
                }
                continue;
            }

            // Clone current item_data and apply updates
            const itemData = { ...currentObject.item_data };

            for (const update of itemUpdates) {
                if (update.fieldType === 'description') {
                    itemData.description = update.value;
                } else if (update.fieldType === 'seo_title' || update.fieldType === 'seo_description') {
                    // Initialize ecom_seo_data if not present
                    if (!itemData.ecom_seo_data) {
                        itemData.ecom_seo_data = {};
                    }
                    if (update.fieldType === 'seo_title') {
                        itemData.ecom_seo_data.page_title = update.value;
                    } else {
                        itemData.ecom_seo_data.page_description = update.value;
                    }
                }
            }

            updateObjects.push({
                type: 'ITEM',
                id: itemId,
                version: currentObject.version,
                item_data: itemData
            });
        }

        if (updateObjects.length === 0) {
            return results;
        }

        // Batch upsert
        const idempotencyKey = generateIdempotencyKey('catalog-content-batch');

        const upsertData = await makeSquareRequest('/v2/catalog/batch-upsert', {
            method: 'POST',
            body: JSON.stringify({
                idempotency_key: idempotencyKey,
                batches: [{ objects: updateObjects }]
            }),
            accessToken
        });

        // Mark succeeded items
        const succeededIds = new Set((upsertData.objects || []).map(o => o.id));
        for (const update of updates) {
            if (succeededIds.has(update.itemId)) {
                results.succeeded.push({ itemId: update.itemId, fieldType: update.fieldType });
            }
        }

        // Update local database with new values
        for (const update of updates) {
            if (succeededIds.has(update.itemId)) {
                try {
                    let query;
                    if (update.fieldType === 'description') {
                        query = 'UPDATE items SET description = $1 WHERE id = $2 AND merchant_id = $3';
                    } else if (update.fieldType === 'seo_title') {
                        query = 'UPDATE items SET seo_title = $1 WHERE id = $2 AND merchant_id = $3';
                    } else if (update.fieldType === 'seo_description') {
                        query = 'UPDATE items SET seo_description = $1 WHERE id = $2 AND merchant_id = $3';
                    }
                    if (query) {
                        await db.query(query, [update.value, update.itemId, merchantId]);
                    }
                } catch (dbError) {
                    logger.warn('Failed to update local DB after Square update', {
                        itemId: update.itemId,
                        fieldType: update.fieldType,
                        error: dbError.message
                    });
                    // Don't fail the overall operation - Square update succeeded
                }
            }
        }

        logger.info('Batch catalog content update complete', {
            merchantId,
            total: updates.length,
            succeeded: results.succeeded.length,
            failed: results.failed.length
        });

    } catch (error) {
        logger.error('Batch catalog content update failed', {
            merchantId,
            error: error.message,
            stack: error.stack
        });

        // Mark all remaining as failed
        for (const update of updates) {
            if (!results.succeeded.find(s => s.itemId === update.itemId && s.fieldType === update.fieldType)) {
                results.failed.push({ itemId: update.itemId, fieldType: update.fieldType, error: error.message });
            }
        }
    }

    return results;
}

module.exports = {
    batchUpdateVariationPrices,
    updateVariationCost,
    batchUpdateCatalogContent
};
