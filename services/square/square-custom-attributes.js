/**
 * Square Custom Attributes — CRUD & Push Helpers
 *
 * Manages custom attribute definitions and values in the Square catalog.
 * Handles initialization, upsert, batch updates, and push operations for
 * case_pack_quantity, brand, expiration_date, does_not_expire, etc.
 *
 * Exports:
 *   listCustomAttributeDefinitions(options)
 *   upsertCustomAttributeDefinition(definition, options)
 *   updateCustomAttributeValues(catalogObjectId, customAttributeValues, options)
 *   batchUpdateCustomAttributeValues(updates, options)
 *   initializeCustomAttributes(options)
 *   pushCasePackToSquare(options)
 *   pushBrandsToSquare(options)
 *   pushExpiryDatesToSquare(options)
 *   deleteCustomAttributeDefinition(definitionIdOrKey, options)
 *
 * Usage:
 *   const { initializeCustomAttributes } = require('./square-custom-attributes');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('./square-client');

const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../../config/constants');

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
        let paginationIterations = 0;

        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/catalog/list (custom-attrs)' });
                break;
            }
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

module.exports = {
    listCustomAttributeDefinitions,
    upsertCustomAttributeDefinition,
    updateCustomAttributeValues,
    batchUpdateCustomAttributeValues,
    initializeCustomAttributes,
    pushCasePackToSquare,
    pushBrandsToSquare,
    pushExpiryDatesToSquare,
    deleteCustomAttributeDefinition
};
