/**
 * Analytics Routes
 *
 * Handles sales velocity and reorder suggestions:
 * - Sales velocity data retrieval
 * - Reorder suggestions based on sales velocity and inventory levels
 *
 * Endpoints:
 * - GET /api/sales-velocity       - Get sales velocity data
 * - GET /api/reorder-suggestions  - Calculate reorder suggestions
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/analytics');
const { batchResolveImageUrls } = require('../utils/image-utils');
const { calculateOrderOptions } = require('../services/bundle-calculator');

// ==================== SALES VELOCITY ENDPOINTS ====================

/**
 * GET /api/sales-velocity
 * Get sales velocity data
 */
router.get('/sales-velocity', requireAuth, requireMerchant, validators.getVelocity, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
        const { variation_id, location_id, period_days } = req.query;

        // Input validation for period_days
        if (period_days !== undefined) {
            const periodDaysNum = parseInt(period_days);
            const validPeriods = [91, 182, 365];
            if (isNaN(periodDaysNum) || !validPeriods.includes(periodDaysNum)) {
                return res.status(400).json({
                    error: 'Invalid period_days parameter',
                    message: 'period_days must be one of: 91, 182, or 365'
                });
            }
        }

        let query = `
            SELECT
                sv.*,
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                i.category_name,
                l.name as location_name
            FROM sales_velocity sv
            JOIN variations v ON sv.variation_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            JOIN locations l ON sv.location_id = l.id AND l.merchant_id = $1
            WHERE sv.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
        `;
        const params = [merchantId];

        if (variation_id) {
            params.push(variation_id);
            query += ` AND sv.variation_id = $${params.length}`;
        }

        if (location_id) {
            params.push(location_id);
            query += ` AND sv.location_id = $${params.length}`;
        }

        if (period_days) {
            params.push(parseInt(period_days));
            query += ` AND sv.period_days = $${params.length}`;
        }

        query += ' ORDER BY sv.daily_avg_quantity DESC';

    const result = await db.query(query, params);
    res.json({
        count: result.rows.length,
        sales_velocity: result.rows
    });
}));

// ==================== REORDER SUGGESTIONS ====================

/**
 * GET /api/reorder-suggestions
 * Calculate reorder suggestions based on sales velocity
 */
router.get('/reorder-suggestions', requireAuth, requireMerchant, validators.getReorderSuggestions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
        const {
            vendor_id,
            supply_days,
            location_id,
            min_cost
        } = req.query;

        // Load merchant settings for reorder calculations
        const merchantSettings = await db.getMerchantSettings(merchantId);

        // Use supply_days from query, or fall back to merchant setting, or env default
        const defaultSupplyDays = merchantSettings.default_supply_days ||
            parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45');
        const supplyDaysParam = supply_days || defaultSupplyDays;

        // Use merchant settings for safety days, fall back to env var
        const safetyDays = merchantSettings.reorder_safety_days ??
            parseInt(process.env.REORDER_SAFETY_DAYS || '7');

        // Debug logging for reorder issues
        logger.info('Reorder suggestions request', {
            merchantId,
            merchantName: req.merchantContext.businessName,
            vendor_id,
            supply_days: supplyDaysParam,
            safety_days: safetyDays,
            reorder_threshold: parseInt(supplyDaysParam) + safetyDays,
            location_id,
            usingMerchantSettings: true
        });

        // Input validation
        const supplyDaysNum = parseInt(supplyDaysParam);
        if (isNaN(supplyDaysNum) || supplyDaysNum < 1 || supplyDaysNum > 365) {
            return res.status(400).json({
                error: 'Invalid supply_days parameter',
                message: 'supply_days must be a number between 1 and 365'
            });
        }

        if (min_cost !== undefined) {
            const minCostNum = parseFloat(min_cost);
            if (isNaN(minCostNum) || minCostNum < 0) {
                return res.status(400).json({
                    error: 'Invalid min_cost parameter',
                    message: 'min_cost must be a positive number'
                });
            }
        }

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
                sv91.daily_avg_quantity,
                sv91.weekly_avg_quantity,
                sv91.weekly_avg_quantity as weekly_avg_91d,
                sv182.weekly_avg_quantity as weekly_avg_182d,
                sv365.weekly_avg_quantity as weekly_avg_365d,
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
                -- Get primary vendor (lowest cost, then earliest created)
                (SELECT vv2.vendor_id
                 FROM variation_vendors vv2
                 WHERE vv2.variation_id = v.id AND vv2.merchant_id = $2
                 ORDER BY vv2.unit_cost_money ASC, vv2.created_at ASC
                 LIMIT 1
                ) as primary_vendor_id,
                -- Get primary vendor name for comparison
                (SELECT ve2.name
                 FROM variation_vendors vv3
                 JOIN vendors ve2 ON vv3.vendor_id = ve2.id AND ve2.merchant_id = $2
                 WHERE vv3.variation_id = v.id AND vv3.merchant_id = $2
                 ORDER BY vv3.unit_cost_money ASC, vv3.created_at ASC
                 LIMIT 1
                ) as primary_vendor_name,
                -- Get primary vendor cost for comparison
                (SELECT vv4.unit_cost_money
                 FROM variation_vendors vv4
                 WHERE vv4.variation_id = v.id AND vv4.merchant_id = $2
                 ORDER BY vv4.unit_cost_money ASC, vv4.created_at ASC
                 LIMIT 1
                ) as primary_vendor_cost,
                -- Get pending quantity from unreceived purchase orders
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
                -- Calculate days until stockout based on AVAILABLE quantity (not total on-hand)
                CASE
                    WHEN sv91.daily_avg_quantity > 0 AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) > 0
                    THEN ROUND((COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv91.daily_avg_quantity, 1)
                    WHEN (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0
                    THEN 0
                    ELSE 999
                END as days_until_stockout,
                -- Base suggested quantity (supply_days worth of inventory)
                ROUND(COALESCE(sv91.daily_avg_quantity, 0) * $1, 2) as base_suggested_qty,
                -- Whether currently at or below minimum stock based on AVAILABLE quantity
                CASE
                    WHEN COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                         AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= COALESCE(vls.stock_alert_min, v.stock_alert_min)
                    THEN TRUE
                    ELSE FALSE
                END as below_minimum
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
            LEFT JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $2
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $2
                AND ic.state = 'IN_STOCK'
            LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91 AND sv91.merchant_id = $2
                AND (sv91.location_id = ic.location_id OR (sv91.location_id IS NULL AND ic.location_id IS NULL))
            LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $2
                AND (sv182.location_id = ic.location_id OR (sv182.location_id IS NULL AND ic.location_id IS NULL))
            LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $2
                AND (sv365.location_id = ic.location_id OR (sv365.location_id IS NULL AND ic.location_id IS NULL))
            LEFT JOIN inventory_counts ic_committed ON v.id = ic_committed.catalog_object_id AND ic_committed.merchant_id = $2
                AND ic_committed.state = 'RESERVED_FOR_SALE'
                AND ic_committed.location_id = ic.location_id
            LEFT JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $2
            LEFT JOIN variation_location_settings vls ON v.id = vls.variation_id AND vls.merchant_id = $2
                AND ic.location_id = vls.location_id
            LEFT JOIN variation_expiration vexp ON v.id = vexp.variation_id AND vexp.merchant_id = $2
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

                  -- APPLY SUPPLY_DAYS + SAFETY_DAYS: Items with available stock that will run out within threshold period
                  -- Only applies to items with active sales velocity (sv91.daily_avg_quantity > 0)
                  -- $1 is (supply_days + safety_days) to include safety buffer
                  (sv91.daily_avg_quantity > 0
                      AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv91.daily_avg_quantity < $1)
              )
        `;

        // Combine supply days and safety days for the reorder threshold
        const reorderThreshold = supplyDaysNum + safetyDays;
        const params = [reorderThreshold, merchantId];

        if (vendor_id === 'none') {
            // Filter for items with NO vendor assigned
            query += ` AND vv.vendor_id IS NULL`;
        } else if (vendor_id) {
            params.push(vendor_id);
            query += ` AND vv.vendor_id = $${params.length}`;
        }

        if (location_id) {
            params.push(location_id);
            query += ` AND (ic.location_id = $${params.length} OR ic.location_id IS NULL)`;
            // Sales velocity location is now constrained via JOINs to match ic.location_id
        }

        const result = await db.query(query, params);

        // Debug: log query results
        logger.info('Reorder query results', {
            merchantId,
            rowCount: result.rows.length,
            params: params.slice(0, 3) // First 3 params for debugging
        });

        // Get priority thresholds from merchant settings, fall back to env vars
        const urgentDays = merchantSettings.reorder_priority_urgent_days ??
            parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0');
        const highDays = merchantSettings.reorder_priority_high_days ??
            parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7');
        const mediumDays = merchantSettings.reorder_priority_medium_days ??
            parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14');
        const lowDays = merchantSettings.reorder_priority_low_days ??
            parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30');

        // Process suggestions with case pack and reorder multiple logic
        const suggestions = result.rows
            .map(row => {
                const currentStock = parseFloat(row.current_stock) || 0;
                const committedQty = parseInt(row.committed_quantity) || 0;
                const availableQty = currentStock - committedQty;  // Use available for calculations
                const dailyAvg = parseFloat(row.daily_avg_quantity) || 0;
                // Round up base suggested quantity to whole number
                const baseSuggestedQty = Math.ceil(parseFloat(row.base_suggested_qty) || 0);
                const casePack = parseInt(row.case_pack_quantity) || 1;
                const reorderMultiple = parseInt(row.reorder_multiple) || 1;
                const stockAlertMin = parseInt(row.stock_alert_min) || 0;  // Now includes location-specific via COALESCE
                const stockAlertMax = row.stock_alert_max ? parseInt(row.stock_alert_max) : null;  // Keep null as null for infinity
                const locationId = row.location_id || null;
                const locationName = row.location_name || null;
                const leadTime = parseInt(row.lead_time_days) || 7;
                const daysUntilStockout = parseFloat(row.days_until_stockout) || 999;

                // Don't suggest if AVAILABLE already above max (null = unlimited, so skip this check)
                if (stockAlertMax !== null && availableQty >= stockAlertMax) {
                    return null;
                }

                // FILTERING LOGIC (must match SQL WHERE clause):
                // 1. ALWAYS include out-of-available-stock items (available <= 0), regardless of supply_days
                // 2. ALWAYS include items below alert threshold based on available, regardless of supply_days
                // 3. Include items that will stockout within supply_days + safety_days period (only if has velocity)
                const isOutOfStock = availableQty <= 0;
                const reorderThreshold = supplyDaysNum + safetyDays; // Include safety buffer
                const needsReorder = isOutOfStock || row.below_minimum || daysUntilStockout < reorderThreshold;
                if (!needsReorder) {
                    return null;
                }

                // Calculate priority and reorder reason
                let priority;
                let reorder_reason;

                // Handle out-of-stock items specially
                if (currentStock <= urgentDays) {
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

                // Calculate quantity needed to reach (supply_days + safety_days) worth of stock
                // Safety days adds buffer inventory to protect against demand variability
                let targetQty;

                // For items with no sales velocity, use minimum reorder quantities
                if (dailyAvg <= 0 || baseSuggestedQty <= 0) {
                    // No sales data - suggest minimum reorder based on case pack or reorder multiple
                    if (casePack > 1) {
                        targetQty = casePack; // Order at least 1 case
                    } else if (reorderMultiple > 1) {
                        targetQty = reorderMultiple;
                    } else {
                        targetQty = 1; // Default minimum order of 1 unit
                    }
                } else {
                    // baseSuggestedQty already includes safety days (from SQL: daily_avg * reorderThreshold)
                    // where reorderThreshold = supply_days + safety_days
                    targetQty = baseSuggestedQty;
                }

                // When stock_alert_min > 0, ensure we order enough to exceed it
                if (stockAlertMin && stockAlertMin > 0) {
                    targetQty = Math.max(stockAlertMin + 1, targetQty);
                }

                // Calculate suggested quantity based on AVAILABLE stock (round up to ensure minimum of 1)
                let suggestedQty = Math.ceil(Math.max(0, targetQty - availableQty));

                // Round up to case pack
                if (casePack > 1) {
                    suggestedQty = Math.ceil(suggestedQty / casePack) * casePack;
                }

                // Apply reorder multiple
                if (reorderMultiple > 1) {
                    suggestedQty = Math.ceil(suggestedQty / reorderMultiple) * reorderMultiple;
                }

                // Don't exceed max stock level based on AVAILABLE (round up final quantity)
                // If stockAlertMax is null (unlimited), don't cap the quantity
                const finalQty = stockAlertMax !== null
                    ? Math.ceil(Math.min(suggestedQty, stockAlertMax - availableQty))
                    : Math.ceil(suggestedQty);

                if (finalQty <= 0) {
                    return null;
                }

                const unitCost = parseInt(row.unit_cost_cents) || 0;
                const retailPrice = parseInt(row.retail_price_cents) || 0;
                const pendingPoQty = parseInt(row.pending_po_quantity) || 0;

                // Calculate gross margin percentage: ((retail - cost) / retail) * 100
                const grossMarginPercent = retailPrice > 0 && unitCost > 0
                    ? Math.round(((retailPrice - unitCost) / retailPrice) * 1000) / 10  // 1 decimal place
                    : null;

                // Subtract pending PO quantity from suggested order
                const adjustedQty = Math.max(0, finalQty - pendingPoQty);
                const orderCost = (adjustedQty * unitCost) / 100;

                // Skip if nothing to order after accounting for pending POs
                if (adjustedQty <= 0) {
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
                    stock_alert_min: stockAlertMin,  // Includes location-specific via COALESCE
                    stock_alert_max: stockAlertMax,  // Includes location-specific via COALESCE
                    priority: priority,
                    reorder_reason: reorder_reason,
                    base_suggested_qty: baseSuggestedQty,
                    case_pack_quantity: casePack,
                    case_pack_adjusted_qty: suggestedQty,
                    pending_po_quantity: pendingPoQty,
                    final_suggested_qty: adjustedQty,
                    unit_cost_cents: unitCost,
                    retail_price_cents: retailPrice,
                    gross_margin_percent: grossMarginPercent,
                    order_cost: orderCost,
                    vendor_name: row.vendor_name,
                    vendor_code: row.vendor_code || 'N/A',
                    is_primary_vendor: row.current_vendor_id === row.primary_vendor_id,
                    primary_vendor_name: row.primary_vendor_name,
                    primary_vendor_cost: parseInt(row.primary_vendor_cost) || 0,
                    lead_time_days: leadTime,
                    has_velocity: dailyAvg > 0,
                    images: row.images,  // Include images for URL resolution
                    item_images: row.item_images,  // Include item images for fallback
                    // Expiration data
                    expiration_date: row.expiration_date,
                    does_not_expire: row.does_not_expire || false,
                    days_until_expiry: row.days_until_expiry
                };
            })
            .filter(item => item !== null);

        // Apply minimum cost filter if specified
        let filteredSuggestions = suggestions;
        if (min_cost) {
            const minCostNum = parseFloat(min_cost);
            filteredSuggestions = suggestions.filter(s => s.order_cost >= minCostNum);
        }

        // Sort: by priority first (URGENT > HIGH > MEDIUM > LOW),
        // then by days until stockout,
        // then by daily_avg_quantity (items with sales first)
        const priorityOrder = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
        filteredSuggestions.sort((a, b) => {
            // First: Sort by priority
            if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
                return priorityOrder[b.priority] - priorityOrder[a.priority];
            }
            // Second: Sort by days until stockout
            if (a.days_until_stockout !== b.days_until_stockout) {
                return a.days_until_stockout - b.days_until_stockout;
            }
            // Third: Items with sales velocity come before items without sales
            return b.daily_avg_quantity - a.daily_avg_quantity;
        });

        // Resolve image URLs in a SINGLE batch query (much faster than N individual queries)
        const imageUrlMap = await batchResolveImageUrls(filteredSuggestions);
        const suggestionsWithImages = filteredSuggestions.map((suggestion, index) => ({
            ...suggestion,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,  // Remove raw image IDs from response
            item_images: undefined  // Remove from response
        }));

    // ==================== BUNDLE ANALYSIS ====================
    // Query active bundles for this merchant and build bundle analysis
    let bundleAnalysis = [];
    const bundleAffiliations = {};

    try {
        const bundlesResult = await db.query(`
            SELECT
                bd.id as bundle_id, bd.bundle_variation_id, bd.bundle_item_id,
                bd.bundle_item_name, bd.bundle_variation_name, bd.bundle_sku,
                bd.bundle_cost_cents, bd.bundle_sell_price_cents,
                bd.vendor_id,
                ve.name as vendor_name,
                bc.child_variation_id, bc.quantity_in_bundle,
                bc.child_item_name, bc.child_variation_name,
                bc.child_sku, bc.individual_cost_cents
            FROM bundle_definitions bd
            JOIN bundle_components bc ON bd.id = bc.bundle_id
            LEFT JOIN vendors ve ON bd.vendor_id = ve.id AND ve.merchant_id = $1
            WHERE bd.merchant_id = $1 AND bd.is_active = true
            ORDER BY bd.id, bc.child_item_name
        `, [merchantId]);

        if (bundlesResult.rows.length > 0) {
            // Collect variation IDs for velocity + inventory lookups
            const childVarIds = [...new Set(bundlesResult.rows.map(r => r.child_variation_id))];
            const bundleVarIds = [...new Set(bundlesResult.rows.map(r => r.bundle_variation_id))];
            const allBundleVarIds = [...new Set([...childVarIds, ...bundleVarIds])];

            // Fetch bundle velocity (bundle parent sales from sales_velocity)
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

            // Fetch inventory for bundle children
            let invQuery = `
                SELECT catalog_object_id, COALESCE(SUM(quantity), 0) as stock
                FROM inventory_counts
                WHERE catalog_object_id = ANY($1) AND merchant_id = $2 AND state = 'IN_STOCK'
            `;
            const invParams = [childVarIds, merchantId];
            if (location_id) {
                invQuery += ` AND location_id = $3`;
                invParams.push(location_id);
            }
            invQuery += ` GROUP BY catalog_object_id`;

            // Fetch stock_alert_min (with location override), is_deleted, and vendor_code for children
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
            const invMap = new Map(invResult.rows.map(r => [r.catalog_object_id, parseInt(r.stock) || 0]));
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
                        vendor_name: row.vendor_name,
                        children: []
                    });
                }
                bundleGroups.get(row.bundle_id).children.push(row);

                // Build affiliations map
                if (!bundleAffiliations[row.child_variation_id]) {
                    bundleAffiliations[row.child_variation_id] = [];
                }
                bundleAffiliations[row.child_variation_id].push(row.bundle_item_name);
            }

            // For each bundle, calculate analysis
            for (const [, bundle] of bundleGroups) {
                const bundleVelocity = velMap.get(bundle.bundle_variation_id) || 0;

                // Calculate corrected velocity and individual need for each child
                const childrenWithNeeds = bundle.children.map(child => {
                    const childIndVelocity = velMap.get(child.child_variation_id) || 0;
                    const bundleDrivenDaily = bundleVelocity * child.quantity_in_bundle;
                    const totalDailyVelocity = childIndVelocity + bundleDrivenDaily;

                    const stock = invMap.get(child.child_variation_id) || 0;
                    const minStock = minMap.get(child.child_variation_id) || 0;

                    // Individual need: target stock for supply_days using TOTAL velocity
                    const targetStock = (totalDailyVelocity * supplyDaysNum) + minStock;
                    const individualNeed = Math.max(0, Math.ceil(targetStock - stock));

                    // Assemblable from this child
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

                // Calculate assemblable qty (bottleneck)
                const assemblableQty = childrenWithNeeds.length > 0
                    ? Math.min(...childrenWithNeeds.map(c => c.can_assemble))
                    : 0;
                const limitingChild = childrenWithNeeds.reduce((min, c) =>
                    c.can_assemble < min.can_assemble ? c : min, childrenWithNeeds[0]);
                const daysOfBundleStock = bundleVelocity > 0
                    ? Math.round((assemblableQty / bundleVelocity) * 10) / 10
                    : 999;

                // Run the bundle calculator optimizer
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
        // Bundle analysis is additive - don't fail the whole request
        logger.error('Bundle analysis failed', { error: bundleErr.message, merchantId });
    }

    res.json({
        count: suggestionsWithImages.length,
        supply_days: supplyDaysNum,
        safety_days: safetyDays,
        suggestions: suggestionsWithImages,
        bundle_analysis: bundleAnalysis,
        bundle_affiliations: bundleAffiliations
    });
}));

module.exports = router;
