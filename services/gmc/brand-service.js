/**
 * GMC Brand Service
 *
 * Manages brand assignment for Google Merchant Center product feeds.
 * Extracted from routes/gmc.js as part of the GMC route thinning (see docs/GMC-ROUTE-EXTRACTION.md).
 *
 * Responsibilities:
 * - CRUD for merchant-scoped brands
 * - Single and bulk brand assignment with Square catalog sync
 * - Auto-detection of brands from item names by prefix matching
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const squareApi = require('../square');

/**
 * List all brands for a merchant.
 * @returns {{ count: number, brands: Array }}
 */
async function listBrands(merchantId) {
    const result = await db.query(
        'SELECT * FROM brands WHERE merchant_id = $1 ORDER BY name',
        [merchantId]
    );
    return { count: result.rows.length, brands: result.rows };
}

/**
 * Create a new brand for a merchant.
 * Throws with err.status = 409 if the name already exists for this merchant.
 * @returns {{ brand: Object }}
 */
async function createBrand(merchantId, { name, logo_url, website }) {
    try {
        const result = await db.query(
            'INSERT INTO brands (name, logo_url, website, merchant_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, logo_url, website, merchantId]
        );
        return { brand: result.rows[0] };
    } catch (error) {
        if (error.code === '23505') {
            const dupErr = new Error('Brand already exists');
            dupErr.status = 409;
            throw dupErr;
        }
        throw error;
    }
}

/**
 * Assign (or remove) a brand from a Square catalog item, and sync to Square.
 *
 * Returns { notFound: 'item' } or { notFound: 'brand' } when the entity is missing —
 * callers should translate these to 404 responses.
 * Returns the result object on success.
 */
async function assignItemBrand(merchantId, itemId, brandId) {
    const itemCheck = await db.query(
        'SELECT id FROM items WHERE id = $1 AND merchant_id = $2',
        [itemId, merchantId]
    );
    if (itemCheck.rows.length === 0) return { notFound: 'item' };

    let squareSyncResult = null;

    if (!brandId) {
        await db.query(
            'DELETE FROM item_brands WHERE item_id = $1 AND merchant_id = $2',
            [itemId, merchantId]
        );
        try {
            squareSyncResult = await squareApi.updateCustomAttributeValues(
                itemId,
                { brand: { string_value: '' } },
                { merchantId }
            );
            logger.info('Brand removed from Square', { item_id: itemId, merchantId });
        } catch (syncError) {
            logger.error('Failed to remove brand from Square', { item_id: itemId, merchantId, error: syncError.message });
            squareSyncResult = { success: false, error: syncError.message };
        }
        return { message: 'Brand removed from item', square_sync: squareSyncResult };
    }

    const brandResult = await db.query(
        'SELECT name FROM brands WHERE id = $1 AND merchant_id = $2',
        [brandId, merchantId]
    );
    if (brandResult.rows.length === 0) return { notFound: 'brand' };

    const brandName = brandResult.rows[0].name;

    await db.query(`
        INSERT INTO item_brands (item_id, brand_id, merchant_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
    `, [itemId, brandId, merchantId]);

    try {
        squareSyncResult = await squareApi.updateCustomAttributeValues(
            itemId,
            { brand: { string_value: brandName } },
            { merchantId }
        );
        logger.info('Brand synced to Square', { item_id: itemId, brand: brandName, merchantId });
    } catch (syncError) {
        logger.error('Failed to sync brand to Square', { item_id: itemId, merchantId, error: syncError.message });
        squareSyncResult = { success: false, error: syncError.message };
    }

    return { brand_name: brandName, square_sync: squareSyncResult };
}

/**
 * Auto-detect brands from item names by prefix matching.
 *
 * Ensures all brands in rawBrandList exist in the DB, then scans items without
 * brand assignments for prefix matches (longest brand name wins).
 *
 * Returns null if rawBrandList contains no valid entries (caller should send 400).
 */
async function autoDetectBrands(merchantId, rawBrandList) {
    const cleanedBrands = (rawBrandList || [])
        .filter(b => b && typeof b === 'string' && b.trim())
        .map(b => b.trim());

    if (cleanedBrands.length === 0) return null;

    for (const brandName of cleanedBrands) {
        await db.query(
            'INSERT INTO brands (name, merchant_id) VALUES ($1, $2) ON CONFLICT (name, merchant_id) DO NOTHING',
            [brandName, merchantId]
        );
    }

    const brandsResult = await db.query(
        'SELECT id, name FROM brands WHERE name = ANY($1) AND merchant_id = $2 ORDER BY LENGTH(name) DESC',
        [cleanedBrands, merchantId]
    );
    const masterBrands = brandsResult.rows.map(b => ({
        id: b.id,
        name: b.name,
        nameLower: b.name.toLowerCase()
    }));

    const itemsResult = await db.query(`
        SELECT i.id, i.name, i.category_name
        FROM items i
        LEFT JOIN item_brands ib ON i.id = ib.item_id AND ib.merchant_id = $1
        WHERE ib.item_id IS NULL
          AND i.is_deleted = FALSE
          AND i.merchant_id = $1
        ORDER BY i.name
    `, [merchantId]);

    const detected = [];
    const no_match = [];

    for (const item of itemsResult.rows) {
        const itemNameLower = item.name.toLowerCase();
        let matchedBrand = null;

        for (const brand of masterBrands) {
            if (itemNameLower.startsWith(brand.nameLower + ' ') ||
                itemNameLower.startsWith(brand.nameLower + '-') ||
                itemNameLower.startsWith(brand.nameLower + '_') ||
                itemNameLower.startsWith(brand.nameLower + ':') ||
                itemNameLower.startsWith(brand.nameLower + ',') ||
                itemNameLower === brand.nameLower) {
                matchedBrand = brand;
                break;
            }
        }

        if (matchedBrand) {
            detected.push({
                item_id: item.id,
                item_name: item.name,
                category: item.category_name,
                detected_brand_id: matchedBrand.id,
                detected_brand_name: matchedBrand.name,
                selected: true
            });
        } else {
            no_match.push({ item_id: item.id, item_name: item.name, category: item.category_name });
        }
    }

    return {
        master_brands_provided: cleanedBrands.length,
        total_items_without_brand: itemsResult.rows.length,
        detected_count: detected.length,
        no_match_count: no_match.length,
        detected,
        no_match
    };
}

/**
 * Bulk assign brands to items and sync all to Square in a single batch call.
 * @param {Array<{ item_id: string, brand_id: number }>} assignments
 * @returns {Object} results summary with assigned/synced/failed counts
 */
async function bulkAssignBrands(merchantId, assignments) {
    const results = { assigned: 0, synced_to_square: 0, failed: 0, errors: [] };

    const brandIds = [...new Set(assignments.map(a => a.brand_id))];
    const brandsResult = await db.query(
        'SELECT id, name FROM brands WHERE id = ANY($1) AND merchant_id = $2',
        [brandIds, merchantId]
    );
    const brandNamesMap = new Map(brandsResult.rows.map(b => [b.id, b.name]));

    const squareUpdates = [];

    for (const { item_id, brand_id } of assignments) {
        if (!item_id || !brand_id) {
            results.failed++;
            results.errors.push({ item_id, error: 'Missing item_id or brand_id' });
            continue;
        }
        try {
            await db.query(`
                INSERT INTO item_brands (item_id, brand_id, merchant_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
            `, [item_id, brand_id, merchantId]);
            results.assigned++;
            const brandName = brandNamesMap.get(brand_id);
            if (brandName) {
                squareUpdates.push({
                    catalogObjectId: item_id,
                    customAttributeValues: { brand: { string_value: brandName } }
                });
            }
        } catch (error) {
            results.failed++;
            results.errors.push({ item_id, error: error.message });
        }
    }

    if (squareUpdates.length > 0) {
        try {
            const squareResult = await squareApi.batchUpdateCustomAttributeValues(squareUpdates, { merchantId });
            results.synced_to_square = squareResult.updated || 0;
            results.square_sync = squareResult;
            if (squareResult.errors?.length > 0) {
                results.errors.push(...squareResult.errors.map(e => ({ type: 'square_sync', ...e })));
            }
        } catch (syncError) {
            logger.error('Square batch sync failed', { error: syncError.message, merchantId });
            results.errors.push({ type: 'square_batch_sync', error: syncError.message });
        }
    }

    results.success = results.failed === 0;
    logger.info('Bulk brand assignment complete', {
        assigned: results.assigned,
        synced: results.synced_to_square,
        failed: results.failed,
        merchantId
    });

    return results;
}

module.exports = { listBrands, createBrand, assignItemBrand, autoDetectBrands, bulkAssignBrands };
