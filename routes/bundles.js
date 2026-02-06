/**
 * Bundle Routes
 *
 * CRUD for bundle definitions and components, plus availability calculation.
 * Square has no bundle API support - we track relationships locally.
 *
 * Endpoints:
 * - GET    /api/bundles              - List bundles with components
 * - POST   /api/bundles              - Create a new bundle
 * - PUT    /api/bundles/:id          - Update a bundle
 * - DELETE /api/bundles/:id          - Soft-delete (deactivate) a bundle
 * - GET    /api/bundles/availability  - Calculate assemblable qty per bundle
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/bundles');

// ==================== LIST BUNDLES ====================

/**
 * GET /api/bundles
 * List all bundles with their components for the current merchant
 */
router.get('/', requireAuth, requireMerchant, validators.getBundles, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { vendor_id, active_only } = req.query;

    let query_str = `
        SELECT
            bd.id, bd.merchant_id, bd.bundle_variation_id, bd.bundle_item_id,
            bd.bundle_item_name, bd.bundle_variation_name, bd.bundle_sku,
            bd.bundle_cost_cents, bd.bundle_sell_price_cents,
            bd.vendor_id, bd.is_active, bd.notes,
            bd.created_at, bd.updated_at,
            ve.name as vendor_name,
            json_agg(json_build_object(
                'id', bc.id,
                'child_variation_id', bc.child_variation_id,
                'child_item_id', bc.child_item_id,
                'quantity_in_bundle', bc.quantity_in_bundle,
                'child_item_name', bc.child_item_name,
                'child_variation_name', bc.child_variation_name,
                'child_sku', bc.child_sku,
                'individual_cost_cents', bc.individual_cost_cents
            ) ORDER BY bc.child_item_name) FILTER (WHERE bc.id IS NOT NULL) as components
        FROM bundle_definitions bd
        LEFT JOIN bundle_components bc ON bd.id = bc.bundle_id
        LEFT JOIN vendors ve ON bd.vendor_id = ve.id AND ve.merchant_id = $1
        WHERE bd.merchant_id = $1
    `;
    const params = [merchantId];

    if (active_only === 'true') {
        query_str += ` AND bd.is_active = true`;
    }

    if (vendor_id) {
        params.push(parseInt(vendor_id));
        query_str += ` AND bd.vendor_id = $${params.length}`;
    }

    query_str += ` GROUP BY bd.id, ve.name ORDER BY bd.bundle_item_name`;

    const result = await db.query(query_str, params);

    res.json({
        count: result.rows.length,
        bundles: result.rows.map(row => ({
            ...row,
            components: row.components || []
        }))
    });
}));

// ==================== BUNDLE AVAILABILITY ====================
// Must be defined BEFORE /:id to avoid route conflict

/**
 * GET /api/bundles/availability
 * Calculate assemblable quantity for each active bundle
 */
router.get('/availability', requireAuth, requireMerchant, validators.getAvailability, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { location_id } = req.query;

    // Get all active bundles with components
    const bundlesResult = await db.query(`
        SELECT
            bd.id as bundle_id, bd.bundle_variation_id, bd.bundle_item_name,
            bd.bundle_cost_cents, bd.bundle_sell_price_cents,
            bd.vendor_id, bd.bundle_sku,
            ve.name as vendor_name,
            bc.child_variation_id, bc.quantity_in_bundle,
            bc.child_item_name, bc.child_sku, bc.individual_cost_cents
        FROM bundle_definitions bd
        JOIN bundle_components bc ON bd.id = bc.bundle_id
        LEFT JOIN vendors ve ON bd.vendor_id = ve.id AND ve.merchant_id = $1
        WHERE bd.merchant_id = $1 AND bd.is_active = true
        ORDER BY bd.id, bc.child_item_name
    `, [merchantId]);

    if (bundlesResult.rows.length === 0) {
        return res.json({ count: 0, bundles: [] });
    }

    // Collect all child variation IDs for batch lookup
    const childVariationIds = [...new Set(bundlesResult.rows.map(r => r.child_variation_id))];
    const bundleVariationIds = [...new Set(bundlesResult.rows.map(r => r.bundle_variation_id))];
    const allVariationIds = [...new Set([...childVariationIds, ...bundleVariationIds])];

    // Batch fetch inventory and velocity
    let inventoryQuery = `
        SELECT catalog_object_id, COALESCE(SUM(quantity), 0) as stock
        FROM inventory_counts
        WHERE catalog_object_id = ANY($1)
          AND merchant_id = $2
          AND state = 'IN_STOCK'
    `;
    const inventoryParams = [allVariationIds, merchantId];

    if (location_id) {
        inventoryQuery += ` AND location_id = $3`;
        inventoryParams.push(location_id);
    }
    inventoryQuery += ` GROUP BY catalog_object_id`;

    let velocityQuery = `
        SELECT variation_id, daily_avg_quantity
        FROM sales_velocity
        WHERE variation_id = ANY($1)
          AND merchant_id = $2
          AND period_days = 91
    `;
    const velocityParams = [allVariationIds, merchantId];

    if (location_id) {
        velocityQuery += ` AND location_id = $3`;
        velocityParams.push(location_id);
    }

    // Fetch stock_alert_min for children
    const minStockQuery = `
        SELECT id, COALESCE(stock_alert_min, 0) as stock_alert_min
        FROM variations
        WHERE id = ANY($1) AND merchant_id = $2
    `;

    const [inventoryResult, velocityResult, minStockResult] = await Promise.all([
        db.query(inventoryQuery, inventoryParams),
        db.query(velocityQuery, velocityParams),
        db.query(minStockQuery, [childVariationIds, merchantId])
    ]);

    const stockMap = new Map(inventoryResult.rows.map(r => [r.catalog_object_id, parseInt(r.stock) || 0]));
    const velocityMap = new Map(velocityResult.rows.map(r => [r.variation_id, parseFloat(r.daily_avg_quantity) || 0]));
    const minStockMap = new Map(minStockResult.rows.map(r => [r.id, parseInt(r.stock_alert_min) || 0]));

    // Group rows by bundle
    const bundleMap = new Map();
    for (const row of bundlesResult.rows) {
        if (!bundleMap.has(row.bundle_id)) {
            bundleMap.set(row.bundle_id, {
                bundle_id: row.bundle_id,
                bundle_variation_id: row.bundle_variation_id,
                bundle_item_name: row.bundle_item_name,
                bundle_cost_cents: row.bundle_cost_cents,
                bundle_sell_price_cents: row.bundle_sell_price_cents,
                bundle_sku: row.bundle_sku,
                vendor_id: row.vendor_id,
                vendor_name: row.vendor_name,
                children: []
            });
        }
        bundleMap.get(row.bundle_id).children.push({
            child_variation_id: row.child_variation_id,
            quantity_in_bundle: row.quantity_in_bundle,
            child_item_name: row.child_item_name,
            child_sku: row.child_sku,
            individual_cost_cents: row.individual_cost_cents
        });
    }

    // Calculate availability for each bundle
    const bundles = [];
    for (const [, bundle] of bundleMap) {
        const bundleVelocity = velocityMap.get(bundle.bundle_variation_id) || 0;
        let limitingComponent = null;
        let assemblableQty = Infinity;

        const childDetails = bundle.children.map(child => {
            const stock = stockMap.get(child.child_variation_id) || 0;
            const minStock = minStockMap.get(child.child_variation_id) || 0;
            const childIndividualVelocity = velocityMap.get(child.child_variation_id) || 0;
            const bundleDrivenDaily = bundleVelocity * child.quantity_in_bundle;
            const totalDailyVelocity = childIndividualVelocity + bundleDrivenDaily;

            // Available stock for bundles = stock - safety stock (stock_alert_min)
            const availableForBundles = Math.max(0, stock - minStock);
            const canAssemble = child.quantity_in_bundle > 0
                ? Math.floor(availableForBundles / child.quantity_in_bundle)
                : 0;

            if (canAssemble < assemblableQty) {
                assemblableQty = canAssemble;
                limitingComponent = child.child_item_name;
            }

            const childDaysOfStock = totalDailyVelocity > 0
                ? Math.round((stock / totalDailyVelocity) * 10) / 10
                : 999;

            return {
                child_variation_id: child.child_variation_id,
                child_item_name: child.child_item_name,
                child_sku: child.child_sku,
                quantity_in_bundle: child.quantity_in_bundle,
                individual_cost_cents: child.individual_cost_cents,
                stock,
                stock_alert_min: minStock,
                available_for_bundles: availableForBundles,
                can_assemble: canAssemble,
                individual_daily_velocity: childIndividualVelocity,
                bundle_driven_daily_velocity: bundleDrivenDaily,
                total_daily_velocity: totalDailyVelocity,
                pct_from_bundles: totalDailyVelocity > 0
                    ? Math.round((bundleDrivenDaily / totalDailyVelocity) * 1000) / 10
                    : 0,
                days_of_stock: childDaysOfStock
            };
        });

        if (assemblableQty === Infinity) assemblableQty = 0;

        const bundleDailyVelocity = bundleVelocity;
        const daysOfBundleStock = bundleDailyVelocity > 0
            ? Math.round((assemblableQty / bundleDailyVelocity) * 10) / 10
            : 999;

        bundles.push({
            bundle_id: bundle.bundle_id,
            bundle_variation_id: bundle.bundle_variation_id,
            bundle_item_name: bundle.bundle_item_name,
            bundle_cost_cents: bundle.bundle_cost_cents,
            bundle_sell_price_cents: bundle.bundle_sell_price_cents,
            bundle_sku: bundle.bundle_sku,
            vendor_id: bundle.vendor_id,
            vendor_name: bundle.vendor_name,
            assemblable_qty: assemblableQty,
            limiting_component: limitingComponent,
            days_of_bundle_stock: daysOfBundleStock,
            bundle_daily_velocity: bundleDailyVelocity,
            children: childDetails
        });
    }

    res.json({ count: bundles.length, bundles });
}));

// ==================== CREATE BUNDLE ====================

/**
 * POST /api/bundles
 * Create a new bundle definition with components
 */
router.post('/', requireAuth, requireMerchant, validators.createBundle, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const {
        bundle_variation_id, bundle_item_id, bundle_item_name,
        bundle_variation_name, bundle_sku, bundle_cost_cents,
        bundle_sell_price_cents, vendor_id, notes, components
    } = req.body;

    const result = await db.transaction(async (client) => {
        // Insert bundle definition
        const defResult = await client.query(`
            INSERT INTO bundle_definitions (
                merchant_id, bundle_variation_id, bundle_item_id,
                bundle_item_name, bundle_variation_name, bundle_sku,
                bundle_cost_cents, bundle_sell_price_cents,
                vendor_id, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [
            merchantId, bundle_variation_id, bundle_item_id || null,
            bundle_item_name, bundle_variation_name || null, bundle_sku || null,
            bundle_cost_cents, bundle_sell_price_cents || null,
            vendor_id || null, notes || null
        ]);

        const bundleId = defResult.rows[0].id;

        // Auto-populate child names/SKUs from catalog
        const childVariationIds = components.map(c => c.child_variation_id);
        const catalogResult = await client.query(`
            SELECT v.id as variation_id, v.item_id, i.name as item_name,
                   v.name as variation_name, v.sku
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE v.id = ANY($2) AND v.merchant_id = $1
        `, [merchantId, childVariationIds]);

        const catalogMap = new Map(catalogResult.rows.map(r => [r.variation_id, r]));

        // Bulk insert components
        const componentRows = [];
        for (const comp of components) {
            const catalog = catalogMap.get(comp.child_variation_id);
            componentRows.push(await client.query(`
                INSERT INTO bundle_components (
                    bundle_id, child_variation_id, child_item_id,
                    quantity_in_bundle, child_item_name,
                    child_variation_name, child_sku, individual_cost_cents
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `, [
                bundleId,
                comp.child_variation_id,
                catalog ? catalog.item_id : null,
                comp.quantity_in_bundle,
                catalog ? catalog.item_name : null,
                catalog ? catalog.variation_name : null,
                catalog ? catalog.sku : null,
                comp.individual_cost_cents || null
            ]));
        }

        return {
            ...defResult.rows[0],
            components: componentRows.map(r => r.rows[0])
        };
    });

    logger.info('Bundle created', {
        merchantId, bundleId: result.id,
        name: result.bundle_item_name,
        componentCount: result.components.length
    });

    res.status(201).json({ success: true, bundle: result });
}));

// ==================== UPDATE BUNDLE ====================

/**
 * PUT /api/bundles/:id
 * Update bundle definition and optionally replace components
 */
router.put('/:id', requireAuth, requireMerchant, validators.updateBundle, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const bundleId = parseInt(req.params.id);
    const { bundle_cost_cents, bundle_sell_price_cents, is_active, notes, vendor_id, components } = req.body;

    const result = await db.transaction(async (client) => {
        // Verify ownership
        const existing = await client.query(
            'SELECT id FROM bundle_definitions WHERE id = $1 AND merchant_id = $2',
            [bundleId, merchantId]
        );
        if (existing.rows.length === 0) {
            const err = new Error('Bundle not found');
            err.status = 404;
            throw err;
        }

        // Build dynamic update
        const updates = [];
        const params = [bundleId, merchantId];
        let paramIdx = 3;

        if (bundle_cost_cents !== undefined) {
            updates.push(`bundle_cost_cents = $${paramIdx++}`);
            params.push(bundle_cost_cents);
        }
        if (bundle_sell_price_cents !== undefined) {
            updates.push(`bundle_sell_price_cents = $${paramIdx++}`);
            params.push(bundle_sell_price_cents);
        }
        if (is_active !== undefined) {
            updates.push(`is_active = $${paramIdx++}`);
            params.push(is_active);
        }
        if (notes !== undefined) {
            updates.push(`notes = $${paramIdx++}`);
            params.push(notes);
        }
        if (vendor_id !== undefined) {
            updates.push(`vendor_id = $${paramIdx++}`);
            params.push(vendor_id);
        }

        updates.push('updated_at = NOW()');

        const defResult = await client.query(`
            UPDATE bundle_definitions
            SET ${updates.join(', ')}
            WHERE id = $1 AND merchant_id = $2
            RETURNING *
        `, params);

        // Replace components if provided
        let finalComponents;
        if (components) {
            await client.query('DELETE FROM bundle_components WHERE bundle_id = $1', [bundleId]);

            const childVariationIds = components.map(c => c.child_variation_id);
            const catalogResult = await client.query(`
                SELECT v.id as variation_id, v.item_id, i.name as item_name,
                       v.name as variation_name, v.sku
                FROM variations v
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                WHERE v.id = ANY($2) AND v.merchant_id = $1
            `, [merchantId, childVariationIds]);

            const catalogMap = new Map(catalogResult.rows.map(r => [r.variation_id, r]));

            const componentRows = [];
            for (const comp of components) {
                const catalog = catalogMap.get(comp.child_variation_id);
                componentRows.push(await client.query(`
                    INSERT INTO bundle_components (
                        bundle_id, child_variation_id, child_item_id,
                        quantity_in_bundle, child_item_name,
                        child_variation_name, child_sku, individual_cost_cents
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING *
                `, [
                    bundleId,
                    comp.child_variation_id,
                    catalog ? catalog.item_id : null,
                    comp.quantity_in_bundle,
                    catalog ? catalog.item_name : null,
                    catalog ? catalog.variation_name : null,
                    catalog ? catalog.sku : null,
                    comp.individual_cost_cents || null
                ]));
            }
            finalComponents = componentRows.map(r => r.rows[0]);
        } else {
            const compResult = await client.query(
                'SELECT * FROM bundle_components WHERE bundle_id = $1 ORDER BY child_item_name',
                [bundleId]
            );
            finalComponents = compResult.rows;
        }

        return { ...defResult.rows[0], components: finalComponents };
    });

    logger.info('Bundle updated', { merchantId, bundleId, name: result.bundle_item_name });
    res.json({ success: true, bundle: result });
}));

// ==================== DELETE (SOFT) BUNDLE ====================

/**
 * DELETE /api/bundles/:id
 * Soft-delete: sets is_active = false
 */
router.delete('/:id', requireAuth, requireMerchant, validators.deleteBundle, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const bundleId = parseInt(req.params.id);

    const result = await db.query(`
        UPDATE bundle_definitions
        SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, bundle_item_name
    `, [bundleId, merchantId]);

    if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Bundle not found' });
    }

    logger.info('Bundle deactivated', { merchantId, bundleId, name: result.rows[0].bundle_item_name });
    res.json({ success: true, message: 'Bundle deactivated', bundle: result.rows[0] });
}));

module.exports = router;
