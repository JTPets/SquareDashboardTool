/**
 * Catalog Variation Service
 *
 * Business logic for variation queries and updates:
 * - Get variations with filtering
 * - Get variations with cost/margin data
 * - Update extended fields (case pack, shelf location, etc.)
 * - Update min stock threshold
 * - Update unit cost
 * - Bulk update operations
 *
 * Extracted from routes/catalog.js as part of P1-2 (fat routes service extraction).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');
const { batchResolveImageUrls } = require('../../utils/image-utils');

// Allowed fields for extended updates
const ALLOWED_EXTENDED_FIELDS = [
    'case_pack_quantity', 'stock_alert_min', 'stock_alert_max',
    'preferred_stock_level', 'shelf_location', 'bin_location',
    'reorder_multiple', 'discontinued', 'discontinue_date',
    'replacement_variation_id', 'supplier_item_number',
    'last_cost_cents', 'last_cost_date', 'notes'
];

// Allowed fields for bulk updates (subset of extended fields)
const ALLOWED_BULK_FIELDS = [
    'case_pack_quantity', 'stock_alert_min', 'stock_alert_max',
    'preferred_stock_level', 'shelf_location', 'bin_location',
    'reorder_multiple', 'discontinued', 'notes'
];

/**
 * Get variations with optional filtering
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} filters - Optional filters { item_id, sku, has_cost }
 * @returns {Promise<Object>} - { count, variations }
 */
async function getVariations(merchantId, filters = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getVariations');
    }

    const { item_id, sku, has_cost, search, limit } = filters;

    let query = `
        SELECT v.*, i.name as item_name, i.category_name, i.images as item_images
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        WHERE v.merchant_id = $1
    `;
    const params = [merchantId];

    if (item_id) {
        params.push(item_id);
        query += ` AND v.item_id = $${params.length}`;
    }

    if (sku) {
        params.push(`%${sku}%`);
        query += ` AND v.sku ILIKE $${params.length}`;
    }

    if (search) {
        params.push(`%${search}%`);
        const searchIdx = params.length;
        query += ` AND (i.name ILIKE $${searchIdx} OR v.name ILIKE $${searchIdx} OR v.sku ILIKE $${searchIdx})`;
    }

    if (has_cost === 'true' || has_cost === true) {
        query += ` AND EXISTS (SELECT 1 FROM variation_vendors vv WHERE vv.variation_id = v.id AND vv.merchant_id = $1)`;
    }

    query += ' ORDER BY i.name, v.name';

    if (limit) {
        params.push(parseInt(limit));
        query += ` LIMIT $${params.length}`;
    }

    const result = await db.query(query, params);

    // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
    const imageUrlMap = await batchResolveImageUrls(result.rows);

    const variations = result.rows.map((variation, index) => ({
        ...variation,
        item_images: undefined,  // Remove from response
        image_urls: imageUrlMap.get(index) || []
    }));

    return {
        count: variations.length,
        variations
    };
}

/**
 * Get variations with cost and margin information
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - { count, variations }
 */
async function getVariationsWithCosts(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getVariationsWithCosts');
    }

    const query = `
        SELECT
            v.id,
            v.sku,
            v.images,
            i.images as item_images,
            i.name as item_name,
            v.name as variation_name,
            v.price_money as retail_price_cents,
            vv.unit_cost_money as cost_cents,
            ve.name as vendor_name,
            vv.vendor_code,
            CASE
                WHEN v.price_money > 0 AND vv.unit_cost_money > 0
                THEN ROUND(((v.price_money - vv.unit_cost_money)::DECIMAL / v.price_money * 100), 2)
                ELSE NULL
            END as margin_percent,
            CASE
                WHEN v.price_money > 0 AND vv.unit_cost_money > 0
                THEN v.price_money - vv.unit_cost_money
                ELSE NULL
            END as profit_cents
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $1
        LEFT JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $1
        WHERE v.price_money IS NOT NULL AND v.merchant_id = $1
        ORDER BY i.name, v.name, ve.name
    `;

    const result = await db.query(query, [merchantId]);

    // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
    const imageUrlMap = await batchResolveImageUrls(result.rows);

    const variations = result.rows.map((variation, index) => ({
        ...variation,
        item_images: undefined,  // Remove from response
        image_urls: imageUrlMap.get(index) || []
    }));

    return {
        count: variations.length,
        variations
    };
}

/**
 * Verify a variation belongs to a merchant
 * @param {string} variationId - The variation ID
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<boolean>} - true if variation exists and belongs to merchant
 */
async function verifyVariationOwnership(variationId, merchantId) {
    const result = await db.query(
        'SELECT id FROM variations WHERE id = $1 AND merchant_id = $2',
        [variationId, merchantId]
    );
    return result.rows.length > 0;
}

/**
 * Update extended fields on a variation
 * @param {string} variationId - The variation ID
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - { success, variation, square_sync }
 */
async function updateExtendedFields(variationId, merchantId, updates) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateExtendedFields');
    }

    if (!variationId) {
        throw new Error('variationId is required for updateExtendedFields');
    }

    // Verify ownership
    const hasAccess = await verifyVariationOwnership(variationId, merchantId);
    if (!hasAccess) {
        return { success: false, error: 'Variation not found', status: 404 };
    }

    const updateFields = [];
    const values = [];
    let paramCount = 1;

    // Track if case_pack_quantity is being updated
    const casePackUpdate = updates.case_pack_quantity !== undefined;
    const newCasePackValue = updates.case_pack_quantity;

    for (const [key, value] of Object.entries(updates)) {
        if (ALLOWED_EXTENDED_FIELDS.includes(key)) {
            updateFields.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
        }
    }

    if (updateFields.length === 0) {
        return { success: false, error: 'No valid fields to update', status: 400 };
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(variationId);
    values.push(merchantId);

    const query = `
        UPDATE variations
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount} AND merchant_id = $${paramCount + 1}
        RETURNING *
    `;

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
        return { success: false, error: 'Variation not found', status: 404 };
    }

    // Auto-sync case_pack_quantity to Square if updated with a valid value (must be > 0)
    let squareSyncResult = null;
    if (casePackUpdate && newCasePackValue !== null && newCasePackValue > 0) {
        try {
            squareSyncResult = await squareApi.updateCustomAttributeValues(variationId, {
                case_pack_quantity: {
                    number_value: newCasePackValue.toString()
                }
            }, { merchantId });
            logger.info('Case pack synced to Square', { variation_id: variationId, case_pack: newCasePackValue, merchantId });
        } catch (syncError) {
            logger.error('Failed to sync case pack to Square', { variation_id: variationId, merchantId, error: syncError.message });
            // Don't fail the request - local update succeeded
            squareSyncResult = { success: false, error: syncError.message };
        }
    }

    return {
        success: true,
        variation: result.rows[0],
        square_sync: squareSyncResult
    };
}

/**
 * Update minimum stock threshold and sync to Square
 * @param {string} variationId - The variation ID
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {number|null} minStock - The minimum stock threshold
 * @param {string} [locationId] - Optional location ID
 * @returns {Promise<Object>} - Result with success status and details
 */
async function updateMinStock(variationId, merchantId, minStock, locationId = null) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateMinStock');
    }

    if (!variationId) {
        throw new Error('variationId is required for updateMinStock');
    }

    // Validate input
    if (minStock !== null && (typeof minStock !== 'number' || minStock < 0)) {
        return { success: false, error: 'min_stock must be a non-negative number or null', status: 400 };
    }

    // Get variation details (verify ownership)
    const variationResult = await db.query(
        `SELECT v.id, v.sku, v.name, v.item_id, v.track_inventory,
                v.inventory_alert_threshold, i.name as item_name
         FROM variations v
         JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
         WHERE v.id = $1 AND v.merchant_id = $2`,
        [variationId, merchantId]
    );

    if (variationResult.rows.length === 0) {
        return { success: false, error: 'Variation not found', status: 404 };
    }

    const variation = variationResult.rows[0];
    const previousValue = variation.inventory_alert_threshold;

    // Determine which location to use
    let targetLocationId = locationId;

    if (!targetLocationId) {
        // First try to get the location where this item has inventory
        const inventoryLocationResult = await db.query(
            `SELECT ic.location_id
             FROM inventory_counts ic
             JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $2
             WHERE ic.catalog_object_id = $1 AND l.active = TRUE AND ic.state = 'IN_STOCK'
               AND ic.merchant_id = $2
             ORDER BY ic.quantity DESC NULLS LAST
             LIMIT 1`,
            [variationId, merchantId]
        );

        if (inventoryLocationResult.rows.length > 0) {
            targetLocationId = inventoryLocationResult.rows[0].location_id;
        } else {
            // Fall back to the primary/first active location
            const locationResult = await db.query(
                'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1 ORDER BY name LIMIT 1',
                [merchantId]
            );

            if (locationResult.rows.length === 0) {
                return { success: false, error: 'No active locations found. Please sync locations first.', status: 400 };
            }

            targetLocationId = locationResult.rows[0].id;
        }
    }

    // Push update to Square (location-specific)
    logger.info('Updating min stock in Square', {
        variationId,
        sku: variation.sku,
        locationId: targetLocationId,
        previousValue,
        newValue: minStock
    });

    try {
        await squareApi.setSquareInventoryAlertThreshold(variationId, targetLocationId, minStock, { merchantId });
    } catch (squareError) {
        logger.error('Failed to update Square inventory alert threshold', {
            variationId,
            locationId: targetLocationId,
            error: squareError.message
        });
        return { success: false, error: 'Failed to update Square: ' + squareError.message, status: 500, square_error: true };
    }

    // Update local database (variation-level)
    await db.query(
        `UPDATE variations
         SET inventory_alert_threshold = $1,
             inventory_alert_type = $2,
             stock_alert_min = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND merchant_id = $4`,
        [
            minStock,
            minStock !== null && minStock > 0 ? 'LOW_QUANTITY' : 'NONE',
            variationId,
            merchantId
        ]
    );

    // Also update location-specific settings if table exists
    await db.query(
        `INSERT INTO variation_location_settings (variation_id, location_id, stock_alert_min, merchant_id, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (variation_id, location_id, merchant_id)
         DO UPDATE SET stock_alert_min = EXCLUDED.stock_alert_min, updated_at = CURRENT_TIMESTAMP`,
        [variationId, targetLocationId, minStock, merchantId]
    );

    logger.info('Min stock updated successfully', {
        variationId,
        sku: variation.sku,
        itemName: variation.item_name,
        locationId: targetLocationId,
        previousValue,
        newValue: minStock
    });

    return {
        success: true,
        variation_id: variationId,
        sku: variation.sku,
        location_id: targetLocationId,
        previous_value: previousValue,
        new_value: minStock,
        synced_to_square: true
    };
}

/**
 * Update unit cost (vendor cost) and sync to Square
 * @param {string} variationId - The variation ID
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {number} costCents - The cost in cents
 * @param {string} [vendorId] - Optional vendor ID
 * @returns {Promise<Object>} - Result with success status and details
 */
async function updateCost(variationId, merchantId, costCents, vendorId = null) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateCost');
    }

    if (!variationId) {
        throw new Error('variationId is required for updateCost');
    }

    // Validate input
    if (costCents === undefined || costCents === null) {
        return { success: false, error: 'cost_cents is required', status: 400 };
    }

    if (typeof costCents !== 'number' || costCents < 0) {
        return { success: false, error: 'cost_cents must be a non-negative number', status: 400 };
    }

    // Pre-validate vendor_id if provided (security: ensure vendor belongs to this merchant)
    if (vendorId) {
        const vendorCheck = await db.query(
            'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
            [vendorId, merchantId]
        );
        if (vendorCheck.rows.length === 0) {
            return { success: false, error: 'Invalid vendor or vendor does not belong to this merchant', status: 403 };
        }
    }

    // Get variation details (verify ownership)
    const variationResult = await db.query(`
        SELECT v.id, v.sku, v.name, i.name as item_name,
               vv.vendor_id, vv.unit_cost_money as current_cost,
               ven.name as vendor_name
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
        LEFT JOIN vendors ven ON vv.vendor_id = ven.id AND ven.merchant_id = $2
        WHERE v.id = $1 AND v.merchant_id = $2
        ORDER BY vv.unit_cost_money ASC NULLS LAST
        LIMIT 1
    `, [variationId, merchantId]);

    if (variationResult.rows.length === 0) {
        return { success: false, error: 'Variation not found', status: 404 };
    }

    const variation = variationResult.rows[0];
    const targetVendorId = vendorId || variation.vendor_id;
    const previousCost = variation.current_cost;

    // If we have a vendor, update Square and local DB
    if (targetVendorId) {
        try {
            await squareApi.updateVariationCost(
                variationId,
                targetVendorId,
                Math.round(costCents),
                'CAD',
                { merchantId }
            );

            logger.info('Cost updated in Square', {
                variationId,
                sku: variation.sku,
                vendorId: targetVendorId,
                oldCost: previousCost,
                newCost: costCents
            });

            return {
                success: true,
                variation_id: variationId,
                sku: variation.sku,
                item_name: variation.item_name,
                vendor_id: targetVendorId,
                vendor_name: variation.vendor_name,
                previous_cost_cents: previousCost,
                new_cost_cents: costCents,
                synced_to_square: true
            };

        } catch (squareError) {
            logger.error('Square cost update failed', {
                variationId,
                error: squareError.message
            });
            return { success: false, error: 'Failed to update cost in Square: ' + squareError.message, status: 500, square_error: true };
        }
    }

    // No vendor - save locally only (can't push to Square without vendor)
    logger.warn('Cost update without vendor - saving locally only', {
        variationId,
        sku: variation.sku,
        cost_cents: costCents
    });

    return {
        success: true,
        variation_id: variationId,
        sku: variation.sku,
        item_name: variation.item_name,
        vendor_id: null,
        vendor_name: null,
        previous_cost_cents: previousCost,
        new_cost_cents: costCents,
        synced_to_square: false,
        warning: 'No vendor associated - cost saved locally only. Assign a vendor to sync cost to Square.'
    };
}

/**
 * Bulk update extended fields by SKU
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Array} updates - Array of updates { sku, ...fields }
 * @returns {Promise<Object>} - { success, updated_count, errors, squarePush }
 */
async function bulkUpdateExtendedFields(merchantId, updates) {
    if (!merchantId) {
        throw new Error('merchantId is required for bulkUpdateExtendedFields');
    }

    if (!Array.isArray(updates)) {
        return { success: false, error: 'Request body must be an array', status: 400 };
    }

    let updatedCount = 0;
    const errors = [];
    const squarePushResults = { success: 0, failed: 0, errors: [] };

    // Batch lookup all variation IDs by SKU (avoid N+1 queries)
    const skusToLookup = updates.filter(u => u.sku).map(u => u.sku);
    const skuToIdMap = new Map();
    if (skusToLookup.length > 0) {
        const variationsResult = await db.query(
            'SELECT id, sku FROM variations WHERE sku = ANY($1) AND merchant_id = $2',
            [skusToLookup, merchantId]
        );
        for (const row of variationsResult.rows) {
            skuToIdMap.set(row.sku, row.id);
        }
    }

    for (const update of updates) {
        if (!update.sku) {
            errors.push({ error: 'SKU required', data: update });
            continue;
        }

        try {
            const sets = [];
            const values = [];
            let paramCount = 1;

            // Track if case_pack_quantity is being updated
            const casePackUpdate = update.case_pack_quantity !== undefined;
            const newCasePackValue = update.case_pack_quantity;

            for (const [key, value] of Object.entries(update)) {
                if (key !== 'sku' && ALLOWED_BULK_FIELDS.includes(key)) {
                    sets.push(`${key} = $${paramCount}`);
                    values.push(value);
                    paramCount++;
                }
            }

            if (sets.length > 0) {
                sets.push('updated_at = CURRENT_TIMESTAMP');
                values.push(update.sku);
                values.push(merchantId);

                await db.query(`
                    UPDATE variations
                    SET ${sets.join(', ')}
                    WHERE sku = $${paramCount} AND merchant_id = $${paramCount + 1}
                `, values);
                updatedCount++;

                // Auto-sync case_pack_quantity to Square if updated with valid value (must be > 0)
                const variationId = skuToIdMap.get(update.sku);
                if (casePackUpdate && newCasePackValue !== null && newCasePackValue > 0 && variationId) {
                    try {
                        await squareApi.updateCustomAttributeValues(variationId, {
                            case_pack_quantity: {
                                number_value: newCasePackValue.toString()
                            }
                        }, { merchantId });
                        squarePushResults.success++;
                        logger.info('Case pack synced to Square (bulk)', { variation_id: variationId, sku: update.sku, case_pack: newCasePackValue, merchantId });
                    } catch (syncError) {
                        squarePushResults.failed++;
                        squarePushResults.errors.push({ sku: update.sku, error: syncError.message });
                        logger.error('Failed to sync case pack to Square (bulk)', { sku: update.sku, error: syncError.message });
                    }
                }
            }
        } catch (error) {
            errors.push({ sku: update.sku, error: error.message });
        }
    }

    return {
        success: true,
        updated_count: updatedCount,
        errors: errors,
        squarePush: squarePushResults
    };
}

module.exports = {
    getVariations,
    getVariationsWithCosts,
    updateExtendedFields,
    updateMinStock,
    updateCost,
    bulkUpdateExtendedFields
};
