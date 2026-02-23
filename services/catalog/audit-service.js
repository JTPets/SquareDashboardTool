/**
 * Catalog Audit Service
 *
 * Business logic for catalog auditing:
 * - Comprehensive catalog audit identifying missing/incomplete data
 * - Location mismatch fixes
 *
 * Extracted from routes/catalog.js as part of P1-2 (fat routes service extraction).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');
const { batchResolveImageUrls } = require('../../utils/image-utils');

/**
 * Get comprehensive catalog audit data - identifies items with missing/incomplete data
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} filters - Optional filters { location_id, issue_type }
 * @returns {Promise<Object>} - { stats, count, items }
 */
async function getCatalogAudit(merchantId, filters = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getCatalogAudit');
    }

    const { location_id, issue_type } = filters;

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
                -- Committed inventory (RESERVED_FOR_SALE from purchase orders)
                (SELECT COALESCE(SUM(ic.quantity), 0)
                 FROM inventory_counts ic
                 WHERE ic.catalog_object_id = v.id
                   AND ic.state = 'RESERVED_FOR_SALE'
                   AND ic.merchant_id = v.merchant_id
                   AND ($2::text IS NULL OR ic.location_id = $2)
                ) as committed_quantity,
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
            -- Available quantity = on-hand minus committed (RESERVED_FOR_SALE)
            current_stock - committed_quantity as available_quantity,
            -- Calculate days of stock remaining (uses available quantity)
            CASE
                WHEN daily_velocity > 0 AND (current_stock - committed_quantity) > 0
                THEN ROUND((current_stock - committed_quantity) / daily_velocity, 1)
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
                (current_stock - committed_quantity) <= 0
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

    return {
        stats: stats,
        count: itemsWithIssueCounts.length,
        items: itemsWithIssueCounts
    };
}

/**
 * Fix all location mismatches by setting items/variations to present_at_all_locations = true
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - Result with success status and fix details
 */
async function fixLocationMismatches(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for fixLocationMismatches');
    }

    logger.info('Starting location mismatch fix from service', { merchantId });

    const result = await squareApi.fixLocationMismatches(merchantId);

    if (result.success) {
        return {
            success: true,
            message: `Fixed ${result.itemsFixed} items and ${result.variationsFixed} variations`,
            itemsFixed: result.itemsFixed,
            variationsFixed: result.variationsFixed,
            details: result.details
        };
    } else {
        return {
            success: false,
            message: 'Some items could not be fixed',
            itemsFixed: result.itemsFixed,
            variationsFixed: result.variationsFixed,
            errors: result.errors,
            details: result.details
        };
    }
}

/**
 * Enable a single parent item at all locations
 * Used when a cost update fails because the parent item isn't active at a location
 * @param {string} itemId - The Square catalog item ID
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - Result with success status
 */
async function enableItemAtAllLocations(itemId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for enableItemAtAllLocations');
    }
    if (!itemId) {
        throw new Error('itemId is required for enableItemAtAllLocations');
    }

    logger.info('Enabling item at all locations from service', { itemId, merchantId });

    try {
        const result = await squareApi.enableItemAtAllLocations(itemId, merchantId);

        return {
            success: true,
            message: `Activated "${result.itemName}" at all locations`,
            itemId: result.itemId,
            itemName: result.itemName
        };
    } catch (error) {
        logger.error('Failed to enable item at all locations', {
            itemId,
            merchantId,
            error: error.message
        });

        const isNotFound = error.message && error.message.includes('not found');
        const isAuth = error.message && error.message.includes('authentication failed');

        return {
            success: false,
            error: isNotFound
                ? 'Item not found in Square catalog. It may have been deleted.'
                : isAuth
                    ? 'Square authorization failed. Please reconnect your Square account.'
                    : 'Failed to activate item at all locations. Please try again.',
            status: isNotFound ? 404 : isAuth ? 401 : 500
        };
    }
}

/**
 * Enable LOW_QUANTITY inventory alerts on all variations with alerts off
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - Result with success status and fix details
 */
async function fixInventoryAlerts(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for fixInventoryAlerts');
    }

    logger.info('Starting inventory alerts fix from service', { merchantId });

    const result = await squareApi.fixInventoryAlerts(merchantId);

    if (result.success) {
        return {
            success: true,
            message: `Enabled alerts for ${result.variationsFixed} of ${result.totalFound} variations`,
            variationsFixed: result.variationsFixed,
            totalFound: result.totalFound,
            details: result.details
        };
    } else {
        return {
            success: false,
            message: 'Some variations could not be updated',
            variationsFixed: result.variationsFixed,
            totalFound: result.totalFound,
            errors: result.errors,
            details: result.details
        };
    }
}

module.exports = {
    getCatalogAudit,
    fixLocationMismatches,
    enableItemAtAllLocations,
    fixInventoryAlerts
};
