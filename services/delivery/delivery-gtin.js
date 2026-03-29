/**
 * Delivery GTIN Enrichment Service
 * Enriches delivery order line items with GTIN/UPC data from catalog.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

/**
 * Look up GTINs (UPCs) for line items from our catalog at INGEST time
 * Uses catalogObjectId (variation ID) from Square order data
 * @param {number} merchantId - The merchant ID
 * @param {Array} lineItems - Square order line items (with catalogObjectId)
 * @returns {Promise<Array>} Line items enriched with GTIN
 */
async function enrichLineItemsWithGtin(merchantId, lineItems) {
    if (!lineItems || lineItems.length === 0) {
        return [];
    }

    // Extract variation IDs from line items (catalogObjectId is the variation ID)
    const variationIds = lineItems
        .map(item => item.catalogObjectId || item.catalog_object_id)
        .filter(Boolean);

    // Batch lookup UPCs from our variations table
    let upcMap = new Map();
    if (variationIds.length > 0) {
        try {
            const result = await db.query(
                `SELECT id, upc FROM variations WHERE merchant_id = $1 AND id = ANY($2)`,
                [merchantId, variationIds]
            );
            result.rows.forEach(row => {
                if (row.upc) {
                    upcMap.set(row.id, row.upc);
                }
            });
        } catch (err) {
            logger.warn('Failed to lookup GTINs for line items', { merchantId, error: err.message });
        }
    }

    // Map line items with GTIN
    return lineItems.map(item => {
        const variationId = item.catalogObjectId || item.catalog_object_id;
        return {
            name: item.name,
            quantity: item.quantity,
            variationName: item.variationName || item.variation_name,
            note: item.note,
            gtin: variationId ? upcMap.get(variationId) || null : null,
            modifiers: (item.modifiers || []).map(m => ({
                name: m.name,
                quantity: m.quantity
            }))
        };
    });
}

/**
 * Enrich orders with GTIN data at READ time
 * Uses variation name matching for orders that don't have catalogObjectId stored
 * @param {number} merchantId - The merchant ID
 * @param {Array} orders - Array of delivery orders
 * @returns {Promise<Array>} Orders with lineItems enriched with GTIN
 */
async function enrichOrdersWithGtin(merchantId, orders) {
    if (!orders || orders.length === 0) {
        return orders;
    }

    // Collect all unique variation names from all orders
    const variationNames = new Set();
    for (const order of orders) {
        const lineItems = order.square_order_data?.lineItems || [];
        for (const item of lineItems) {
            // Skip if already has GTIN
            if (item.gtin) continue;
            // Use variation name for lookup
            if (item.variationName) {
                variationNames.add(item.variationName);
            }
        }
    }

    // If no variation names to look up, return orders unchanged
    if (variationNames.size === 0) {
        logger.info('GTIN enrichment: No variation names found in orders', { merchantId, orderCount: orders.length });
        return orders;
    }

    const variationNameList = Array.from(variationNames);
    logger.info('GTIN enrichment: Looking up UPCs', {
        merchantId,
        variationNames: variationNameList.slice(0, 10), // Log first 10 for debugging
        totalNames: variationNameList.length
    });

    // Batch lookup UPCs by variation name
    let upcMap = new Map();
    try {
        const result = await db.query(
            `SELECT name, upc FROM variations WHERE merchant_id = $1 AND name = ANY($2) AND upc IS NOT NULL`,
            [merchantId, variationNameList]
        );
        result.rows.forEach(row => {
            if (row.upc) {
                upcMap.set(row.name, row.upc);
            }
        });
        logger.info('GTIN enrichment: Lookup complete', {
            merchantId,
            requested: variationNameList.length,
            found: upcMap.size,
            foundNames: Array.from(upcMap.keys()).slice(0, 10)
        });

        // If no UPCs found, check if the variations exist at all (without UPC filter)
        if (upcMap.size === 0) {
            const checkResult = await db.query(
                `SELECT name, upc FROM variations WHERE merchant_id = $1 AND name = ANY($2) LIMIT 5`,
                [merchantId, variationNameList]
            );
            if (checkResult.rows.length > 0) {
                logger.info('GTIN enrichment: Variations found but no UPCs set', {
                    merchantId,
                    sampleVariations: checkResult.rows.map(r => ({ name: r.name, hasUpc: !!r.upc }))
                });
            } else {
                logger.info('GTIN enrichment: No matching variations found in database', {
                    merchantId,
                    searchedNames: variationNameList.slice(0, 5)
                });
            }
        }
    } catch (err) {
        logger.warn('Failed to lookup GTINs for orders', { merchantId, error: err.message });
        return orders;
    }

    // Enrich orders with GTIN - be defensive to avoid breaking data
    return orders.map(order => {
        try {
            if (!order.square_order_data || !Array.isArray(order.square_order_data.lineItems)) {
                return order;
            }

            const enrichedLineItems = order.square_order_data.lineItems.map(item => ({
                ...item,
                gtin: item.gtin || (item.variationName ? upcMap.get(item.variationName) : null) || null
            }));

            return {
                ...order,
                square_order_data: {
                    ...order.square_order_data,
                    lineItems: enrichedLineItems
                }
            };
        } catch (err) {
            logger.warn('Failed to enrich order with GTIN', { orderId: order.id, error: err.message });
            return order;
        }
    });
}

module.exports = {
    enrichLineItemsWithGtin,
    enrichOrdersWithGtin
};
