/**
 * Catalog Inventory Service
 *
 * Business logic for inventory management:
 * - Current inventory levels with sales velocity
 * - Low stock detection
 * - Deleted/archived items
 * - Expiration tracking
 *
 * Extracted from routes/catalog.js as part of P1-2 (fat routes service extraction).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');
const expiryDiscount = require('../../utils/expiry-discount');
const { batchResolveImageUrls } = require('../../utils/image-utils');

/**
 * Get current inventory levels with sales velocity data
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} filters - Optional filters { location_id, low_stock }
 * @returns {Promise<Object>} - { count, inventory }
 */
async function getInventory(merchantId, filters = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getInventory');
    }

    const { location_id, low_stock } = filters;

    let query = `
        SELECT
            ic.catalog_object_id as variation_id,
            ic.quantity,
            ic.location_id,
            ic.updated_at,
            v.sku,
            v.name as variation_name,
            v.price_money,
            v.currency,
            v.stock_alert_min,
            v.stock_alert_max,
            v.case_pack_quantity,
            v.discontinued,
            v.images,
            i.id as item_id,
            i.name as item_name,
            i.category_name,
            i.images as item_images,
            l.name as location_name,
            -- Sales velocity data
            sv91.daily_avg_quantity,
            sv91.weekly_avg_quantity as weekly_avg_91d,
            sv182.weekly_avg_quantity as weekly_avg_182d,
            sv365.weekly_avg_quantity as weekly_avg_365d,
            -- Committed inventory (RESERVED_FOR_SALE)
            COALESCE(ic_committed.quantity, 0) as committed_quantity,
            COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0) as available_quantity,
            -- Days until stockout calculation (uses available quantity)
            CASE
                WHEN sv91.daily_avg_quantity > 0 AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) > 0
                THEN ROUND((COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv91.daily_avg_quantity, 1)
                WHEN (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0
                THEN 0
                ELSE 999
            END as days_until_stockout,
            -- Get primary vendor info
            (SELECT ve.name
             FROM variation_vendors vv
             JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $1
             WHERE vv.variation_id = v.id AND vv.merchant_id = $1
             ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
             LIMIT 1
            ) as vendor_name,
            (SELECT vv.vendor_code
             FROM variation_vendors vv
             WHERE vv.variation_id = v.id AND vv.merchant_id = $1
             ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
             LIMIT 1
            ) as vendor_code,
            (SELECT vv.unit_cost_money
             FROM variation_vendors vv
             WHERE vv.variation_id = v.id AND vv.merchant_id = $1
             ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
             LIMIT 1
            ) as unit_cost_cents
        FROM inventory_counts ic
        JOIN variations v ON ic.catalog_object_id = v.id AND v.merchant_id = $1
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $1
        LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91 AND sv91.merchant_id = $1
            AND (sv91.location_id = ic.location_id OR (sv91.location_id IS NULL AND ic.location_id IS NULL))
        LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $1
            AND (sv182.location_id = ic.location_id OR (sv182.location_id IS NULL AND ic.location_id IS NULL))
        LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $1
            AND (sv365.location_id = ic.location_id OR (sv365.location_id IS NULL AND ic.location_id IS NULL))
        LEFT JOIN inventory_counts ic_committed ON v.id = ic_committed.catalog_object_id AND ic_committed.merchant_id = $1
            AND ic_committed.state = 'RESERVED_FOR_SALE'
            AND ic_committed.location_id = ic.location_id
        WHERE ic.state = 'IN_STOCK'
          AND ic.merchant_id = $1
          AND COALESCE(v.is_deleted, FALSE) = FALSE
          AND COALESCE(i.is_deleted, FALSE) = FALSE
    `;
    const params = [merchantId];

    if (location_id) {
        params.push(location_id);
        query += ` AND ic.location_id = $${params.length}`;
    }

    if (low_stock === 'true' || low_stock === true) {
        query += ` AND v.stock_alert_min IS NOT NULL AND ic.quantity < v.stock_alert_min`;
    }

    query += ' ORDER BY i.name, v.name, l.name';

    const result = await db.query(query, params);

    // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
    const imageUrlMap = await batchResolveImageUrls(result.rows);

    const inventoryWithImages = result.rows.map((row, index) => ({
        ...row,
        image_urls: imageUrlMap.get(index) || [],
        images: undefined,  // Remove raw image IDs from response
        item_images: undefined  // Remove from response
    }));

    return {
        count: inventoryWithImages.length,
        inventory: inventoryWithImages
    };
}

/**
 * Get items below minimum stock alert threshold
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - { count, low_stock_items }
 */
async function getLowStock(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getLowStock');
    }

    const query = `
        SELECT
            v.id,
            v.sku,
            i.name as item_name,
            v.name as variation_name,
            ic.quantity as current_stock,
            v.stock_alert_min,
            v.stock_alert_max,
            v.preferred_stock_level,
            l.name as location_name,
            ic.location_id,
            (v.stock_alert_min - ic.quantity) as units_below_min,
            v.images,
            i.images as item_images
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $1
        JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $1
        WHERE v.merchant_id = $1
          AND v.stock_alert_min IS NOT NULL
          AND ic.quantity < v.stock_alert_min
          AND ic.state = 'IN_STOCK'
          AND v.discontinued = FALSE
        ORDER BY (v.stock_alert_min - ic.quantity) DESC, i.name
    `;

    const result = await db.query(query, [merchantId]);

    // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
    const imageUrlMap = await batchResolveImageUrls(result.rows);

    const items = result.rows.map((row, index) => ({
        ...row,
        image_urls: imageUrlMap.get(index) || [],
        images: undefined,  // Remove raw image IDs from response
        item_images: undefined  // Remove from response
    }));

    return {
        count: items.length,
        low_stock_items: items
    };
}

/**
 * Get soft-deleted AND archived items for cleanup/management
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} filters - Optional filters { age_months, status }
 * @returns {Promise<Object>} - { count, deleted_count, archived_count, deleted_items }
 */
async function getDeletedItems(merchantId, filters = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getDeletedItems');
    }

    const { age_months, status = 'all' } = filters;

    // Build the WHERE clause based on status filter
    let statusCondition;
    if (status === 'deleted') {
        // Only truly deleted items (not in Square anymore)
        statusCondition = 'v.is_deleted = TRUE AND COALESCE(i.is_archived, FALSE) = FALSE';
    } else if (status === 'archived') {
        // Only archived items (still in Square but hidden)
        statusCondition = 'COALESCE(i.is_archived, FALSE) = TRUE AND COALESCE(v.is_deleted, FALSE) = FALSE';
    } else {
        // Both deleted and archived
        statusCondition = '(v.is_deleted = TRUE OR COALESCE(i.is_archived, FALSE) = TRUE)';
    }

    let query = `
        SELECT
            v.id,
            v.sku,
            i.name as item_name,
            v.name as variation_name,
            v.price_money,
            v.currency,
            i.category_name,
            v.deleted_at,
            v.is_deleted,
            COALESCE(i.is_archived, FALSE) as is_archived,
            i.archived_at,
            CASE
                WHEN v.is_deleted = TRUE THEN 'deleted'
                WHEN COALESCE(i.is_archived, FALSE) = TRUE THEN 'archived'
                ELSE 'unknown'
            END as status,
            COALESCE(SUM(ic.quantity), 0) as current_stock,
            CASE
                WHEN v.is_deleted = TRUE THEN DATE_PART('day', NOW() - v.deleted_at)
                WHEN COALESCE(i.is_archived, FALSE) = TRUE THEN DATE_PART('day', NOW() - i.archived_at)
                ELSE 0
            END as days_inactive,
            v.images,
            i.images as item_images
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK' AND ic.merchant_id = $1
        WHERE ${statusCondition} AND v.merchant_id = $1
    `;
    const params = [merchantId];

    // Filter by age if specified
    if (age_months) {
        const months = parseInt(age_months, 10);
        // SECURITY FIX: Use parameterized query instead of string interpolation
        // Also validate the months value is reasonable (1-120 months = 10 years max)
        if (!isNaN(months) && months > 0 && months <= 120) {
            params.push(months);
            query += ` AND (
                (v.deleted_at IS NOT NULL AND v.deleted_at <= NOW() - ($${params.length} || ' months')::interval)
                OR (i.archived_at IS NOT NULL AND i.archived_at <= NOW() - ($${params.length} || ' months')::interval)
            )`;
        }
    }

    query += `
        GROUP BY v.id, i.name, v.name, v.sku, v.price_money, v.currency,
                 i.category_name, v.deleted_at, v.is_deleted, i.is_archived, i.archived_at, v.images, i.images
        ORDER BY
            COALESCE(v.deleted_at, i.archived_at) DESC NULLS LAST,
            i.name, v.name
    `;

    const result = await db.query(query, params);

    // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
    const imageUrlMap = await batchResolveImageUrls(result.rows);

    const items = result.rows.map((row, index) => ({
        ...row,
        image_urls: imageUrlMap.get(index) || [],
        images: undefined,  // Remove raw image IDs from response
        item_images: undefined  // Remove from response
    }));

    // Count by status
    const deletedCount = items.filter(i => i.status === 'deleted').length;
    const archivedCount = items.filter(i => i.status === 'archived').length;

    return {
        count: items.length,
        deleted_count: deletedCount,
        archived_count: archivedCount,
        deleted_items: items  // Keep the key name for backward compatibility
    };
}

/**
 * Get variations with expiration data for expiration tracker
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} filters - Optional filters { expiry, category }
 * @returns {Promise<Object>} - { count, items }
 */
async function getExpirations(merchantId, filters = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getExpirations');
    }

    const { expiry, category } = filters;

    let query = `
        SELECT
            v.id as identifier,
            i.name as name,
            v.name as variation,
            v.sku,
            v.upc as gtin,
            v.price_money,
            v.currency,
            i.category_name,
            ve.expiration_date,
            ve.does_not_expire,
            ve.reviewed_at,
            COALESCE(SUM(ic.quantity), 0) as quantity,
            v.images,
            i.images as item_images
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
        LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK' AND ic.merchant_id = $1
        WHERE COALESCE(v.is_deleted, FALSE) = FALSE AND v.merchant_id = $1
    `;
    const params = [merchantId];

    // Filter by category
    if (category) {
        params.push(`%${category}%`);
        query += ` AND i.category_name ILIKE $${params.length}`;
    }

    // Group by to aggregate inventory across locations
    query += `
        GROUP BY v.id, i.name, v.name, v.sku, v.upc, v.price_money, v.currency,
                 i.category_name, ve.expiration_date, ve.does_not_expire, ve.reviewed_at, v.images, i.images
    `;

    // Filter by expiry timeframe (applied after grouping)
    if (expiry) {
        if (expiry === 'no-expiry') {
            query += ` HAVING ve.expiration_date IS NULL AND (ve.does_not_expire IS NULL OR ve.does_not_expire = FALSE)`;
        } else if (expiry === 'never-expires') {
            query += ` HAVING ve.does_not_expire = TRUE`;
        } else if (expiry === 'review') {
            // Review items: 90-120 days out, NOT already reviewed in last 30 days
            query += ` HAVING ve.expiration_date IS NOT NULL
                      AND ve.does_not_expire = FALSE
                      AND ve.expiration_date >= NOW() + INTERVAL '90 days'
                      AND ve.expiration_date <= NOW() + INTERVAL '120 days'
                      AND (ve.reviewed_at IS NULL OR ve.reviewed_at < NOW() - INTERVAL '30 days')`;
        } else {
            const days = parseInt(expiry, 10);
            if (!isNaN(days) && days >= 0 && days <= 3650) {
                // SECURITY FIX: Use parameterized query instead of string interpolation
                params.push(days);
                query += ` HAVING ve.expiration_date IS NOT NULL
                          AND ve.does_not_expire = FALSE
                          AND ve.expiration_date <= NOW() + ($${params.length} || ' days')::interval
                          AND ve.expiration_date >= NOW()`;
            }
        }
    }

    query += ' ORDER BY ve.expiration_date ASC NULLS LAST, i.name, v.name';

    const result = await db.query(query, params);

    // Resolve image URLs in a SINGLE batch query
    const imageUrlMap = await batchResolveImageUrls(result.rows);
    const items = result.rows.map((row, index) => ({
        ...row,
        image_urls: imageUrlMap.get(index) || [],
        images: undefined,  // Remove raw image IDs from response
        item_images: undefined  // Remove from response
    }));

    logger.info('Catalog service: getExpirations', { count: items.length });

    return {
        count: items.length,
        items: items
    };
}

/**
 * Save/update expiration data for variations
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Array} changes - Array of changes { variation_id, expiration_date, does_not_expire }
 * @returns {Promise<Object>} - { success, message, squarePush }
 */
async function saveExpirations(merchantId, changes) {
    if (!merchantId) {
        throw new Error('merchantId is required for saveExpirations');
    }

    if (!Array.isArray(changes)) {
        return { success: false, error: 'Expected array of changes', status: 400 };
    }

    let updatedCount = 0;
    let squarePushResults = { success: 0, failed: 0, errors: [] };
    const tierOverrides = [];

    for (const change of changes) {
        const { variation_id, expiration_date, does_not_expire } = change;

        if (!variation_id) {
            logger.warn('Skipping change - no variation_id', change);
            continue;
        }

        // Verify variation belongs to this merchant
        const varCheck = await db.query(
            'SELECT id FROM variations WHERE id = $1 AND merchant_id = $2',
            [variation_id, merchantId]
        );
        if (varCheck.rows.length === 0) {
            logger.warn('Skipping change - variation not found for merchant', { variation_id, merchantId });
            continue;
        }

        // Determine effective expiration date
        // If no date and not "does not expire", use 2020-01-01 to trigger review
        let effectiveExpirationDate = expiration_date || null;
        if (!expiration_date && does_not_expire !== true) {
            effectiveExpirationDate = '2020-01-01';
        }

        // Save to local database
        await db.query(`
            INSERT INTO variation_expiration (variation_id, expiration_date, does_not_expire, updated_at, merchant_id)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
            ON CONFLICT (variation_id, merchant_id)
            DO UPDATE SET
                expiration_date = EXCLUDED.expiration_date,
                does_not_expire = EXCLUDED.does_not_expire,
                updated_at = CURRENT_TIMESTAMP
        `, [
            variation_id,
            effectiveExpirationDate,
            does_not_expire === true,
            merchantId
        ]);

        // Check if new date puts item into a discount tier (AUTO25/AUTO50)
        // If so, clear reviewed_at so it appears in expiry-audit for sticker confirmation
        if (expiration_date && does_not_expire !== true) {
            const daysUntilExpiry = expiryDiscount.calculateDaysUntilExpiry(expiration_date);
            const tiers = await expiryDiscount.getActiveTiers(merchantId);
            const newTier = expiryDiscount.determineTier(daysUntilExpiry, tiers);

            if (newTier && (newTier.tier_code === 'AUTO25' || newTier.tier_code === 'AUTO50')) {
                // Clear reviewed_at so item shows up in audit for sticker confirmation
                await db.query(`
                    UPDATE variation_expiration
                    SET reviewed_at = NULL, reviewed_by = NULL
                    WHERE variation_id = $1 AND merchant_id = $2
                `, [variation_id, merchantId]);
                logger.info('Cleared reviewed_at for discount tier item', {
                    variation_id,
                    daysUntilExpiry,
                    tier: newTier.tier_code,
                    merchantId
                });
            }

            // Check for tier override: if item had a non-OK tier, mark as manually overridden
            const existingStatus = await db.query(`
                SELECT vds.current_tier_id, edt.tier_code
                FROM variation_discount_status vds
                LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
                WHERE vds.variation_id = $1 AND vds.merchant_id = $2
            `, [variation_id, merchantId]);

            if (existingStatus.rows.length > 0) {
                const existing = existingStatus.rows[0];
                if (existing.tier_code && existing.tier_code !== 'OK') {
                    // Item had a non-OK tier — mark override on the record
                    const overrideNote = change.override_note || `Expiry date changed to ${expiration_date}`;
                    await db.query(`
                        UPDATE variation_discount_status
                        SET manually_overridden = TRUE,
                            manual_override_at = NOW(),
                            manual_override_note = $1,
                            updated_at = NOW()
                        WHERE variation_id = $2 AND merchant_id = $3
                    `, [overrideNote, variation_id, merchantId]);

                    tierOverrides.push({
                        variation_id,
                        previous_tier: existing.tier_code,
                        new_expiry_date: expiration_date,
                        calculated_tier: newTier?.tier_code || 'OK'
                    });

                    logger.info('Manual expiry override on discounted item', {
                        variation_id,
                        previousTier: existing.tier_code,
                        newExpiryDate: expiration_date,
                        calculatedTier: newTier?.tier_code,
                        merchantId
                    });
                }
            }
        }

        updatedCount++;

        // Push to Square
        try {
            const customAttributeValues = {};

            // Handle expiration_date
            if (expiration_date) {
                customAttributeValues.expiration_date = { string_value: expiration_date };
            } else if (does_not_expire !== true) {
                // No date and doesn't have "does not expire" flag - set to 2020-01-01 to trigger review
                customAttributeValues.expiration_date = { string_value: '2020-01-01' };
            }

            // Always push does_not_expire toggle (it's a real setting)
            customAttributeValues.does_not_expire = { boolean_value: does_not_expire === true };

            await squareApi.updateCustomAttributeValues(variation_id, customAttributeValues, { merchantId });
            squarePushResults.success++;
            logger.info('Pushed expiry to Square', { variation_id, expiration_date, does_not_expire, merchantId });
        } catch (squareError) {
            squarePushResults.failed++;
            squarePushResults.errors.push({ variation_id, error: squareError.message });
            logger.error('Failed to push expiry to Square', {
                variation_id,
                error: squareError.message
            });
        }
    }

    logger.info('Updated expirations', {
        count: updatedCount,
        squarePush: squarePushResults
    });

    return {
        success: true,
        message: `Updated ${updatedCount} expiration record(s)`,
        squarePush: squarePushResults,
        tierOverrides: tierOverrides.length > 0 ? tierOverrides : undefined
    };
}

/**
 * Mark items as reviewed (so they don't reappear in review filter)
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Array} variationIds - Array of variation IDs to mark as reviewed
 * @param {string} [reviewedBy] - Optional name of reviewer
 * @returns {Promise<Object>} - { success, message, reviewed_count, squarePush }
 */
async function markExpirationsReviewed(merchantId, variationIds, reviewedBy = 'User') {
    if (!merchantId) {
        throw new Error('merchantId is required for markExpirationsReviewed');
    }

    if (!Array.isArray(variationIds) || variationIds.length === 0) {
        return { success: false, error: 'Expected array of variation_ids', status: 400 };
    }

    const reviewedAt = new Date().toISOString();
    let squarePushResults = { success: 0, failed: 0, errors: [] };

    // Batch verify all variations belong to this merchant (avoid N+1 queries)
    const validVariations = await db.query(
        'SELECT id FROM variations WHERE id = ANY($1) AND merchant_id = $2',
        [variationIds, merchantId]
    );
    const validIds = new Set(validVariations.rows.map(v => v.id));

    if (validIds.size === 0) {
        return { success: false, error: 'No valid variations found for this merchant', status: 400 };
    }

    // Batch upsert all valid variations
    const validIdsArray = Array.from(validIds);
    await db.query(`
        INSERT INTO variation_expiration (variation_id, reviewed_at, reviewed_by, updated_at, merchant_id)
        SELECT unnest($1::text[]), NOW(), $2, NOW(), $3
        ON CONFLICT (variation_id, merchant_id)
        DO UPDATE SET
            reviewed_at = NOW(),
            reviewed_by = COALESCE($2, variation_expiration.reviewed_by),
            updated_at = NOW()
    `, [validIdsArray, reviewedBy, merchantId]);

    const reviewedCount = validIds.size;

    // Push to Square for cross-platform consistency (external API calls must be individual)
    for (const variation_id of validIds) {
        try {
            const customAttributeValues = {
                expiry_reviewed_at: { string_value: reviewedAt }
            };
            if (reviewedBy) {
                customAttributeValues.expiry_reviewed_by = { string_value: reviewedBy };
            }
            await squareApi.updateCustomAttributeValues(variation_id, customAttributeValues, { merchantId });
            squarePushResults.success++;
        } catch (squareError) {
            squarePushResults.failed++;
            squarePushResults.errors.push({ variation_id, error: squareError.message });
            logger.warn('Failed to push review data to Square', {
                variation_id,
                merchantId,
                error: squareError.message
            });
        }
    }

    logger.info('Marked items as reviewed', { count: reviewedCount, reviewed_by: reviewedBy, squarePush: squarePushResults });

    return {
        success: true,
        message: `Marked ${reviewedCount} item(s) as reviewed`,
        reviewed_count: reviewedCount,
        squarePush: squarePushResults
    };
}

module.exports = {
    getInventory,
    getLowStock,
    getDeletedItems,
    getExpirations,
    saveExpirations,
    markExpirationsReviewed
};
