/**
 * Catalog Routes
 *
 * Handles catalog data management:
 * - Locations
 * - Items, variations, categories
 * - Inventory and low stock
 * - Expirations tracking
 * - Catalog audit
 *
 * Endpoints:
 * - GET    /api/locations                     - List store locations
 * - GET    /api/categories                    - List all categories
 * - GET    /api/items                         - List items with optional filtering
 * - GET    /api/variations                    - List variations with optional filtering
 * - GET    /api/variations-with-costs         - List variations with cost/margin info
 * - PATCH  /api/variations/:id/extended       - Update custom fields
 * - PATCH  /api/variations/:id/min-stock      - Update min stock threshold
 * - PATCH  /api/variations/:id/cost           - Update unit cost
 * - POST   /api/variations/bulk-update-extended - Bulk update custom fields
 * - GET    /api/expirations                   - Get expiration data
 * - POST   /api/expirations                   - Save expiration data
 * - POST   /api/expirations/review            - Mark items as reviewed
 * - GET    /api/inventory                     - Get inventory levels
 * - GET    /api/low-stock                     - Get low stock items
 * - GET    /api/deleted-items                 - Get deleted/archived items
 * - GET    /api/catalog-audit                 - Get catalog audit data
 * - POST   /api/catalog-audit/fix-locations   - Fix location mismatches
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const squareApi = require('../utils/square-api');
const logger = require('../utils/logger');
const expiryDiscount = require('../utils/expiry-discount');
const { batchResolveImageUrls } = require('../utils/image-utils');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/catalog');

// ==================== CATALOG ENDPOINTS ====================

/**
 * GET /api/locations
 * Get store locations for the merchant
 */
router.get('/locations', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT id, name, active, address, timezone
            FROM locations
            WHERE merchant_id = $1
            ORDER BY name
        `, [merchantId]);

        res.json({
            count: result.rows.length,
            locations: result.rows
        });
    } catch (error) {
        logger.error('Get locations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/categories
 * Get list of all distinct categories from items
 */
router.get('/categories', requireAuth, requireMerchant, validators.getCategories, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT DISTINCT i.category_name
            FROM items i
            WHERE i.category_name IS NOT NULL
              AND i.category_name != ''
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND i.merchant_id = $1
            ORDER BY i.category_name
        `, [merchantId]);
        logger.info('API /api/categories returning', { count: result.rows.length, merchantId });
        res.json(result.rows.map(row => row.category_name));
    } catch (error) {
        logger.error('Get categories error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/items
 * List all items with optional filtering
 */
router.get('/items', requireAuth, requireMerchant, validators.getItems, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { name, category } = req.query;
        let query = `
            SELECT i.*, c.name as category_name
            FROM items i
            LEFT JOIN categories c ON i.category_id = c.id AND c.merchant_id = $1
            WHERE i.merchant_id = $1
        `;
        const params = [merchantId];

        if (name) {
            params.push(`%${name}%`);
            query += ` AND i.name ILIKE $${params.length}`;
        }

        if (category) {
            params.push(`%${category}%`);
            query += ` AND c.name ILIKE $${params.length}`;
        }

        query += ' ORDER BY i.name';

        const result = await db.query(query, params);
        logger.info('API /api/items returning', { count: result.rows.length, merchantId });
        res.json({
            count: result.rows.length,
            items: result.rows || []
        });
    } catch (error) {
        logger.error('Get items error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message, items: [] });
    }
});

/**
 * GET /api/variations
 * List all variations with optional filtering
 */
router.get('/variations', requireAuth, requireMerchant, validators.getVariations, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { item_id, sku, has_cost } = req.query;
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

        if (has_cost === 'true') {
            query += ` AND EXISTS (SELECT 1 FROM variation_vendors vv WHERE vv.variation_id = v.id AND vv.merchant_id = $1)`;
        }

        query += ' ORDER BY i.name, v.name';

        const result = await db.query(query, params);

        // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
        const imageUrlMap = await batchResolveImageUrls(result.rows);

        const variations = result.rows.map((variation, index) => ({
            ...variation,
            item_images: undefined,  // Remove from response
            image_urls: imageUrlMap.get(index) || []
        }));

        res.json({
            count: variations.length,
            variations
        });
    } catch (error) {
        logger.error('Get variations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/variations-with-costs
 * Get variations with cost and margin information
 */
router.get('/variations-with-costs', requireAuth, requireMerchant, validators.getVariationsWithCosts, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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

        res.json({
            count: variations.length,
            variations
        });
    } catch (error) {
        logger.error('Get variations with costs error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/variations/:id/extended
 * Update custom fields on a variation
 * Automatically syncs case_pack_quantity to Square if changed
 */
router.patch('/variations/:id/extended', requireAuth, requireMerchant, validators.updateVariationExtended, async (req, res) => {
    try {
        const { id } = req.params;
        const merchantId = req.merchantContext.id;

        // Verify variation belongs to this merchant
        const varCheck = await db.query('SELECT id FROM variations WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
        if (varCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const allowedFields = [
            'case_pack_quantity', 'stock_alert_min', 'stock_alert_max',
            'preferred_stock_level', 'shelf_location', 'bin_location',
            'reorder_multiple', 'discontinued', 'discontinue_date',
            'replacement_variation_id', 'supplier_item_number',
            'last_cost_cents', 'last_cost_date', 'notes'
        ];

        const updates = [];
        const values = [];
        let paramCount = 1;

        // Track if case_pack_quantity is being updated
        const casePackUpdate = req.body.case_pack_quantity !== undefined;
        const newCasePackValue = req.body.case_pack_quantity;

        for (const [key, value] of Object.entries(req.body)) {
            if (allowedFields.includes(key)) {
                updates.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        values.push(merchantId);

        const query = `
            UPDATE variations
            SET ${updates.join(', ')}
            WHERE id = $${paramCount} AND merchant_id = $${paramCount + 1}
            RETURNING *
        `;

        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        // Auto-sync case_pack_quantity to Square if updated with a valid value (must be > 0)
        let squareSyncResult = null;
        if (casePackUpdate && newCasePackValue !== null && newCasePackValue > 0) {
            try {
                squareSyncResult = await squareApi.updateCustomAttributeValues(id, {
                    case_pack_quantity: {
                        number_value: newCasePackValue.toString()
                    }
                }, { merchantId });
                logger.info('Case pack synced to Square', { variation_id: id, case_pack: newCasePackValue, merchantId });
            } catch (syncError) {
                logger.error('Failed to sync case pack to Square', { variation_id: id, merchantId, error: syncError.message });
                // Don't fail the request - local update succeeded
                squareSyncResult = { success: false, error: syncError.message };
            }
        }

        res.json({
            status: 'success',
            variation: result.rows[0],
            square_sync: squareSyncResult
        });
    } catch (error) {
        logger.error('Update variation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/variations/:id/min-stock
 * Update min stock (inventory alert threshold) and sync to Square
 * Uses location-specific overrides in Square
 */
router.patch('/variations/:id/min-stock', requireAuth, requireMerchant, validators.updateMinStock, async (req, res) => {
    try {
        const { id } = req.params;
        const { min_stock, location_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Validate input
        if (min_stock !== null && (typeof min_stock !== 'number' || min_stock < 0)) {
            return res.status(400).json({
                error: 'min_stock must be a non-negative number or null'
            });
        }

        // Get variation details (verify ownership)
        const variationResult = await db.query(
            `SELECT v.id, v.sku, v.name, v.item_id, v.track_inventory,
                    v.inventory_alert_threshold, i.name as item_name
             FROM variations v
             JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
             WHERE v.id = $1 AND v.merchant_id = $2`,
            [id, merchantId]
        );

        if (variationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const variation = variationResult.rows[0];
        const previousValue = variation.inventory_alert_threshold;

        // Determine which location to use
        let targetLocationId = location_id;

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
                [id, merchantId]
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
                    return res.status(400).json({
                        error: 'No active locations found. Please sync locations first.'
                    });
                }

                targetLocationId = locationResult.rows[0].id;
            }
        }

        // Push update to Square (location-specific)
        logger.info('Updating min stock in Square', {
            variationId: id,
            sku: variation.sku,
            locationId: targetLocationId,
            previousValue,
            newValue: min_stock
        });

        try {
            await squareApi.setSquareInventoryAlertThreshold(id, targetLocationId, min_stock, { merchantId });
        } catch (squareError) {
            logger.error('Failed to update Square inventory alert threshold', {
                variationId: id,
                locationId: targetLocationId,
                error: squareError.message
            });
            return res.status(500).json({
                error: 'Failed to update Square: ' + squareError.message,
                square_error: true
            });
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
                min_stock,
                min_stock !== null && min_stock > 0 ? 'LOW_QUANTITY' : 'NONE',
                id,
                merchantId
            ]
        );

        // Also update location-specific settings if table exists
        await db.query(
            `INSERT INTO variation_location_settings (variation_id, location_id, stock_alert_min, merchant_id, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (variation_id, location_id, merchant_id)
             DO UPDATE SET stock_alert_min = EXCLUDED.stock_alert_min, updated_at = CURRENT_TIMESTAMP`,
            [id, targetLocationId, min_stock, merchantId]
        );

        logger.info('Min stock updated successfully', {
            variationId: id,
            sku: variation.sku,
            itemName: variation.item_name,
            locationId: targetLocationId,
            previousValue,
            newValue: min_stock
        });

        res.json({
            success: true,
            variation_id: id,
            sku: variation.sku,
            location_id: targetLocationId,
            previous_value: previousValue,
            new_value: min_stock,
            synced_to_square: true
        });

    } catch (error) {
        logger.error('Update min stock error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/variations/:id/cost
 * Update unit cost (vendor cost) and sync to Square
 */
router.patch('/variations/:id/cost', requireAuth, requireMerchant, validators.updateCost, async (req, res) => {
    try {
        const { id } = req.params;
        const { cost_cents, vendor_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Validate input
        if (cost_cents === undefined || cost_cents === null) {
            return res.status(400).json({ error: 'cost_cents is required' });
        }

        if (typeof cost_cents !== 'number' || cost_cents < 0) {
            return res.status(400).json({ error: 'cost_cents must be a non-negative number' });
        }

        // Pre-validate vendor_id if provided (security: ensure vendor belongs to this merchant)
        if (vendor_id) {
            const vendorCheck = await db.query(
                'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
                [vendor_id, merchantId]
            );
            if (vendorCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Invalid vendor or vendor does not belong to this merchant' });
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
        `, [id, merchantId]);

        if (variationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const variation = variationResult.rows[0];
        const targetVendorId = vendor_id || variation.vendor_id;
        const previousCost = variation.current_cost;

        // If we have a vendor, update Square and local DB
        if (targetVendorId) {
            try {
                const squareResult = await squareApi.updateVariationCost(
                    id,
                    targetVendorId,
                    Math.round(cost_cents),
                    'CAD',
                    { merchantId }
                );

                logger.info('Cost updated in Square', {
                    variationId: id,
                    sku: variation.sku,
                    vendorId: targetVendorId,
                    oldCost: previousCost,
                    newCost: cost_cents
                });

                res.json({
                    success: true,
                    variation_id: id,
                    sku: variation.sku,
                    item_name: variation.item_name,
                    vendor_id: targetVendorId,
                    vendor_name: variation.vendor_name,
                    previous_cost_cents: previousCost,
                    new_cost_cents: cost_cents,
                    synced_to_square: true
                });

            } catch (squareError) {
                logger.error('Square cost update failed', {
                    variationId: id,
                    error: squareError.message
                });
                return res.status(500).json({
                    error: 'Failed to update cost in Square: ' + squareError.message,
                    square_error: true
                });
            }
        } else {
            // No vendor - save locally only (can't push to Square without vendor)
            // Update local variation_vendors with a null vendor or just log the cost
            logger.warn('Cost update without vendor - saving locally only', {
                variationId: id,
                sku: variation.sku,
                cost_cents
            });

            // Store in variations table as a fallback cost field (if you have one)
            // For now, just acknowledge the limitation
            res.json({
                success: true,
                variation_id: id,
                sku: variation.sku,
                item_name: variation.item_name,
                vendor_id: null,
                vendor_name: null,
                previous_cost_cents: previousCost,
                new_cost_cents: cost_cents,
                synced_to_square: false,
                warning: 'No vendor associated - cost saved locally only. Assign a vendor to sync cost to Square.'
            });
        }

    } catch (error) {
        logger.error('Update cost error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/variations/bulk-update-extended
 * Bulk update custom fields by SKU
 */
router.post('/variations/bulk-update-extended', requireAuth, requireMerchant, validators.bulkUpdateExtended, async (req, res) => {
    try {
        const updates = req.body;
        const merchantId = req.merchantContext.id;

        if (!Array.isArray(updates)) {
            return res.status(400).json({ error: 'Request body must be an array' });
        }

        let updatedCount = 0;
        const errors = [];
        const squarePushResults = { success: 0, failed: 0, errors: [] };

        for (const update of updates) {
            if (!update.sku) {
                errors.push({ error: 'SKU required', data: update });
                continue;
            }

            try {
                const allowedFields = [
                    'case_pack_quantity', 'stock_alert_min', 'stock_alert_max',
                    'preferred_stock_level', 'shelf_location', 'bin_location',
                    'reorder_multiple', 'discontinued', 'notes'
                ];

                const sets = [];
                const values = [];
                let paramCount = 1;

                // Track if case_pack_quantity is being updated
                const casePackUpdate = update.case_pack_quantity !== undefined;
                const newCasePackValue = update.case_pack_quantity;

                for (const [key, value] of Object.entries(update)) {
                    if (key !== 'sku' && allowedFields.includes(key)) {
                        sets.push(`${key} = $${paramCount}`);
                        values.push(value);
                        paramCount++;
                    }
                }

                if (sets.length > 0) {
                    sets.push('updated_at = CURRENT_TIMESTAMP');
                    values.push(update.sku);
                    values.push(merchantId);

                    // Get variation ID before updating (needed for Square sync)
                    const variationResult = await db.query(
                        'SELECT id FROM variations WHERE sku = $1 AND merchant_id = $2',
                        [update.sku, merchantId]
                    );

                    await db.query(`
                        UPDATE variations
                        SET ${sets.join(', ')}
                        WHERE sku = $${paramCount} AND merchant_id = $${paramCount + 1}
                    `, values);
                    updatedCount++;

                    // Auto-sync case_pack_quantity to Square if updated with valid value (must be > 0)
                    if (casePackUpdate && newCasePackValue !== null && newCasePackValue > 0 && variationResult.rows.length > 0) {
                        const variationId = variationResult.rows[0].id;
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

        res.json({
            status: 'success',
            updated_count: updatedCount,
            errors: errors,
            squarePush: squarePushResults
        });
    } catch (error) {
        logger.error('Bulk update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== EXPIRATION TRACKING ENDPOINTS ====================

/**
 * GET /api/expirations
 * Get variations with expiration data for expiration tracker
 */
router.get('/expirations', requireAuth, requireMerchant, validators.getExpirations, async (req, res) => {
    try {
        const { expiry, category } = req.query;
        const merchantId = req.merchantContext.id;

        // Check if reviewed_at column exists (for backwards compatibility)
        let hasReviewedColumn = false;
        try {
            const colCheck = await db.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'variation_expiration' AND column_name = 'reviewed_at'
            `);
            hasReviewedColumn = colCheck.rows.length > 0;
        } catch (e) {
            // Column check failed, assume it doesn't exist
        }

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
                ${hasReviewedColumn ? 've.reviewed_at,' : ''}
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
                     i.category_name, ve.expiration_date, ve.does_not_expire, ${hasReviewedColumn ? 've.reviewed_at,' : ''} v.images, i.images
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
                          AND ve.expiration_date <= NOW() + INTERVAL '120 days'`;
                if (hasReviewedColumn) {
                    query += ` AND (ve.reviewed_at IS NULL OR ve.reviewed_at < NOW() - INTERVAL '30 days')`;
                }
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

        logger.info('API /api/expirations returning', { count: items.length });

        res.json({
            count: items.length,
            items: items
        });

    } catch (error) {
        logger.error('Get expirations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message, items: [] });
    }
});

/**
 * POST /api/expirations
 * Save/update expiration data for variations
 */
router.post('/expirations', requireAuth, requireMerchant, validators.saveExpirations, async (req, res) => {
    try {
        const changes = req.body;
        const merchantId = req.merchantContext.id;

        if (!Array.isArray(changes)) {
            return res.status(400).json({ error: 'Expected array of changes' });
        }

        let updatedCount = 0;
        let squarePushResults = { success: 0, failed: 0, errors: [] };

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

        res.json({
            success: true,
            message: `Updated ${updatedCount} expiration record(s)`,
            squarePush: squarePushResults
        });

    } catch (error) {
        logger.error('Save expirations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to save expiration data', details: error.message });
    }
});

/**
 * POST /api/expirations/review
 * Mark items as reviewed (so they don't reappear in review filter)
 * Also syncs reviewed_at timestamp to Square for cross-platform consistency
 */
router.post('/expirations/review', requireAuth, requireMerchant, validators.reviewExpirations, async (req, res) => {
    try {
        const { variation_ids, reviewed_by } = req.body;
        const merchantId = req.merchantContext.id;

        if (!Array.isArray(variation_ids) || variation_ids.length === 0) {
            return res.status(400).json({ error: 'Expected array of variation_ids' });
        }

        // Check if reviewed_at column exists
        let hasReviewedColumn = false;
        try {
            const colCheck = await db.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'variation_expiration' AND column_name = 'reviewed_at'
            `);
            hasReviewedColumn = colCheck.rows.length > 0;
        } catch (e) {
            // Column check failed
        }

        if (!hasReviewedColumn) {
            return res.status(503).json({
                error: 'Review feature not available',
                details: 'Please restart the server to apply database migrations.'
            });
        }

        let reviewedCount = 0;
        const reviewedAt = new Date().toISOString();
        let squarePushResults = { success: 0, failed: 0, errors: [] };

        for (const variation_id of variation_ids) {
            // Verify variation belongs to this merchant
            const varCheck = await db.query(
                'SELECT id FROM variations WHERE id = $1 AND merchant_id = $2',
                [variation_id, merchantId]
            );
            if (varCheck.rows.length === 0) {
                continue;
            }

            // Save to local database
            await db.query(`
                INSERT INTO variation_expiration (variation_id, reviewed_at, reviewed_by, updated_at, merchant_id)
                VALUES ($1, NOW(), $2, NOW(), $3)
                ON CONFLICT (variation_id, merchant_id)
                DO UPDATE SET
                    reviewed_at = NOW(),
                    reviewed_by = COALESCE($2, variation_expiration.reviewed_by),
                    updated_at = NOW()
            `, [variation_id, reviewed_by || 'User', merchantId]);

            reviewedCount++;

            // Push to Square for cross-platform consistency (both timestamp and user)
            try {
                const customAttributeValues = {
                    expiry_reviewed_at: { string_value: reviewedAt }
                };
                // Also push reviewed_by if provided
                if (reviewed_by) {
                    customAttributeValues.expiry_reviewed_by = { string_value: reviewed_by };
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

        logger.info('Marked items as reviewed', { count: reviewedCount, reviewed_by, squarePush: squarePushResults });

        res.json({
            success: true,
            message: `Marked ${reviewedCount} item(s) as reviewed`,
            reviewed_count: reviewedCount,
            squarePush: squarePushResults
        });

    } catch (error) {
        logger.error('Mark as reviewed error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to mark items as reviewed', details: error.message });
    }
});

// ==================== INVENTORY ENDPOINTS ====================

/**
 * GET /api/inventory
 * Get current inventory levels
 */
router.get('/inventory', requireAuth, requireMerchant, validators.getInventory, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { location_id, low_stock } = req.query;
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
                -- Days until stockout calculation
                CASE
                    WHEN sv91.daily_avg_quantity > 0 AND COALESCE(ic.quantity, 0) > 0
                    THEN ROUND(COALESCE(ic.quantity, 0) / sv91.daily_avg_quantity, 1)
                    WHEN COALESCE(ic.quantity, 0) <= 0
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
            LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $1
            LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $1
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

        if (low_stock === 'true') {
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

        res.json({
            count: inventoryWithImages.length,
            inventory: inventoryWithImages
        });
    } catch (error) {
        logger.error('Get inventory error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/low-stock
 * Get items below minimum stock alert threshold
 */
router.get('/low-stock', requireAuth, requireMerchant, validators.getLowStock, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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

        res.json({
            count: items.length,
            low_stock_items: items
        });
    } catch (error) {
        logger.error('Get low stock error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/deleted-items
 * Get soft-deleted AND archived items for cleanup/management
 * Query params:
 *   - age_months: filter to items deleted/archived more than X months ago
 *   - status: 'deleted', 'archived', or 'all' (default: 'all')
 */
router.get('/deleted-items', requireAuth, requireMerchant, validators.getDeletedItems, async (req, res) => {
    try {
        const { age_months, status = 'all' } = req.query;
        const merchantId = req.merchantContext.id;

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

        res.json({
            count: items.length,
            deleted_count: deletedCount,
            archived_count: archivedCount,
            deleted_items: items  // Keep the key name for backward compatibility
        });
    } catch (error) {
        logger.error('Get deleted items error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== CATALOG AUDIT ENDPOINTS ====================

/**
 * GET /api/catalog-audit
 * Get comprehensive catalog audit data - identifies items with missing/incomplete data
 */
router.get('/catalog-audit', requireAuth, requireMerchant, validators.getCatalogAudit, async (req, res) => {
    try {
        const { location_id, issue_type } = req.query;
        const merchantId = req.merchantContext.id;

        // SECURITY FIX: Validate location_id format if provided (Square location IDs are alphanumeric)
        const sanitizedLocationId = location_id && /^[A-Za-z0-9_-]+$/.test(location_id) ? location_id : null;

        // Build comprehensive audit query
        // SECURITY FIX: Use parameterized query for location_id ($2) instead of string interpolation
        const query = `
            WITH variation_data AS (
                SELECT
                    v.id as variation_id,
                    v.sku,
                    v.upc,
                    v.name as variation_name,
                    v.price_money,
                    v.currency,
                    v.track_inventory,
                    v.inventory_alert_type,
                    v.inventory_alert_threshold,
                    v.stock_alert_min,
                    v.images as variation_images,
                    i.id as item_id,
                    i.name as item_name,
                    i.description,
                    i.category_id,
                    i.category_name,
                    i.product_type,
                    i.taxable,
                    i.tax_ids,
                    i.visibility,
                    i.available_online,
                    i.available_for_pickup,
                    i.seo_title,
                    i.seo_description,
                    i.images as item_images,
                    i.present_at_all_locations as item_present_at_all,
                    i.present_at_location_ids as item_present_at_location_ids,
                    v.present_at_all_locations as variation_present_at_all,
                    -- Check for vendor assignment
                    (SELECT COUNT(*) FROM variation_vendors vv WHERE vv.variation_id = v.id AND vv.merchant_id = v.merchant_id) as vendor_count,
                    -- Get primary vendor info
                    (SELECT ve.name
                     FROM variation_vendors vv
                     JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = v.merchant_id
                     WHERE vv.variation_id = v.id AND vv.merchant_id = v.merchant_id
                     ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                     LIMIT 1
                    ) as vendor_name,
                    -- Get unit cost
                    (SELECT vv.unit_cost_money
                     FROM variation_vendors vv
                     WHERE vv.variation_id = v.id AND vv.merchant_id = v.merchant_id
                     ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                     LIMIT 1
                    ) as unit_cost_cents,
                    -- Get current stock (sum across all locations or specific location)
                    -- SECURITY: Uses parameterized query ($2) for location filter
                    (SELECT COALESCE(SUM(ic.quantity), 0)
                     FROM inventory_counts ic
                     WHERE ic.catalog_object_id = v.id
                       AND ic.state = 'IN_STOCK'
                       AND ic.merchant_id = v.merchant_id
                       AND ($2::text IS NULL OR ic.location_id = $2)
                    ) as current_stock,
                    -- Check if ANY location has a stock_alert_min set (for reorder threshold check)
                    (SELECT MAX(vls.stock_alert_min)
                     FROM variation_location_settings vls
                     WHERE vls.variation_id = v.id
                       AND vls.stock_alert_min IS NOT NULL
                       AND vls.stock_alert_min > 0
                       AND vls.merchant_id = v.merchant_id
                    ) as location_stock_alert_min,
                    -- Sales velocity (all periods like reorder.html)
                    COALESCE(sv91.daily_avg_quantity, 0) as daily_velocity,
                    COALESCE(sv91.weekly_avg_quantity, 0) as weekly_avg_91d,
                    COALESCE(sv182.weekly_avg_quantity, 0) as weekly_avg_182d,
                    COALESCE(sv365.weekly_avg_quantity, 0) as weekly_avg_365d,
                    COALESCE(sv91.total_quantity_sold, 0) as total_sold_91d
                FROM variations v
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91 AND sv91.merchant_id = $1
                LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $1
                LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $1
                WHERE v.merchant_id = $1
                  AND COALESCE(v.is_deleted, FALSE) = FALSE
                  AND COALESCE(i.is_deleted, FALSE) = FALSE
            )
            SELECT
                *,
                -- Calculate days of stock remaining
                CASE
                    WHEN daily_velocity > 0 AND current_stock > 0
                    THEN ROUND(current_stock / daily_velocity, 1)
                    ELSE NULL
                END as days_of_stock,
                -- Calculate audit flags (focused on actual data quality issues)
                -- Note: Services (APPOINTMENTS_SERVICE) and gift cards are excluded from inventory/vendor checks
                (category_id IS NULL OR category_name IS NULL OR category_name = '') as missing_category,
                (taxable = FALSE OR taxable IS NULL) as not_taxable,
                (price_money IS NULL OR price_money = 0) as missing_price,
                (description IS NULL OR description = '') as missing_description,
                (item_images IS NULL OR item_images::text = '[]' OR item_images::text = 'null') as missing_item_image,
                (variation_images IS NULL OR variation_images::text = '[]' OR variation_images::text = 'null') as missing_variation_image,
                -- SKU/UPC only required for physical products (not services or gift cards)
                ((sku IS NULL OR sku = '') AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_sku,
                ((upc IS NULL OR upc = '') AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_upc,
                -- Inventory checks only for physical products
                ((track_inventory = FALSE OR track_inventory IS NULL) AND (product_type IS NULL OR product_type = 'REGULAR')) as stock_tracking_off,
                -- Inventory alerts not enabled - check both variation-level AND location-level settings
                (
                    (inventory_alert_type IS NULL OR inventory_alert_type != 'LOW_QUANTITY')
                    AND (location_stock_alert_min IS NULL OR location_stock_alert_min = 0)
                    AND (product_type IS NULL OR product_type = 'REGULAR')
                ) as inventory_alerts_off,
                -- No reorder threshold: Out of stock AND no minimum threshold set anywhere
                -- Check: Square's inventory_alert, global stock_alert_min, OR location-specific stock_alert_min
                (
                    current_stock <= 0
                    AND (inventory_alert_type IS NULL OR inventory_alert_type != 'LOW_QUANTITY' OR inventory_alert_threshold IS NULL OR inventory_alert_threshold = 0)
                    AND (stock_alert_min IS NULL OR stock_alert_min = 0)
                    AND (location_stock_alert_min IS NULL)
                    AND (product_type IS NULL OR product_type = 'REGULAR')
                ) as no_reorder_threshold,
                -- Vendor/cost only required for physical products
                (vendor_count = 0 AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_vendor,
                (unit_cost_cents IS NULL AND UPPER(variation_name) NOT LIKE '%SAMPLE%' AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_cost,  -- Excludes SAMPLE variations (samples are free)
                -- SEO fields
                (seo_title IS NULL OR seo_title = '') as missing_seo_title,
                (seo_description IS NULL OR seo_description = '') as missing_seo_description,
                -- Tax configuration
                (tax_ids IS NULL OR tax_ids::text = '[]' OR tax_ids::text = 'null') as no_tax_ids,
                -- Location mismatch: variation enabled at all locations but parent item is not
                (variation_present_at_all = TRUE AND item_present_at_all = FALSE) as location_mismatch,
                -- Sales channel flags
                -- POS disabled: item is NOT at all locations AND NOT at any specific locations
                (
                    (item_present_at_all = FALSE OR item_present_at_all IS NULL)
                    AND (item_present_at_location_ids IS NULL OR item_present_at_location_ids = '[]'::jsonb OR jsonb_array_length(item_present_at_location_ids) = 0)
                ) as pos_disabled,
                (available_online = FALSE OR available_online IS NULL) as online_disabled,
                -- Any channel off: truly disabled from POS OR disabled from online
                (
                    (
                        (item_present_at_all = FALSE OR item_present_at_all IS NULL)
                        AND (item_present_at_location_ids IS NULL OR item_present_at_location_ids = '[]'::jsonb OR jsonb_array_length(item_present_at_location_ids) = 0)
                    )
                    OR (available_online = FALSE OR available_online IS NULL)
                ) as any_channel_off
            FROM variation_data
            ORDER BY item_name, variation_name
        `;

        // SECURITY FIX: Use parameterized query with location_id as $2
        const params = [merchantId, sanitizedLocationId];
        const result = await db.query(query, params);

        // Calculate aggregate statistics
        const stats = {
            total_items: result.rows.length,
            missing_category: result.rows.filter(r => r.missing_category).length,
            not_taxable: result.rows.filter(r => r.not_taxable).length,
            missing_price: result.rows.filter(r => r.missing_price).length,
            missing_description: result.rows.filter(r => r.missing_description).length,
            missing_item_image: result.rows.filter(r => r.missing_item_image).length,
            missing_variation_image: result.rows.filter(r => r.missing_variation_image).length,
            missing_sku: result.rows.filter(r => r.missing_sku).length,
            missing_upc: result.rows.filter(r => r.missing_upc).length,
            stock_tracking_off: result.rows.filter(r => r.stock_tracking_off).length,
            inventory_alerts_off: result.rows.filter(r => r.inventory_alerts_off).length,
            no_reorder_threshold: result.rows.filter(r => r.no_reorder_threshold).length,
            missing_vendor: result.rows.filter(r => r.missing_vendor).length,
            missing_cost: result.rows.filter(r => r.missing_cost).length,
            missing_seo_title: result.rows.filter(r => r.missing_seo_title).length,
            missing_seo_description: result.rows.filter(r => r.missing_seo_description).length,
            no_tax_ids: result.rows.filter(r => r.no_tax_ids).length,
            location_mismatch: result.rows.filter(r => r.location_mismatch).length,
            any_channel_off: result.rows.filter(r => r.any_channel_off).length,
            pos_disabled: result.rows.filter(r => r.pos_disabled).length,
            online_disabled: result.rows.filter(r => r.online_disabled).length
        };

        // Count items with at least one issue
        stats.items_with_issues = result.rows.filter(r =>
            r.missing_category || r.not_taxable || r.missing_price ||
            r.missing_description || r.missing_item_image || r.missing_sku ||
            r.missing_upc || r.stock_tracking_off || r.inventory_alerts_off || r.no_reorder_threshold ||
            r.missing_vendor || r.missing_cost || r.location_mismatch || r.any_channel_off
        ).length;

        // Filter by specific issue type if requested
        let filteredData = result.rows;
        if (issue_type) {
            filteredData = result.rows.filter(r => r[issue_type] === true);
        }

        // Batch resolve ALL image URLs in a SINGLE query (much faster than per-item)
        const imageUrlMap = await batchResolveImageUrls(filteredData.map(row => ({
            images: row.variation_images,
            item_images: row.item_images
        })));

        // Calculate issue count per item (synchronous - no DB calls)
        const itemsWithIssueCounts = filteredData.map((row, index) => {
            let issueCount = 0;
            const issues = [];

            if (row.missing_category) { issueCount++; issues.push('No Category'); }
            if (row.not_taxable) { issueCount++; issues.push('Not Taxable'); }
            if (row.missing_price) { issueCount++; issues.push('No Price'); }
            if (row.missing_description) { issueCount++; issues.push('No Description'); }
            if (row.missing_item_image) { issueCount++; issues.push('No Image'); }
            if (row.missing_sku) { issueCount++; issues.push('No SKU'); }
            if (row.missing_upc) { issueCount++; issues.push('No UPC'); }
            if (row.stock_tracking_off) { issueCount++; issues.push('Stock Tracking Off'); }
            if (row.inventory_alerts_off) { issueCount++; issues.push('Inv Alerts Off'); }
            if (row.no_reorder_threshold) { issueCount++; issues.push('OOS, No Min'); }
            if (row.missing_vendor) { issueCount++; issues.push('No Vendor'); }
            if (row.missing_cost) { issueCount++; issues.push('No Cost'); }
            if (row.location_mismatch) { issueCount++; issues.push('Location Mismatch'); }
            // Sales channels
            if (row.any_channel_off) { issueCount++; issues.push('Channel Disabled'); }
            if (row.pos_disabled) { issues.push('POS Disabled'); }
            if (row.online_disabled) { issues.push('Online Disabled'); }
            // SEO fields
            if (row.missing_seo_title) { issues.push('No SEO Title'); }
            if (row.missing_seo_description) { issues.push('No SEO Description'); }
            // Tax configuration
            if (row.no_tax_ids) { issues.push('No Tax IDs'); }

            return {
                ...row,
                issue_count: issueCount,
                issues: issues,
                image_urls: imageUrlMap.get(index) || [],
                // Clean up internal fields
                variation_images: undefined,
                item_images: undefined
            };
        });

        res.json({
            stats: stats,
            count: itemsWithIssueCounts.length,
            items: itemsWithIssueCounts
        });

    } catch (error) {
        logger.error('Catalog audit error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/catalog-audit/fix-locations
 * Fix all location mismatches by setting items/variations to present_at_all_locations = true
 */
router.post('/catalog-audit/fix-locations', requireAuth, requireMerchant, validators.fixLocations, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Starting location mismatch fix from API', { merchantId });

        const result = await squareApi.fixLocationMismatches(merchantId);

        if (result.success) {
            res.json({
                success: true,
                message: `Fixed ${result.itemsFixed} items and ${result.variationsFixed} variations`,
                itemsFixed: result.itemsFixed,
                variationsFixed: result.variationsFixed,
                details: result.details
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Some items could not be fixed',
                itemsFixed: result.itemsFixed,
                variationsFixed: result.variationsFixed,
                errors: result.errors,
                details: result.details
            });
        }
    } catch (error) {
        logger.error('Fix location mismatches error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
