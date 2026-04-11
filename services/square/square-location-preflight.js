/**
 * Pre-flight location check for Square catalog upserts.
 *
 * Before batch-upserting ITEM_VARIATION objects, verifies that each
 * variation's parent ITEM is enabled at every location being updated.
 * Repairs any mismatches by calling enableItemAtAllLocations, then
 * returns how many parents were repaired.
 *
 * Used by pushMinStockThresholdsToSquare to prevent Square 400
 * INVALID_VALUE errors ("variation is enabled at location X but
 * referenced item is not").
 *
 * @module services/square/square-location-preflight
 */

const logger = require('../../utils/logger');
const { makeSquareRequest, sleep } = require('./square-client');
const { enableItemAtAllLocations } = require('./square-diagnostics');
const { SYNC: { CATALOG_BATCH_SIZE, INTER_BATCH_DELAY_MS } } = require('../../config/constants');

/**
 * Returns true if the Square ITEM object is enabled at the given location.
 * @param {Object} itemObj - Square catalog object of type ITEM
 * @param {string} locationId
 * @returns {boolean}
 */
function isItemEnabledAtLocation(itemObj, locationId) {
    if (itemObj.present_at_all_locations === true) return true;
    const presentAt = itemObj.present_at_location_ids || [];
    return presentAt.includes(locationId);
}

/**
 * Detect and repair parent ITEM location mismatches before a batch upsert.
 *
 * Steps:
 *  1. Extract parent item IDs from the retrieved variation objects.
 *  2. Batch-retrieve those parent items from Square.
 *  3. For each (variation, locationId) pair being synced, check whether the
 *     parent item is enabled at that location.
 *  4. For each mismatched parent, call enableItemAtAllLocations and await it.
 *     Repair failures are logged and do not abort remaining repairs.
 *
 * @param {number} merchantId
 * @param {string} accessToken - Square access token for this merchant
 * @param {Map<string, Object>} retrievedVariations - variationId → Square obj (from batch-retrieve)
 * @param {Map<string, Map<string, number>>} changesByVariation - variationId → Map<locationId, newMin>
 * @returns {Promise<{repairedParents: number}>}
 */
async function repairParentLocationMismatches(
    merchantId, accessToken, retrievedVariations, changesByVariation
) {
    // Step 1: Collect unique parent item IDs from the already-retrieved variation objects
    const variationToItemId = new Map();
    const parentItemIds = new Set();
    for (const [variationId, sqObj] of retrievedVariations.entries()) {
        const itemId = sqObj.item_variation_data?.item_id;
        if (itemId) {
            variationToItemId.set(variationId, itemId);
            parentItemIds.add(itemId);
        }
    }

    if (parentItemIds.size === 0) return { repairedParents: 0 };

    // Step 2: Batch-retrieve the parent ITEM objects from Square
    const itemIdList = [...parentItemIds];
    const parentItems = new Map();
    for (let i = 0; i < itemIdList.length; i += CATALOG_BATCH_SIZE) {
        const batch = itemIdList.slice(i, i + CATALOG_BATCH_SIZE);
        try {
            const data = await makeSquareRequest('/v2/catalog/batch-retrieve', {
                method: 'POST',
                body: JSON.stringify({ object_ids: batch, include_related_objects: false }),
                accessToken
            });
            for (const obj of (data.objects || [])) parentItems.set(obj.id, obj);
        } catch (err) {
            logger.warn('repairParentLocationMismatches: failed to retrieve parent items', {
                merchantId, batchSize: batch.length, error: err.message
            });
        }
        if (i + CATALOG_BATCH_SIZE < itemIdList.length) await sleep(INTER_BATCH_DELAY_MS);
    }

    // Step 3: Identify mismatched parent items
    const mismatchedItemIds = new Set();
    for (const [variationId, locationChanges] of changesByVariation.entries()) {
        const itemId = variationToItemId.get(variationId);
        if (!itemId) continue;
        const parentItem = parentItems.get(itemId);
        if (!parentItem) continue;
        for (const [locationId] of locationChanges.entries()) {
            if (!isItemEnabledAtLocation(parentItem, locationId)) {
                mismatchedItemIds.add(itemId);
                break;
            }
        }
    }

    if (mismatchedItemIds.size === 0) return { repairedParents: 0 };

    // Step 4: Repair each mismatch — await each one; failures are logged, not re-thrown
    const repairedIds = [];
    const failedIds = [];
    for (const itemId of mismatchedItemIds) {
        try {
            await enableItemAtAllLocations(itemId, merchantId);
            repairedIds.push(itemId);
        } catch (err) {
            logger.warn('repairParentLocationMismatches: repair failed for item', {
                merchantId, itemId, error: err.message
            });
            failedIds.push(itemId);
        }
    }

    logger.info('repairParentLocationMismatches complete', {
        merchantId, repaired: repairedIds, failed: failedIds
    });

    return { repairedParents: repairedIds.length };
}

module.exports = { repairParentLocationMismatches, isItemEnabledAtLocation };
