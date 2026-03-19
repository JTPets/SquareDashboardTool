/**
 * Vendor Catalog Create Service
 *
 * LOGIC CHANGE: bulk create items from vendor catalog
 *
 * Creates Square catalog items from unmatched vendor catalog entries.
 * Handles batching (100 items per Square API call), UPC dedup against
 * existing catalog, and local DB updates within a transaction.
 *
 * Exports:
 *   bulkCreateSquareItems(vendorCatalogIds, merchantId)
 *
 * Usage:
 *   const { bulkCreateSquareItems } = require('./catalog-create-service');
 */

const crypto = require('crypto');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('../square/square-client');

const SQUARE_BATCH_SIZE = 100;
const BATCH_DELAY_MS = 200;

/**
 * Fetch active tax IDs for a merchant from Square Catalog API
 * Called once per bulk create operation, not per item.
 * @param {string} accessToken - Square access token
 * @returns {Promise<string[]>} Array of Square tax object IDs
 */
async function fetchMerchantTaxIds(accessToken) {
    try {
        const data = await makeSquareRequest('/v2/catalog/list?types=TAX', { accessToken });
        const taxIds = (data.objects || [])
            .filter(obj => !obj.is_deleted)
            .map(obj => obj.id);
        return taxIds;
    } catch (error) {
        logger.warn('Failed to fetch tax configurations from Square — items will be created without tax_ids', {
            error: error.message
        });
        return [];
    }
}

/**
 * Bulk create Square catalog items from unmatched vendor catalog entries
 * @param {number[]} vendorCatalogIds - IDs of vendor_catalog_items to create
 * @param {number} merchantId - Merchant ID from req.merchantContext.id
 * @returns {Promise<Object>} { created, failed, errors }
 */
async function bulkCreateSquareItems(vendorCatalogIds, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for bulkCreateSquareItems');
    }
    if (!vendorCatalogIds || vendorCatalogIds.length === 0) {
        return { created: 0, failed: 0, errors: [] };
    }

    logger.info('Starting bulk create Square items from vendor catalog', {
        merchantId,
        requestedCount: vendorCatalogIds.length
    });

    const results = { created: 0, failed: 0, errors: [] };

    // 1. Fetch vendor catalog entries — only those belonging to this merchant
    const entries = await fetchVendorCatalogEntries(vendorCatalogIds, merchantId);

    // 2. Validate entries and partition into valid/invalid
    const { valid, invalid } = validateEntries(entries, vendorCatalogIds);
    results.errors.push(...invalid);
    results.failed += invalid.length;

    if (valid.length === 0) {
        return results;
    }

    // 3. Check for existing UPCs in our catalog to avoid duplicates
    const accessToken = await getMerchantToken(merchantId);
    const { toCreate, toMatch } = await checkExistingUPCs(valid, merchantId);

    // 3b. Fetch merchant's active tax IDs once for all batches
    const taxIds = await fetchMerchantTaxIds(accessToken);
    if (taxIds.length === 0) {
        logger.warn('No active tax configurations found for merchant', { merchantId });
    }

    // 4. Handle entries that match existing UPCs — link instead of create
    if (toMatch.length > 0) {
        const matchResults = await matchExistingItems(toMatch, merchantId);
        results.created += matchResults.matched;
    }

    if (toCreate.length === 0) {
        return results;
    }

    // 5. Create items in Square in batches of 100
    const batches = splitIntoBatches(toCreate, SQUARE_BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        try {
            const batchResult = await createSquareBatch(
                batch, merchantId, accessToken, taxIds
            );
            results.created += batchResult.created;
            results.failed += batchResult.failed;
            results.errors.push(...batchResult.errors);
        } catch (error) {
            logger.error('Square batch create failed', {
                batchIndex: i,
                merchantId,
                error: error.message
            });
            for (const entry of batch) {
                results.failed++;
                results.errors.push({
                    vendorCatalogId: entry.id,
                    error: `Batch failed: ${error.message}`
                });
            }
        }

        // Rate limit between batches
        if (i < batches.length - 1) {
            await sleep(BATCH_DELAY_MS);
        }
    }

    logger.info('Bulk create Square items complete', {
        merchantId,
        created: results.created,
        failed: results.failed
    });

    return results;
}

/**
 * Fetch vendor catalog entries by IDs, filtered by merchant
 */
async function fetchVendorCatalogEntries(ids, merchantId) {
    const result = await db.query(
        `SELECT id, vendor_id, vendor_name, product_name, upc,
                cost_cents, price_cents, matched_variation_id, vendor_item_number
         FROM vendor_catalog_items
         WHERE id = ANY($1) AND merchant_id = $2`,
        [ids, merchantId]
    );
    return result.rows;
}

/**
 * Validate entries: skip already matched, missing name, missing price
 */
function validateEntries(entries, requestedIds) {
    const valid = [];
    const invalid = [];
    const foundIds = new Set(entries.map(e => e.id));

    // IDs not found (wrong merchant or doesn't exist)
    for (const id of requestedIds) {
        if (!foundIds.has(id)) {
            invalid.push({ vendorCatalogId: id, error: 'Not found or belongs to different merchant' });
        }
    }

    for (const entry of entries) {
        if (entry.matched_variation_id) {
            invalid.push({ vendorCatalogId: entry.id, error: 'Already matched — skipped' });
            continue;
        }
        if (!entry.product_name || entry.product_name.trim() === '') {
            invalid.push({ vendorCatalogId: entry.id, error: 'Missing product name' });
            continue;
        }
        if (entry.price_cents === null || entry.price_cents === undefined) {
            invalid.push({ vendorCatalogId: entry.id, error: 'Missing price' });
            continue;
        }
        valid.push(entry);
    }

    return { valid, invalid };
}

/**
 * Check which UPCs already exist in our catalog
 * Returns entries split into toCreate and toMatch
 */
async function checkExistingUPCs(entries, merchantId) {
    const upcsToCheck = entries
        .filter(e => e.upc && e.upc.trim() !== '')
        .map(e => e.upc.trim());

    if (upcsToCheck.length === 0) {
        return { toCreate: entries, toMatch: [] };
    }

    const existingResult = await db.query(
        `SELECT id, upc, item_id FROM variations
         WHERE upc = ANY($1) AND merchant_id = $2
           AND (is_deleted = FALSE OR is_deleted IS NULL)`,
        [upcsToCheck, merchantId]
    );

    const existingUpcMap = new Map();
    for (const row of existingResult.rows) {
        existingUpcMap.set(row.upc, { variationId: row.id, itemId: row.item_id });
    }

    const toCreate = [];
    const toMatch = [];

    for (const entry of entries) {
        const upc = entry.upc ? entry.upc.trim() : '';
        if (upc && existingUpcMap.has(upc)) {
            toMatch.push({ entry, existing: existingUpcMap.get(upc) });
        } else {
            toCreate.push(entry);
        }
    }

    return { toCreate, toMatch };
}

/**
 * Match vendor catalog entries to existing variations by UPC
 */
async function matchExistingItems(matches, merchantId) {
    let matched = 0;

    await db.transaction(async (client) => {
        for (const { entry, existing } of matches) {
            await client.query(
                `UPDATE vendor_catalog_items
                 SET matched_variation_id = $1, match_method = 'upc', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 AND merchant_id = $3`,
                [existing.variationId, entry.id, merchantId]
            );
            matched++;
        }
    });

    logger.info('Matched vendor entries to existing items by UPC', {
        merchantId,
        matched
    });

    return { matched };
}

/**
 * Create a batch of items in Square and update local DB
 */
async function createSquareBatch(entries, merchantId, accessToken, taxIds = []) {
    const batchResult = { created: 0, failed: 0, errors: [] };

    // Build Square catalog objects
    const objects = [];
    const tempIdMap = new Map(); // #tempId -> entry

    for (const entry of entries) {
        const itemTempId = `#item_${entry.id}`;
        const varTempId = `#var_${entry.id}`;

        const variationData = {
            item_variation_data: {
                item_id: itemTempId,
                name: 'Regular',
                pricing_type: 'FIXED_PRICING',
                price_money: {
                    amount: entry.price_cents,
                    currency: 'CAD'
                }
            }
        };

        // Add UPC as SKU if provided
        if (entry.upc && entry.upc.trim()) {
            variationData.item_variation_data.upc = entry.upc.trim();
            variationData.item_variation_data.sku = entry.upc.trim();
        }

        // Add vendor cost information
        if (entry.cost_cents !== null && entry.cost_cents !== undefined && entry.vendor_id) {
            variationData.item_variation_data.vendor_information = [{
                vendor_id: entry.vendor_id,
                unit_cost_money: {
                    amount: entry.cost_cents,
                    currency: 'CAD'
                }
            }];
        }

        const itemData = {
            name: entry.product_name.trim(),
            variations: [{
                type: 'ITEM_VARIATION',
                id: varTempId,
                ...variationData
            }]
        };

        if (taxIds.length > 0) {
            itemData.tax_ids = taxIds;
        }

        const itemObject = {
            type: 'ITEM',
            id: itemTempId,
            item_data: itemData
        };

        objects.push(itemObject);
        tempIdMap.set(itemTempId, entry);
    }

    // Call Square BatchUpsertCatalogObjects
    const idempotencyKey = generateIdempotencyKey('vendor-bulk-create');

    const upsertData = await makeSquareRequest('/v2/catalog/batch-upsert', {
        accessToken,
        method: 'POST',
        body: JSON.stringify({
            idempotency_key: idempotencyKey,
            batches: [{ objects }]
        })
    });

    // Build map of temp IDs to real Square IDs
    const idMappings = new Map();
    if (upsertData.id_mappings) {
        for (const mapping of upsertData.id_mappings) {
            idMappings.set(mapping.client_object_id, mapping.object_id);
        }
    }

    // Update local DB in a transaction
    await db.transaction(async (client) => {
        for (const [itemTempId, entry] of tempIdMap) {
            const varTempId = `#var_${entry.id}`;
            const realItemId = idMappings.get(itemTempId);
            const realVarId = idMappings.get(varTempId);

            if (!realItemId || !realVarId) {
                batchResult.failed++;
                batchResult.errors.push({
                    vendorCatalogId: entry.id,
                    error: 'Square returned no ID mapping'
                });
                continue;
            }

            // INSERT into items table
            await client.query(
                `INSERT INTO items (id, name, merchant_id, created_at, updated_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO NOTHING`,
                [realItemId, entry.product_name.trim(), merchantId]
            );

            // INSERT into variations table
            await client.query(
                `INSERT INTO variations (id, item_id, name, sku, upc, price_money, currency, vendor_id, vendor_code, merchant_id, created_at, updated_at)
                 VALUES ($1, $2, 'Regular', $3, $4, $5, 'CAD', $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO NOTHING`,
                [realVarId, realItemId, entry.upc || null, entry.upc || null, entry.price_cents, entry.vendor_id || null, entry.vendor_item_number || null, merchantId]
            );

            // INSERT into variation_vendors if cost and vendor exist
            if (entry.cost_cents !== null && entry.cost_cents !== undefined && entry.vendor_id) {
                await client.query(
                    `INSERT INTO variation_vendors (variation_id, vendor_id, vendor_code, unit_cost_money, currency, merchant_id, updated_at)
                     VALUES ($1, $2, $3, $4, 'CAD', $5, CURRENT_TIMESTAMP)
                     ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
                         vendor_code = EXCLUDED.vendor_code,
                         unit_cost_money = EXCLUDED.unit_cost_money,
                         updated_at = CURRENT_TIMESTAMP`,
                    [realVarId, entry.vendor_id, entry.vendor_item_number || null, entry.cost_cents, merchantId]
                );
            }

            // UPDATE vendor_catalog_items match status
            await client.query(
                `UPDATE vendor_catalog_items
                 SET matched_variation_id = $1, match_method = 'created', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 AND merchant_id = $3`,
                [realVarId, entry.id, merchantId]
            );

            batchResult.created++;
        }
    });

    return batchResult;
}

/**
 * Split array into batches of given size
 */
function splitIntoBatches(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size) {
        batches.push(arr.slice(i, i + size));
    }
    return batches;
}

module.exports = {
    bulkCreateSquareItems,
    // Exported for testing
    fetchMerchantTaxIds,
    fetchVendorCatalogEntries,
    validateEntries,
    checkExistingUPCs,
    matchExistingItems,
    createSquareBatch,
    splitIntoBatches
};
