/**
 * Square Diagnostics — Fix & Audit Operations
 *
 * Catalog repair tools for fixing location mismatches, enabling inventory
 * alerts, and enabling items at all locations. Single consumer:
 * services/catalog/audit-service.js.
 *
 * Exports:
 *   fixLocationMismatches(merchantId)
 *   fixInventoryAlerts(merchantId)
 *   enableItemAtAllLocations(itemId, merchantId)
 *
 * Usage:
 *   const { fixLocationMismatches } = require('./square-diagnostics');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('./square-client');

const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../../config/constants');

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
        let paginationIterations = 0;

        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/catalog/list (fix-locations)' });
                break;
            }
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

/**
 * Enable LOW_QUANTITY inventory alerts (threshold 0) on all variations with alerts off.
 * Reads variation IDs from local DB, fetches current versions from Square via batch-retrieve,
 * then batch-upserts with inventory_alert_type = LOW_QUANTITY.
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} Summary of fixes applied
 */
async function fixInventoryAlerts(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for fixInventoryAlerts');
    }
    logger.info('Starting inventory alerts fix', { merchantId });

    const summary = {
        success: true,
        variationsFixed: 0,
        totalFound: 0,
        errors: [],
        details: []
    };

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Step 1: Query local DB for variations with alerts off (physical products only)
        const dbResult = await db.query(
            `SELECT v.id, v.name, v.sku
             FROM variations v
             JOIN items i ON v.item_id = i.id AND i.merchant_id = v.merchant_id
             WHERE v.merchant_id = $1
               AND (i.product_type IS NULL OR i.product_type = 'REGULAR')
               AND (v.inventory_alert_type IS NULL OR v.inventory_alert_type != 'LOW_QUANTITY')`,
            [merchantId]
        );

        const variationsToFix = dbResult.rows;
        summary.totalFound = variationsToFix.length;

        if (variationsToFix.length === 0) {
            logger.info('No variations need inventory alert fixes', { merchantId });
            return summary;
        }

        logger.info('Found variations needing inventory alerts', {
            merchantId,
            count: variationsToFix.length
        });

        // Step 2: Batch-retrieve current objects from Square (need version + full data)
        const batchSize = 100;
        const retrievedObjects = new Map();

        for (let i = 0; i < variationsToFix.length; i += batchSize) {
            const batch = variationsToFix.slice(i, i + batchSize);
            const objectIds = batch.map(v => v.id);

            const data = await makeSquareRequest('/v2/catalog/batch-retrieve', {
                method: 'POST',
                body: JSON.stringify({ object_ids: objectIds, include_related_objects: false }),
                accessToken
            });

            for (const obj of (data.objects || [])) {
                retrievedObjects.set(obj.id, obj);
            }

            if (i + batchSize < variationsToFix.length) {
                await sleep(500);
            }
        }

        // Step 3: Batch-upsert with alerts enabled
        const objectsToUpdate = [];
        for (const variation of variationsToFix) {
            const squareObj = retrievedObjects.get(variation.id);
            if (!squareObj) {
                summary.details.push({
                    id: variation.id,
                    name: variation.name,
                    sku: variation.sku || '',
                    status: 'skipped',
                    error: 'Not found in Square'
                });
                continue;
            }

            objectsToUpdate.push({
                id: squareObj.id,
                version: squareObj.version,
                name: variation.name,
                sku: variation.sku || '',
                item_variation_data: squareObj.item_variation_data
            });
        }

        for (let i = 0; i < objectsToUpdate.length; i += batchSize) {
            const batch = objectsToUpdate.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize) + 1;

            const objectsForBatch = batch.map(obj => ({
                type: 'ITEM_VARIATION',
                id: obj.id,
                version: obj.version,
                item_variation_data: {
                    ...obj.item_variation_data,
                    inventory_alert_type: 'LOW_QUANTITY',
                    inventory_alert_threshold: 0
                }
            }));

            try {
                await makeSquareRequest('/v2/catalog/batch-upsert', {
                    method: 'POST',
                    body: JSON.stringify({
                        idempotency_key: generateIdempotencyKey('fix-alerts-batch'),
                        batches: [{ objects: objectsForBatch }]
                    }),
                    accessToken
                });

                for (const obj of batch) {
                    summary.variationsFixed++;
                    summary.details.push({
                        id: obj.id,
                        name: obj.name,
                        sku: obj.sku,
                        status: 'fixed'
                    });
                }

                logger.info('Inventory alerts batch updated', { batchNumber, count: batch.length });
            } catch (batchError) {
                logger.error('Inventory alerts batch failed', {
                    batchNumber,
                    error: batchError.message
                });
                summary.errors.push(`Batch ${batchNumber} failed: ${batchError.message}`);

                for (const obj of batch) {
                    summary.details.push({
                        id: obj.id,
                        name: obj.name,
                        sku: obj.sku,
                        status: 'failed',
                        error: batchError.message
                    });
                }
            }

            if (i + batchSize < objectsToUpdate.length) {
                await sleep(500);
            }
        }

        logger.info('Inventory alerts fix complete', {
            variationsFixed: summary.variationsFixed,
            totalFound: summary.totalFound,
            errors: summary.errors.length
        });

        if (summary.errors.length > 0) {
            summary.success = false;
        }

        return summary;

    } catch (error) {
        logger.error('Inventory alerts fix failed', { error: error.message, stack: error.stack });
        summary.success = false;
        summary.errors.push(error.message);
        return summary;
    }
}

/**
 * Enable a single parent item at all locations in Square
 * Used when a variation is active at a location but its parent item is not
 * @param {string} itemId - The Square catalog item ID to enable
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @returns {Promise<Object>} Result with item details
 */
async function enableItemAtAllLocations(itemId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for enableItemAtAllLocations');
    }
    if (!itemId) {
        throw new Error('itemId is required for enableItemAtAllLocations');
    }

    logger.info('Enabling item at all locations', { itemId, merchantId });
    const accessToken = await getMerchantToken(merchantId);

    // Retrieve current item to get version and data
    const retrieveData = await makeSquareRequest(
        `/v2/catalog/object/${itemId}?include_related_objects=false`,
        { accessToken }
    );

    if (!retrieveData.object) {
        throw new Error(`Catalog item not found: ${itemId}`);
    }

    const currentObject = retrieveData.object;
    if (currentObject.type !== 'ITEM') {
        throw new Error(`Object is not an ITEM: ${currentObject.type}`);
    }

    const idempotencyKey = generateIdempotencyKey('enable-item-locations');

    const updateBody = {
        idempotency_key: idempotencyKey,
        object: {
            type: 'ITEM',
            id: itemId,
            version: currentObject.version,
            present_at_all_locations: true,
            present_at_location_ids: [],
            absent_at_location_ids: [],
            item_data: currentObject.item_data
        }
    };

    const data = await makeSquareRequest('/v2/catalog/object', {
        method: 'POST',
        body: JSON.stringify(updateBody),
        accessToken
    });

    logger.info('Item enabled at all locations', {
        itemId,
        merchantId,
        itemName: currentObject.item_data?.name,
        newVersion: data.catalog_object?.version
    });

    return {
        success: true,
        itemId,
        itemName: currentObject.item_data?.name || 'Unknown',
        newVersion: data.catalog_object?.version
    };
}

module.exports = {
    fixLocationMismatches,
    fixInventoryAlerts,
    enableItemAtAllLocations
};
