/**
 * Bundle Service
 *
 * Business logic for bundle CRUD operations and availability calculation.
 * Extracted from routes/bundles.js per REMEDIATION-PLAN.md Pkg 5 (A-2).
 *
 * Square has no bundle API — we track bundle relationships locally.
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

/**
 * List all bundles with their components for a merchant
 * @param {number} merchantId
 * @param {Object} filters - { active_only, vendor_id }
 * @returns {Object} { count, bundles }
 */
async function listBundles(merchantId, { active_only, vendor_id } = {}) {
    let query_str = `
        SELECT
            bd.id, bd.merchant_id, bd.bundle_variation_id, bd.bundle_item_id,
            bd.bundle_item_name, bd.bundle_variation_name, bd.bundle_sku,
            bd.bundle_cost_cents, bd.bundle_sell_price_cents,
            bd.vendor_id, bd.vendor_code, bd.is_active, bd.notes,
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
        params.push(vendor_id);
        query_str += ` AND bd.vendor_id = $${params.length}`;
    }

    query_str += ` GROUP BY bd.id, ve.name ORDER BY bd.bundle_item_name`;

    const result = await db.query(query_str, params);

    return {
        count: result.rows.length,
        bundles: result.rows.map(row => ({
            ...row,
            components: row.components || []
        }))
    };
}

/**
 * Calculate assemblable quantity for each active bundle
 * @param {number} merchantId
 * @param {Object} options - { location_id }
 * @returns {Object} { count, bundles }
 */
async function calculateAvailability(merchantId, { location_id } = {}) {
    const bundlesResult = await db.query(`
        SELECT
            bd.id as bundle_id, bd.bundle_variation_id, bd.bundle_item_name,
            bd.bundle_cost_cents, bd.bundle_sell_price_cents,
            bd.vendor_id, bd.vendor_code as bundle_vendor_code, bd.bundle_sku,
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
        return { count: 0, bundles: [] };
    }

    const childVariationIds = [...new Set(bundlesResult.rows.map(r => r.child_variation_id))];
    const bundleVariationIds = [...new Set(bundlesResult.rows.map(r => r.bundle_variation_id))];
    const allVariationIds = [...new Set([...childVariationIds, ...bundleVariationIds])];

    // Batch fetch inventory (includes committed/RESERVED_FOR_SALE)
    let inventoryQuery = `
        SELECT catalog_object_id,
            COALESCE(SUM(CASE WHEN state = 'IN_STOCK' THEN quantity ELSE 0 END), 0) as stock,
            COALESCE(SUM(CASE WHEN state = 'RESERVED_FOR_SALE' THEN quantity ELSE 0 END), 0) as committed
        FROM inventory_counts
        WHERE catalog_object_id = ANY($1)
          AND merchant_id = $2
          AND state IN ('IN_STOCK', 'RESERVED_FOR_SALE')
    `;
    const inventoryParams = [allVariationIds, merchantId];

    if (location_id) {
        inventoryQuery += ` AND location_id = $3`;
        inventoryParams.push(location_id);
    }
    inventoryQuery += ` GROUP BY catalog_object_id`;

    // Batch fetch velocity
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

    // Fetch stock_alert_min (with location override), is_deleted, and vendor_code
    let minStockQuery = `
        SELECT v.id,
            COALESCE(vls.stock_alert_min, v.stock_alert_min, 0) as stock_alert_min,
            COALESCE(v.is_deleted, FALSE) as is_deleted,
            vv.vendor_code
        FROM variations v
        LEFT JOIN variation_location_settings vls
            ON v.id = vls.variation_id AND vls.merchant_id = $2
    `;
    const minStockParams = [childVariationIds, merchantId];
    if (location_id) {
        minStockQuery += ` AND vls.location_id = $3`;
        minStockParams.push(location_id);
    }
    minStockQuery += `
        LEFT JOIN variation_vendors vv
            ON v.id = vv.variation_id AND vv.merchant_id = $2
    `;
    minStockQuery += ` WHERE v.id = ANY($1) AND v.merchant_id = $2`;

    const [inventoryResult, velocityResult, minStockResult] = await Promise.all([
        db.query(inventoryQuery, inventoryParams),
        db.query(velocityQuery, velocityParams),
        db.query(minStockQuery, minStockParams)
    ]);

    const stockMap = new Map(inventoryResult.rows.map(r => [r.catalog_object_id, parseInt(r.stock) || 0]));
    const committedMap = new Map(inventoryResult.rows.map(r => [r.catalog_object_id, parseInt(r.committed) || 0]));
    const velocityMap = new Map(velocityResult.rows.map(r => [r.variation_id, parseFloat(r.daily_avg_quantity) || 0]));
    const minStockMap = new Map(minStockResult.rows.map(r => [r.id, parseInt(r.stock_alert_min) || 0]));
    const deletedMap = new Map(minStockResult.rows.map(r => [r.id, r.is_deleted === true]));
    const vendorCodeMap = new Map(minStockResult.rows.map(r => [r.id, r.vendor_code || null]));

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
                bundle_vendor_code: row.bundle_vendor_code,
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
            const committed = committedMap.get(child.child_variation_id) || 0;
            const availableStock = stock - committed;
            const minStock = minStockMap.get(child.child_variation_id) || 0;
            const childIndividualVelocity = velocityMap.get(child.child_variation_id) || 0;
            const bundleDrivenDaily = bundleVelocity * child.quantity_in_bundle;
            const totalDailyVelocity = childIndividualVelocity + bundleDrivenDaily;

            const availableForBundles = Math.max(0, availableStock - minStock);
            const canAssemble = child.quantity_in_bundle > 0
                ? Math.floor(availableForBundles / child.quantity_in_bundle)
                : 0;

            if (canAssemble < assemblableQty) {
                assemblableQty = canAssemble;
                limitingComponent = child.child_item_name;
            }

            const childDaysOfStock = totalDailyVelocity > 0
                ? Math.round((availableStock / totalDailyVelocity) * 10) / 10
                : 999;

            return {
                child_variation_id: child.child_variation_id,
                child_item_name: child.child_item_name,
                child_sku: child.child_sku,
                quantity_in_bundle: child.quantity_in_bundle,
                individual_cost_cents: child.individual_cost_cents,
                stock,
                committed_quantity: committed,
                available_quantity: availableStock,
                stock_alert_min: minStock,
                available_for_bundles: availableForBundles,
                can_assemble: canAssemble,
                individual_daily_velocity: childIndividualVelocity,
                bundle_driven_daily_velocity: bundleDrivenDaily,
                total_daily_velocity: totalDailyVelocity,
                pct_from_bundles: totalDailyVelocity > 0
                    ? Math.round((bundleDrivenDaily / totalDailyVelocity) * 1000) / 10
                    : 0,
                days_of_stock: childDaysOfStock,
                is_deleted: deletedMap.get(child.child_variation_id) || false,
                vendor_code: vendorCodeMap.get(child.child_variation_id) || null
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
            bundle_vendor_code: bundle.bundle_vendor_code,
            vendor_name: bundle.vendor_name,
            assemblable_qty: assemblableQty,
            limiting_component: limitingComponent,
            days_of_bundle_stock: daysOfBundleStock,
            bundle_daily_velocity: bundleDailyVelocity,
            children: childDetails
        });
    }

    return { count: bundles.length, bundles };
}

/**
 * Look up catalog info for child variations (names, SKUs, item IDs)
 * @param {Object} client - DB transaction client
 * @param {number} merchantId
 * @param {string[]} childVariationIds
 * @returns {Map<string, Object>} variation_id -> { item_id, item_name, variation_name, sku }
 */
async function _lookupChildCatalog(client, merchantId, childVariationIds) {
    const catalogResult = await client.query(`
        SELECT v.id as variation_id, v.item_id, i.name as item_name,
               v.name as variation_name, v.sku
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        WHERE v.id = ANY($2) AND v.merchant_id = $1
    `, [merchantId, childVariationIds]);

    return new Map(catalogResult.rows.map(r => [r.variation_id, r]));
}

/**
 * Batch insert bundle components using multi-row VALUES
 * @param {Object} client - DB transaction client
 * @param {number} bundleId
 * @param {Array} components - [{ child_variation_id, quantity_in_bundle, individual_cost_cents }]
 * @param {Map} catalogMap - variation_id -> catalog info
 * @returns {Array} Inserted component rows
 */
async function _batchInsertComponents(client, bundleId, components, catalogMap) {
    if (!components || components.length === 0) {
        return [];
    }

    // Build multi-row VALUES clause
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const comp of components) {
        const catalog = catalogMap.get(comp.child_variation_id);
        values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7})`);
        params.push(
            bundleId,
            comp.child_variation_id,
            catalog ? catalog.item_id : null,
            comp.quantity_in_bundle,
            catalog ? catalog.item_name : null,
            catalog ? catalog.variation_name : null,
            catalog ? catalog.sku : null,
            comp.individual_cost_cents || null
        );
        paramIdx += 8;
    }

    const result = await client.query(`
        INSERT INTO bundle_components (
            bundle_id, child_variation_id, child_item_id,
            quantity_in_bundle, child_item_name,
            child_variation_name, child_sku, individual_cost_cents
        ) VALUES ${values.join(', ')}
        RETURNING *
    `, params);

    return result.rows;
}

/**
 * Create a new bundle definition with components
 * @param {number} merchantId
 * @param {Object} data - bundle fields + components array
 * @returns {Object} Created bundle with components
 */
async function createBundle(merchantId, data) {
    const {
        bundle_variation_id, bundle_item_id, bundle_item_name,
        bundle_variation_name, bundle_sku, bundle_cost_cents,
        bundle_sell_price_cents, vendor_id, vendor_code, notes, components
    } = data;

    const result = await db.transaction(async (client) => {
        const defResult = await client.query(`
            INSERT INTO bundle_definitions (
                merchant_id, bundle_variation_id, bundle_item_id,
                bundle_item_name, bundle_variation_name, bundle_sku,
                bundle_cost_cents, bundle_sell_price_cents,
                vendor_id, vendor_code, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `, [
            merchantId, bundle_variation_id, bundle_item_id || null,
            bundle_item_name, bundle_variation_name || null, bundle_sku || null,
            bundle_cost_cents, bundle_sell_price_cents || null,
            vendor_id || null, vendor_code || null, notes || null
        ]);

        const bundleId = defResult.rows[0].id;
        const childVariationIds = components.map(c => c.child_variation_id);
        const catalogMap = await _lookupChildCatalog(client, merchantId, childVariationIds);
        const insertedComponents = await _batchInsertComponents(client, bundleId, components, catalogMap);

        return {
            ...defResult.rows[0],
            components: insertedComponents
        };
    });

    logger.info('Bundle created', {
        merchantId, bundleId: result.id,
        name: result.bundle_item_name,
        componentCount: result.components.length
    });

    return result;
}

/**
 * Update a bundle definition and optionally replace components
 * @param {number} merchantId
 * @param {number} bundleId
 * @param {Object} data - fields to update + optional components array
 * @returns {Object} Updated bundle with components
 */
async function updateBundle(merchantId, bundleId, data) {
    const { bundle_cost_cents, bundle_sell_price_cents, is_active, notes, vendor_id, vendor_code, components } = data;

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
        if (vendor_code !== undefined) {
            updates.push(`vendor_code = $${paramIdx++}`);
            params.push(vendor_code || null);
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
            const catalogMap = await _lookupChildCatalog(client, merchantId, childVariationIds);
            finalComponents = await _batchInsertComponents(client, bundleId, components, catalogMap);
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
    return result;
}

/**
 * Soft-delete (deactivate) a bundle
 * @param {number} merchantId
 * @param {number} bundleId
 * @returns {Object|null} Deactivated bundle row, or null if not found
 */
async function deleteBundle(merchantId, bundleId) {
    const result = await db.query(`
        UPDATE bundle_definitions
        SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, bundle_item_name
    `, [bundleId, merchantId]);

    if (result.rows.length === 0) {
        return null;
    }

    logger.info('Bundle deactivated', { merchantId, bundleId, name: result.rows[0].bundle_item_name });
    return result.rows[0];
}

module.exports = {
    listBundles,
    calculateAvailability,
    createBundle,
    updateBundle,
    deleteBundle,
    // Exported for testing
    _lookupChildCatalog,
    _batchInsertComponents
};
