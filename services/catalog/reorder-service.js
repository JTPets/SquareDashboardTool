/**
 * Reorder Service — Business logic for reorder suggestions
 *
 * Extracted from routes/analytics.js (O-7).
 * Handles: SQL construction, row processing, bundle analysis,
 * other-vendor-items query, filtering, sorting, image resolution.
 */

'use strict';

const db = require('../../utils/database');
const { getMerchantSettings } = require('../merchant');
const logger = require('../../utils/logger');
const { batchResolveImageUrls } = require('../../utils/image-utils');
const { calculateOrderOptions } = require('../bundle-calculator');
const { calculateReorderQuantity } = require('./reorder-math');

/**
 * Get reorder suggestions for a merchant.
 *
 * @param {object} params
 * @param {number} params.merchantId
 * @param {string} params.businessName - For logging
 * @param {object} params.query - Validated query params (vendor_id, supply_days, location_id, min_cost, include_other)
 * @returns {object} { count, supply_days, safety_days, suggestions, bundle_analysis, bundle_affiliations, other_vendor_items? }
 */
async function getReorderSuggestions({ merchantId, businessName, query }) {
    const { vendor_id, supply_days, location_id, min_cost, include_other } = query;

    const merchantSettings = await getMerchantSettings(merchantId);

    const defaultSupplyDays = merchantSettings.default_supply_days ||
        parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45');
    const supplyDaysParam = supply_days || defaultSupplyDays;

    const safetyDays = merchantSettings.reorder_safety_days ??
        parseInt(process.env.REORDER_SAFETY_DAYS || '7');

    logger.info('Reorder suggestions request', {
        merchantId,
        merchantName: businessName,
        vendor_id,
        supply_days: supplyDaysParam,
        safety_days: safetyDays,
        reorder_threshold: parseInt(supplyDaysParam) + safetyDays,
        location_id,
        usingMerchantSettings: true
    });

    const supplyDaysNum = parseInt(supplyDaysParam);
    if (isNaN(supplyDaysNum) || supplyDaysNum < 1 || supplyDaysNum > 365) {
        return { error: 'Invalid supply_days parameter', message: 'supply_days must be a number between 1 and 365' };
    }

    if (min_cost !== undefined) {
        const minCostNum = parseFloat(min_cost);
        if (isNaN(minCostNum) || minCostNum < 0) {
            return { error: 'Invalid min_cost parameter', message: 'min_cost must be a positive number' };
        }
    }

    // Run main reorder query
    const { rows, params: queryParams } = buildMainQuery({ supplyDaysNum, safetyDays, merchantId, vendor_id, location_id });
    const queryStart = Date.now();
    const result = await db.query(rows, queryParams);
    const queryDurationMs = Date.now() - queryStart;

    logger.info('Reorder query results', {
        merchantId,
        rowCount: result.rows.length,
        queryDurationMs,
        params: queryParams.slice(0, 3)
    });

    // Process rows into suggestions
    const priorityConfig = {
        urgentDays: merchantSettings.reorder_priority_urgent_days ??
            parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0'),
        highDays: merchantSettings.reorder_priority_high_days ??
            parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7'),
        mediumDays: merchantSettings.reorder_priority_medium_days ??
            parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14'),
        lowDays: merchantSettings.reorder_priority_low_days ??
            parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30')
    };

    const suggestions = processSuggestionRows(result.rows, { supplyDaysNum, safetyDays, priorityConfig });

    // Apply min_cost filter
    let filteredSuggestions = suggestions;
    if (min_cost) {
        const minCostNum = parseFloat(min_cost);
        filteredSuggestions = suggestions.filter(s => s.order_cost >= minCostNum);
    }

    // Sort by priority, then stockout days, then velocity
    sortSuggestions(filteredSuggestions);

    // Resolve image URLs
    const imageUrlMap = await batchResolveImageUrls(filteredSuggestions, merchantId);
    const suggestionsWithImages = filteredSuggestions.map((suggestion, index) => ({
        ...suggestion,
        image_urls: imageUrlMap.get(index) || [],
        images: undefined,
        item_images: undefined
    }));

    // Bundle analysis
    const { bundleAnalysis, bundleAffiliations } = await runBundleAnalysis({
        merchantId, vendor_id, location_id, supplyDaysNum, safetyDays
    });

    // Build response
    const responsePayload = {
        count: suggestionsWithImages.length,
        supply_days: supplyDaysNum,
        safety_days: safetyDays,
        suggestions: suggestionsWithImages,
        bundle_analysis: bundleAnalysis,
        bundle_affiliations: bundleAffiliations
    };

    // Other vendor items
    if (include_other === 'true' && vendor_id && vendor_id !== 'none') {
        responsePayload.other_vendor_items = await fetchOtherVendorItems({
            merchantId, vendor_id, location_id,
            suggestedVarIds: suggestionsWithImages.map(s => s.variation_id)
        });
    }

    return responsePayload;
}

// ============================================================================
// MAIN QUERY
// ============================================================================

function buildMainQuery({ supplyDaysNum, safetyDays, merchantId, vendor_id, location_id }) {
    const reorderThreshold = supplyDaysNum + safetyDays;
    const params = [reorderThreshold, merchantId];

    // PERF-6: Optimized from 11 JOINs + 4 correlated subqueries to 8 JOINs + 2 LATERAL + 1 subquery.
    // - 3 sales_velocity JOINs (sv91/sv182/sv365) → 1 LATERAL with conditional aggregation
    // - 3 primary-vendor correlated subqueries → 1 LATERAL JOIN
    let query = `
            SELECT
                v.id as variation_id,
                i.name as item_name,
                v.name as variation_name,
                v.sku,
                v.images,
                i.images as item_images,
                i.category_name,
                ic.location_id as location_id,
                l.name as location_name,
                COALESCE(ic.quantity, 0) as current_stock,
                COALESCE(ic_committed.quantity, 0) as committed_quantity,
                COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0) as available_quantity,
                sv.daily_avg_quantity,
                sv.weekly_avg_91d as weekly_avg_quantity,
                sv.weekly_avg_91d,
                sv.weekly_avg_182d,
                sv.weekly_avg_365d,
                -- Expiration data
                vexp.expiration_date,
                vexp.does_not_expire,
                CASE
                    WHEN vexp.does_not_expire = TRUE THEN NULL
                    WHEN vexp.expiration_date IS NOT NULL THEN
                        EXTRACT(DAY FROM (vexp.expiration_date - CURRENT_DATE))::INTEGER
                    ELSE NULL
                END as days_until_expiry,
                ve.name as vendor_name,
                vv.vendor_code,
                vv.vendor_id as current_vendor_id,
                vv.unit_cost_money as unit_cost_cents,
                -- Primary vendor (cheapest cost, then earliest) from LATERAL join
                pv.vendor_id as primary_vendor_id,
                pv.vendor_name as primary_vendor_name,
                pv.unit_cost_money as primary_vendor_cost,
                -- Pending quantity from unreceived purchase orders (single correlated subquery)
                COALESCE((
                    SELECT SUM(poi.quantity_ordered - COALESCE(poi.received_quantity, 0))
                    FROM purchase_order_items poi
                    JOIN purchase_orders po ON poi.purchase_order_id = po.id AND po.merchant_id = $2
                    WHERE poi.variation_id = v.id AND poi.merchant_id = $2
                      AND po.status NOT IN ('RECEIVED', 'CANCELLED')
                      AND (poi.quantity_ordered - COALESCE(poi.received_quantity, 0)) > 0
                ), 0) as pending_po_quantity,
                v.case_pack_quantity,
                v.reorder_multiple,
                v.price_money as retail_price_cents,
                -- Prefer location-specific settings over global
                COALESCE(vls.stock_alert_min, v.stock_alert_min) as stock_alert_min,
                COALESCE(vls.stock_alert_max, v.stock_alert_max) as stock_alert_max,
                COALESCE(vls.preferred_stock_level, v.preferred_stock_level) as preferred_stock_level,
                ve.lead_time_days,
                ve.default_supply_days,
                -- Calculate days until stockout based on AVAILABLE quantity (not total on-hand)
                CASE
                    WHEN sv.daily_avg_quantity > 0 AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) > 0
                    THEN ROUND((COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv.daily_avg_quantity, 1)
                    WHEN (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0
                    THEN 0
                    ELSE 999
                END as days_until_stockout,
                -- Base suggested quantity (supply_days worth of inventory)
                ROUND(COALESCE(sv.daily_avg_quantity, 0) * $1, 2) as base_suggested_qty,
                -- Whether currently at or below minimum stock based on AVAILABLE quantity
                CASE
                    WHEN COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                         AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= COALESCE(vls.stock_alert_min, v.stock_alert_min)
                    THEN TRUE
                    ELSE FALSE
                END as below_minimum,
                EXTRACT(DAY FROM NOW() - v.created_at)::INTEGER as variation_age_days
            FROM variations v
            -- Item details: name, category, is_deleted filter
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            -- Current vendor assignment: vendor_code, unit_cost for this variation
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
            -- Vendor details: name, lead_time_days, default_supply_days
            LEFT JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $2
            -- On-hand inventory at each location (IN_STOCK state only)
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $2
                AND ic.state = 'IN_STOCK'
            -- Sales velocity: 91d/182d/365d periods in one LATERAL (replaces 3 separate JOINs)
            LEFT JOIN LATERAL (
                SELECT
                    MAX(CASE WHEN period_days = 91 THEN daily_avg_quantity END) as daily_avg_quantity,
                    MAX(CASE WHEN period_days = 91 THEN weekly_avg_quantity END) as weekly_avg_91d,
                    MAX(CASE WHEN period_days = 182 THEN weekly_avg_quantity END) as weekly_avg_182d,
                    MAX(CASE WHEN period_days = 365 THEN weekly_avg_quantity END) as weekly_avg_365d
                FROM sales_velocity
                WHERE variation_id = v.id AND merchant_id = $2
                    AND period_days IN (91, 182, 365)
                    AND (location_id = ic.location_id OR (location_id IS NULL AND ic.location_id IS NULL))
            ) sv ON TRUE
            -- Committed (reserved) inventory at same location as on-hand
            LEFT JOIN inventory_counts ic_committed ON v.id = ic_committed.catalog_object_id AND ic_committed.merchant_id = $2
                AND ic_committed.state = 'RESERVED_FOR_SALE'
                AND ic_committed.location_id = ic.location_id
            -- Location name for display
            LEFT JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $2
            -- Per-location stock settings: overrides variation-level stock_alert_min/max
            LEFT JOIN variation_location_settings vls ON v.id = vls.variation_id AND vls.merchant_id = $2
                AND ic.location_id = vls.location_id
            -- Expiration tracking: date and does_not_expire flag for display
            LEFT JOIN variation_expiration vexp ON v.id = vexp.variation_id AND vexp.merchant_id = $2
            -- Primary vendor: cheapest by cost, then earliest created (replaces 3 correlated subqueries)
            LEFT JOIN LATERAL (
                SELECT vv2.vendor_id, vv2.unit_cost_money, ve2.name as vendor_name
                FROM variation_vendors vv2
                LEFT JOIN vendors ve2 ON vv2.vendor_id = ve2.id AND ve2.merchant_id = $2
                WHERE vv2.variation_id = v.id AND vv2.merchant_id = $2
                ORDER BY vv2.unit_cost_money ASC, vv2.created_at ASC
                LIMIT 1
            ) pv ON TRUE
            WHERE v.merchant_id = $2
              AND v.discontinued = FALSE
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND (
                  -- ALWAYS SHOW: Out of available stock (available = on_hand - committed)
                  (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0

                  OR

                  -- ALWAYS SHOW: Items at or below alert threshold based on AVAILABLE quantity
                  (COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                      AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= COALESCE(vls.stock_alert_min, v.stock_alert_min))

                  OR

                  -- APPLY SUPPLY_DAYS + SAFETY_DAYS + LEAD_TIME: Items with available stock that will run out within threshold period
                  -- Only applies to items with active sales velocity (daily_avg_quantity > 0)
                  -- $1 is (supply_days + safety_days); per-vendor lead_time_days added dynamically
                  (sv.daily_avg_quantity > 0
                      AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv.daily_avg_quantity < $1 + COALESCE(ve.lead_time_days, 0))
              )
        `;

    if (vendor_id === 'none') {
        query += ` AND vv.vendor_id IS NULL`;
    } else if (vendor_id) {
        params.push(vendor_id);
        query += ` AND vv.vendor_id = $${params.length}`;
    }

    if (location_id) {
        params.push(location_id);
        query += ` AND (ic.location_id = $${params.length} OR ic.location_id IS NULL)`;
    }

    return { rows: query, params };
}

// ============================================================================
// ROW PROCESSING
// ============================================================================

function processSuggestionRows(rows, { supplyDaysNum, safetyDays, priorityConfig }) {
    const { urgentDays, highDays, mediumDays, lowDays } = priorityConfig;

    return rows
        .map(row => {
            const currentStock = parseFloat(row.current_stock) || 0;
            const committedQty = parseInt(row.committed_quantity) || 0;
            const availableQty = currentStock - committedQty;
            const dailyAvg = parseFloat(row.daily_avg_quantity) || 0;
            const baseSuggestedQty = Math.ceil(parseFloat(row.base_suggested_qty) || 0);
            const casePack = parseInt(row.case_pack_quantity) || 1;
            const reorderMultiple = parseInt(row.reorder_multiple) || 1;
            const stockAlertMin = parseInt(row.stock_alert_min) || 0;
            const stockAlertMax = row.stock_alert_max ? parseInt(row.stock_alert_max) : null;
            const locationId = row.location_id || null;
            const locationName = row.location_name || null;
            const leadTime = parseInt(row.lead_time_days) || 0;
            const daysUntilStockout = parseFloat(row.days_until_stockout) || 999;

            // Don't suggest if AVAILABLE already above max (null = unlimited, so skip this check)
            if (stockAlertMax !== null && availableQty >= stockAlertMax) {
                return null;
            }

            // FILTERING LOGIC (must match SQL WHERE clause)
            const isOutOfStock = availableQty <= 0;
            const reorderThreshold = supplyDaysNum + leadTime + safetyDays;
            const needsReorder = isOutOfStock || row.below_minimum || daysUntilStockout < reorderThreshold;
            if (!needsReorder) {
                return null;
            }

            // Calculate priority and reorder reason
            let priority;
            let reorder_reason;

            if (availableQty <= urgentDays) {
                if (dailyAvg > 0) {
                    priority = 'URGENT';
                    reorder_reason = 'Out of stock with active sales';
                } else {
                    priority = 'MEDIUM';
                    reorder_reason = 'Out of stock - no recent sales';
                }
            } else if (row.below_minimum && stockAlertMin > 0) {
                priority = 'HIGH';
                const locationInfo = locationName ? ` at ${locationName}` : '';
                reorder_reason = `Below stock alert threshold (${stockAlertMin} units)${locationInfo}`;
            } else if (daysUntilStockout < highDays) {
                priority = 'HIGH';
                reorder_reason = `URGENT: Less than ${highDays} days of stock`;
            } else if (daysUntilStockout < mediumDays) {
                priority = 'MEDIUM';
                reorder_reason = `Less than ${mediumDays} days of stock remaining`;
            } else if (daysUntilStockout < lowDays) {
                priority = 'LOW';
                reorder_reason = `Less than ${lowDays} days of stock remaining`;
            } else {
                priority = 'LOW';
                reorder_reason = 'Below minimum stock level';
            }

            const finalQty = calculateReorderQuantity({
                velocity: dailyAvg,
                supplyDays: supplyDaysNum,
                leadTimeDays: leadTime,
                safetyDays,
                casePack,
                reorderMultiple,
                stockAlertMin,
                stockAlertMax,
                currentStock: availableQty
            });

            if (finalQty <= 0) {
                return null;
            }

            const unitCost = parseInt(row.unit_cost_cents) || 0;
            const retailPrice = parseInt(row.retail_price_cents) || 0;
            const pendingPoQty = parseInt(row.pending_po_quantity) || 0;

            const grossMarginPercent = retailPrice > 0 && unitCost > 0
                ? Math.round(((retailPrice - unitCost) / retailPrice) * 1000) / 10
                : null;

            const adjustedQty = Math.max(0, finalQty - pendingPoQty);
            const orderCost = (adjustedQty * unitCost) / 100;

            // Always surface below-minimum items even when a pending PO covers the order
            // quantity. Stock is below threshold right now and the PO may not arrive for days.
            if (adjustedQty <= 0 && !row.below_minimum) {
                return null;
            }

            return {
                variation_id: row.variation_id,
                item_name: row.item_name,
                variation_name: row.variation_name,
                sku: row.sku,
                location_id: locationId,
                location_name: locationName,
                current_stock: currentStock,
                committed_quantity: committedQty,
                available_quantity: availableQty,
                daily_avg_quantity: dailyAvg,
                weekly_avg_quantity: parseFloat(row.weekly_avg_quantity) || 0,
                weekly_avg_91d: parseFloat(row.weekly_avg_91d) || 0,
                weekly_avg_182d: parseFloat(row.weekly_avg_182d) || 0,
                weekly_avg_365d: parseFloat(row.weekly_avg_365d) || 0,
                days_until_stockout: daysUntilStockout,
                below_minimum: row.below_minimum,
                stock_alert_min: stockAlertMin,
                stock_alert_max: stockAlertMax,
                priority: priority,
                reorder_reason: reorder_reason,
                base_suggested_qty: baseSuggestedQty,
                case_pack_quantity: casePack,
                case_pack_adjusted_qty: finalQty,
                pending_po_quantity: pendingPoQty,
                final_suggested_qty: adjustedQty,
                unit_cost_cents: unitCost,
                retail_price_cents: retailPrice,
                gross_margin_percent: grossMarginPercent,
                order_cost: orderCost,
                vendor_name: row.vendor_name,
                vendor_code: row.vendor_code || 'N/A',
                // LOGIC CHANGE: equal prices should not trigger cheaper-elsewhere highlight (reorder page bug fix)
                is_primary_vendor: row.current_vendor_id === row.primary_vendor_id
                    || (parseInt(row.unit_cost_cents) || 0) <= (parseInt(row.primary_vendor_cost) || 0),
                primary_vendor_name: row.primary_vendor_name,
                primary_vendor_cost: parseInt(row.primary_vendor_cost) || 0,
                lead_time_days: leadTime,
                vendor_default_supply_days: parseInt(row.default_supply_days) || null,
                has_velocity: dailyAvg > 0,
                images: row.images,
                item_images: row.item_images,
                expiration_date: row.expiration_date,
                does_not_expire: row.does_not_expire || false,
                days_until_expiry: row.days_until_expiry,
                variation_age_days: row.variation_age_days !== null ? parseInt(row.variation_age_days) : null
            };
        })
        .filter(item => item !== null);
}

function sortSuggestions(suggestions) {
    const priorityOrder = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    suggestions.sort((a, b) => {
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
            return priorityOrder[b.priority] - priorityOrder[a.priority];
        }
        if (a.days_until_stockout !== b.days_until_stockout) {
            return a.days_until_stockout - b.days_until_stockout;
        }
        return b.daily_avg_quantity - a.daily_avg_quantity;
    });
}

// ============================================================================
// BUNDLE ANALYSIS
// ============================================================================

async function runBundleAnalysis({ merchantId, vendor_id, location_id, supplyDaysNum, safetyDays }) {
    let bundleAnalysis = [];
    const bundleAffiliations = {};

    try {
        let bundleQuery = `
            SELECT
                bd.id as bundle_id, bd.bundle_variation_id, bd.bundle_item_id,
                bd.bundle_item_name, bd.bundle_variation_name, bd.bundle_sku,
                bd.bundle_cost_cents, bd.bundle_sell_price_cents,
                bd.vendor_id, bd.vendor_code as bundle_vendor_code,
                ve.name as vendor_name,
                bc.child_variation_id, bc.quantity_in_bundle,
                bc.child_item_name, bc.child_variation_name,
                bc.child_sku, bc.individual_cost_cents
            FROM bundle_definitions bd
            JOIN bundle_components bc ON bd.id = bc.bundle_id
            LEFT JOIN vendors ve ON bd.vendor_id = ve.id AND ve.merchant_id = $1
            WHERE bd.merchant_id = $1 AND bd.is_active = true
        `;
        const bundleParams = [merchantId];
        if (vendor_id === 'none') {
            bundleQuery += ` AND bd.vendor_id IS NULL`;
        } else if (vendor_id) {
            bundleParams.push(vendor_id);
            bundleQuery += ` AND bd.vendor_id = $${bundleParams.length}`;
        }
        bundleQuery += ` ORDER BY bd.id, bc.child_item_name`;

        const bundlesResult = await db.query(bundleQuery, bundleParams);

        if (bundlesResult.rows.length > 0) {
            const childVarIds = [...new Set(bundlesResult.rows.map(r => r.child_variation_id))];
            const bundleVarIds = [...new Set(bundlesResult.rows.map(r => r.bundle_variation_id))];
            const allBundleVarIds = [...new Set([...childVarIds, ...bundleVarIds])];

            let velocityQuery = `
                SELECT variation_id, daily_avg_quantity
                FROM sales_velocity
                WHERE variation_id = ANY($1) AND merchant_id = $2 AND period_days = 91
            `;
            const velocityParams = [allBundleVarIds, merchantId];
            if (location_id) {
                velocityQuery += ` AND location_id = $3`;
                velocityParams.push(location_id);
            }

            let invQuery = `
                SELECT catalog_object_id,
                    COALESCE(SUM(CASE WHEN state = 'IN_STOCK' THEN quantity ELSE 0 END), 0) as stock,
                    COALESCE(SUM(CASE WHEN state = 'RESERVED_FOR_SALE' THEN quantity ELSE 0 END), 0) as committed
                FROM inventory_counts
                WHERE catalog_object_id = ANY($1) AND merchant_id = $2
                    AND state IN ('IN_STOCK', 'RESERVED_FOR_SALE')
            `;
            const invParams = [allBundleVarIds, merchantId];
            if (location_id) {
                invQuery += ` AND location_id = $3`;
                invParams.push(location_id);
            }
            invQuery += ` GROUP BY catalog_object_id`;

            let minStockQuery = `
                SELECT v.id,
                    COALESCE(vls.stock_alert_min, v.stock_alert_min, 0) as stock_alert_min,
                    COALESCE(v.is_deleted, FALSE) as is_deleted,
                    vv.vendor_code
                FROM variations v
                LEFT JOIN variation_location_settings vls
                    ON v.id = vls.variation_id AND vls.merchant_id = $2
            `;
            const minStockParams = [childVarIds, merchantId];
            if (location_id) {
                minStockQuery += ` AND vls.location_id = $3`;
                minStockParams.push(location_id);
            }
            minStockQuery += `
                LEFT JOIN variation_vendors vv
                    ON v.id = vv.variation_id AND vv.merchant_id = $2
            `;
            minStockQuery += ` WHERE v.id = ANY($1) AND v.merchant_id = $2`;

            const [velResult, invResult, minResult] = await Promise.all([
                db.query(velocityQuery, velocityParams),
                db.query(invQuery, invParams),
                db.query(minStockQuery, minStockParams)
            ]);

            const velMap = new Map(velResult.rows.map(r => [r.variation_id, parseFloat(r.daily_avg_quantity) || 0]));
            const invMap = new Map(invResult.rows.map(r => [r.catalog_object_id, {
                stock: parseInt(r.stock) || 0,
                committed: parseInt(r.committed) || 0
            }]));
            const minMap = new Map(minResult.rows.map(r => [r.id, parseInt(r.stock_alert_min) || 0]));
            const deletedMap = new Map(minResult.rows.map(r => [r.id, r.is_deleted === true]));
            const vendorCodeMap = new Map(minResult.rows.map(r => [r.id, r.vendor_code || null]));

            // Group by bundle
            const bundleGroups = new Map();
            for (const row of bundlesResult.rows) {
                if (!bundleGroups.has(row.bundle_id)) {
                    bundleGroups.set(row.bundle_id, {
                        bundle_id: row.bundle_id,
                        bundle_variation_id: row.bundle_variation_id,
                        bundle_item_name: row.bundle_item_name,
                        bundle_variation_name: row.bundle_variation_name,
                        bundle_sku: row.bundle_sku,
                        bundle_cost_cents: row.bundle_cost_cents,
                        bundle_sell_price_cents: row.bundle_sell_price_cents,
                        vendor_id: row.vendor_id,
                        bundle_vendor_code: row.bundle_vendor_code,
                        vendor_name: row.vendor_name,
                        children: []
                    });
                }
                bundleGroups.get(row.bundle_id).children.push(row);

                if (!bundleAffiliations[row.child_variation_id]) {
                    bundleAffiliations[row.child_variation_id] = [];
                }
                bundleAffiliations[row.child_variation_id].push(row.bundle_item_name);
            }

            // Propagate bundle parent committed inventory to children
            const bundleCommittedMap = new Map();
            for (const [, bg] of bundleGroups) {
                const parentInv = invMap.get(bg.bundle_variation_id) || { stock: 0, committed: 0 };
                if (parentInv.committed > 0) {
                    for (const child of bg.children) {
                        const current = bundleCommittedMap.get(child.child_variation_id) || 0;
                        bundleCommittedMap.set(
                            child.child_variation_id,
                            current + (parentInv.committed * child.quantity_in_bundle)
                        );
                    }
                }
            }

            // For each bundle, calculate analysis
            for (const [, bundle] of bundleGroups) {
                const bundleVelocity = velMap.get(bundle.bundle_variation_id) || 0;

                const childrenWithNeeds = bundle.children.map(child => {
                    const childIndVelocity = velMap.get(child.child_variation_id) || 0;
                    const bundleDrivenDaily = bundleVelocity * child.quantity_in_bundle;
                    const totalDailyVelocity = childIndVelocity + bundleDrivenDaily;

                    const inv = invMap.get(child.child_variation_id) || { stock: 0, committed: 0 };
                    const onHand = inv.stock;
                    const individualCommitted = inv.committed;
                    const bundleCommittedForChild = bundleCommittedMap.get(child.child_variation_id) || 0;
                    const committedQty = individualCommitted + bundleCommittedForChild;
                    const stock = onHand - committedQty;
                    const minStock = minMap.get(child.child_variation_id) || 0;

                    const individualNeed = calculateReorderQuantity({
                        velocity: totalDailyVelocity,
                        supplyDays: supplyDaysNum,
                        safetyDays,
                        casePack: 1,
                        reorderMultiple: 1,
                        stockAlertMin: minStock,
                        stockAlertMax: null,
                        currentStock: stock
                    });

                    const availableForBundles = Math.max(0, stock - minStock);
                    const canAssemble = child.quantity_in_bundle > 0
                        ? Math.floor(availableForBundles / child.quantity_in_bundle)
                        : 0;

                    const daysOfStock = totalDailyVelocity > 0
                        ? Math.round((stock / totalDailyVelocity) * 10) / 10
                        : 999;

                    return {
                        variation_id: child.child_variation_id,
                        child_item_name: child.child_item_name,
                        child_variation_name: child.child_variation_name,
                        child_sku: child.child_sku,
                        quantity_in_bundle: child.quantity_in_bundle,
                        individual_cost_cents: child.individual_cost_cents || 0,
                        stock,
                        current_stock: onHand,
                        committed_quantity: committedQty,
                        available_quantity: stock,
                        stock_alert_min: minStock,
                        available_for_bundles: availableForBundles,
                        can_assemble: canAssemble,
                        individual_need: individualNeed,
                        individual_daily_velocity: childIndVelocity,
                        bundle_driven_daily_velocity: bundleDrivenDaily,
                        total_daily_velocity: totalDailyVelocity,
                        pct_from_bundles: totalDailyVelocity > 0
                            ? Math.round((bundleDrivenDaily / totalDailyVelocity) * 1000) / 10
                            : 0,
                        days_of_stock: daysOfStock,
                        is_deleted: deletedMap.get(child.child_variation_id) || false,
                        vendor_code: vendorCodeMap.get(child.child_variation_id) || null
                    };
                });

                const assemblableQty = childrenWithNeeds.length > 0
                    ? Math.min(...childrenWithNeeds.map(c => c.can_assemble))
                    : 0;
                const limitingChild = childrenWithNeeds.reduce((min, c) =>
                    c.can_assemble < min.can_assemble ? c : min, childrenWithNeeds[0]);
                const daysOfBundleStock = bundleVelocity > 0
                    ? Math.round((assemblableQty / bundleVelocity) * 10) / 10
                    : 999;

                const orderOptions = calculateOrderOptions(
                    { cost_cents: bundle.bundle_cost_cents, variation_id: bundle.bundle_variation_id },
                    childrenWithNeeds
                );

                bundleAnalysis.push({
                    bundle_id: bundle.bundle_id,
                    bundle_variation_id: bundle.bundle_variation_id,
                    bundle_item_name: bundle.bundle_item_name,
                    bundle_variation_name: bundle.bundle_variation_name,
                    bundle_sku: bundle.bundle_sku,
                    bundle_cost_cents: bundle.bundle_cost_cents,
                    bundle_sell_price_cents: bundle.bundle_sell_price_cents,
                    vendor_name: bundle.vendor_name,
                    vendor_id: bundle.vendor_id,
                    bundle_vendor_code: bundle.bundle_vendor_code,
                    assemblable_qty: assemblableQty,
                    limiting_component: limitingChild ? limitingChild.child_item_name : null,
                    days_of_bundle_stock: daysOfBundleStock,
                    bundle_daily_velocity: bundleVelocity,
                    children: childrenWithNeeds,
                    order_options: orderOptions
                });
            }
        }
    } catch (bundleErr) {
        logger.error('Bundle analysis failed', { error: bundleErr.message, merchantId });
    }

    return { bundleAnalysis, bundleAffiliations };
}

// ============================================================================
// OTHER VENDOR ITEMS
// ============================================================================

async function fetchOtherVendorItems({ merchantId, vendor_id, location_id, suggestedVarIds }) {
    try {
        let otherQuery = `
                SELECT
                    v.id as variation_id,
                    i.name as item_name,
                    v.name as variation_name,
                    v.sku,
                    COALESCE(ic.quantity, 0) as current_stock,
                    COALESCE(ic_committed.quantity, 0) as committed_quantity,
                    COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0) as available_quantity,
                    COALESCE(vls.stock_alert_min, v.stock_alert_min, 0) as stock_alert_min,
                    COALESCE(vls.stock_alert_max, v.stock_alert_max) as stock_alert_max,
                    sv91.weekly_avg_quantity as weekly_avg_91d,
                    CASE
                        WHEN sv91.daily_avg_quantity > 0
                             AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) > 0
                        THEN ROUND((COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0))
                             / sv91.daily_avg_quantity, 1)
                        WHEN (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0
                        THEN 0
                        ELSE 999
                    END as days_until_stockout,
                    vv.unit_cost_money as unit_cost_cents,
                    v.price_money as retail_price_cents,
                    CASE
                        WHEN v.price_money > 0 AND vv.unit_cost_money > 0
                        THEN ROUND(((v.price_money - vv.unit_cost_money)::NUMERIC / v.price_money) * 100, 1)
                        ELSE NULL
                    END as gross_margin_percent,
                    v.case_pack_quantity,
                    vv.vendor_code,
                    ve.name as vendor_name
                FROM variations v
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $1
                JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $1
                LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $1
                    AND ic.state = 'IN_STOCK'
                LEFT JOIN inventory_counts ic_committed ON v.id = ic_committed.catalog_object_id
                    AND ic_committed.merchant_id = $1
                    AND ic_committed.state = 'RESERVED_FOR_SALE'
                    AND ic_committed.location_id = ic.location_id
                LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91
                    AND sv91.merchant_id = $1
                    AND (sv91.location_id = ic.location_id
                         OR (sv91.location_id IS NULL AND ic.location_id IS NULL))
                LEFT JOIN variation_location_settings vls ON v.id = vls.variation_id
                    AND vls.merchant_id = $1
                    AND ic.location_id = vls.location_id
                WHERE v.merchant_id = $1
                  AND vv.vendor_id = $2
                  AND v.discontinued = FALSE
                  AND COALESCE(v.is_deleted, FALSE) = FALSE
                  AND COALESCE(i.is_deleted, FALSE) = FALSE
            `;
        const otherParams = [merchantId, vendor_id];

        if (suggestedVarIds.length > 0) {
            otherParams.push(suggestedVarIds);
            otherQuery += ` AND v.id != ALL($${otherParams.length})`;
        }

        if (location_id) {
            otherParams.push(location_id);
            otherQuery += ` AND (ic.location_id = $${otherParams.length} OR ic.location_id IS NULL)`;
        }

        otherQuery += ` ORDER BY i.name, v.name`;

        const otherResult = await db.query(otherQuery, otherParams);
        return otherResult.rows.map(row => ({
            variation_id: row.variation_id,
            item_name: row.item_name,
            variation_name: row.variation_name,
            sku: row.sku,
            current_stock: parseInt(row.current_stock) || 0,
            committed_quantity: parseInt(row.committed_quantity) || 0,
            available_quantity: parseInt(row.available_quantity) || 0,
            stock_alert_min: parseInt(row.stock_alert_min) || 0,
            stock_alert_max: row.stock_alert_max != null ? parseInt(row.stock_alert_max) : null,
            days_until_stockout: parseFloat(row.days_until_stockout) || 999,
            weekly_avg_91d: parseFloat(row.weekly_avg_91d) || 0,
            unit_cost_cents: parseInt(row.unit_cost_cents) || 0,
            retail_price_cents: parseInt(row.retail_price_cents) || 0,
            gross_margin_percent: row.gross_margin_percent != null
                ? parseFloat(row.gross_margin_percent) : null,
            case_pack_quantity: parseInt(row.case_pack_quantity) || 1,
            vendor_code: row.vendor_code || 'N/A',
            vendor_name: row.vendor_name
        }));
    } catch (otherErr) {
        logger.error('Other vendor items query failed', {
            error: otherErr.message, merchantId
        });
        return [];
    }
}

module.exports = {
    getReorderSuggestions,
    // Exported for unit testing
    buildMainQuery,
    processSuggestionRows,
    sortSuggestions,
    runBundleAnalysis,
    fetchOtherVendorItems
};
