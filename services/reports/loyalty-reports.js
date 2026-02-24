/**
 * Loyalty Reports Service
 *
 * Generates vendor receipts and audit exports for loyalty program redemptions.
 * This is a FIRST-CLASS FEATURE for vendor reimbursement compliance.
 *
 * This service was extracted from utils/loyalty-reports.js as part of P1-3.
 *
 * Report Types:
 * - Vendor Receipt: Human-readable transaction report per redemption
 * - Audit Export: Detailed transaction history with all contributing purchases
 *
 * Output Formats:
 * - HTML: Printable vendor receipts (can be converted to PDF)
 * - CSV: Machine-readable audit exports
 *
 * Multi-tenant: All operations require merchantId for isolation.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { formatMoney, escapeCSVField, UTF8_BOM } = require('../../utils/csv-helpers');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const {
    formatPrivacyName,
    formatPrivacyPhone,
    formatPrivacyEmail,
    formatReportDate,
    formatCents,
    escapeHtml
} = require('../../utils/privacy-format');

// ============================================================================
// MERCHANT INFO HELPERS
// ============================================================================

/**
 * Fetch fresh merchant and location info from Square APIs
 * Square is the source of truth for all merchant/location data
 *
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} Merchant info from Square
 */
async function fetchMerchantInfoFromSquare(merchantId) {
    try {
        const squareClient = await getSquareClientForMerchant(merchantId);

        // Get merchant info (business name)
        const merchantResponse = await squareClient.merchants.get({
            merchantId: 'me'  // 'me' returns the merchant associated with the token
        });
        const merchantInfo = merchantResponse.merchant || {};

        // Get locations (for contact info)
        const locationsResponse = await squareClient.locations.list();
        const locations = locationsResponse.locations || [];

        // Find main location or first active location
        const mainLocation = locations.find(loc =>
            loc.id === merchantInfo.mainLocationId && loc.status === 'ACTIVE'
        ) || locations.find(loc => loc.status === 'ACTIVE') || locations[0];

        return {
            businessName: merchantInfo.businessName || null,
            squareMerchantId: merchantInfo.id || null,
            mainLocationId: merchantInfo.mainLocationId || null,
            // Location-specific details
            location: mainLocation ? {
                id: mainLocation.id,
                name: mainLocation.name,
                businessEmail: mainLocation.businessEmail || null,
                phoneNumber: mainLocation.phoneNumber || null,
                address: mainLocation.address || null
            } : null
        };
    } catch (error) {
        logger.warn('Failed to fetch merchant info from Square, using DB fallback', {
            merchantId,
            error: error.message
        });
        return null;
    }
}

// ============================================================================
// REPORT DATA QUERIES
// ============================================================================

/**
 * Get complete redemption details for vendor receipt
 * Migrated from loyalty_redemptions to loyalty_rewards WHERE status = 'redeemed'
 *
 * @param {string} rewardId - Reward UUID (previously redemptionId)
 * @param {number} merchantId - Merchant ID for tenant isolation
 * @returns {Promise<Object>} Complete redemption data
 */
async function getRedemptionDetails(rewardId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Get redemption from loyalty_rewards with offer details (including vendor info)
    // Migrated from loyalty_redemptions table
    // Includes customer info from loyalty_customers cache for privacy-masked display
    const redemptionResult = await db.query(`
        SELECT
            r.id,
            r.merchant_id,
            r.offer_id,
            r.square_customer_id,
            r.redeemed_at,
            r.redemption_order_id as square_order_id,
            r.current_quantity,
            r.required_quantity,
            r.window_start_date,
            r.window_end_date,
            r.earned_at,
            -- Vendor credit tracking
            r.vendor_credit_status,
            r.vendor_credit_submitted_at,
            r.vendor_credit_resolved_at,
            r.vendor_credit_notes,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.window_months,
            o.vendor_id,
            o.vendor_name,
            o.vendor_email,
            m.business_name,
            m.business_email,
            -- Customer info from cache (for privacy-masked display)
            lc.given_name,
            lc.family_name,
            lc.phone_number,
            lc.email_address,
            -- Redeemed item: prefer redemption record, fall back to purchase events
            COALESCE(lr.redeemed_item_name, pe_info.item_name) as redeemed_item_name,
            COALESCE(lr.redeemed_variation_name, pe_info.variation_name) as redeemed_variation_name,
            COALESCE(lr.redeemed_variation_id, pe_info.variation_id) as redeemed_variation_id,
            COALESCE(lr.redeemed_value_cents, pe_info.avg_price) as redeemed_value_cents
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        JOIN merchants m ON r.merchant_id = m.id
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        LEFT JOIN loyalty_redemptions lr
            ON r.redemption_id = lr.id
        LEFT JOIN LATERAL (
            SELECT
                lqv.item_name,
                lqv.variation_name,
                pe.variation_id,
                AVG(pe.unit_price_cents) FILTER (WHERE pe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events pe
            LEFT JOIN loyalty_qualifying_variations lqv
                ON pe.variation_id = lqv.variation_id AND pe.offer_id = lqv.offer_id
            WHERE pe.reward_id = r.id
            GROUP BY lqv.item_name, lqv.variation_name, pe.variation_id
            LIMIT 1
        ) pe_info ON true
        WHERE r.id = $1 AND r.merchant_id = $2 AND r.status = 'redeemed'
    `, [rewardId, merchantId]);

    if (redemptionResult.rows.length === 0) {
        return null;
    }

    const redemption = redemptionResult.rows[0];

    // Get all contributing purchase events for this reward (with cost and vendor item info)
    const purchasesResult = await db.query(`
        SELECT
            pe.*,
            qv.item_name,
            qv.variation_name,
            qv.sku,
            v.last_cost_cents as wholesale_cost_cents,
            COALESCE(vv.vendor_code, v.supplier_item_number) as vendor_item_number,
            vv.unit_cost_money as vendor_unit_cost
        FROM loyalty_purchase_events pe
        LEFT JOIN loyalty_qualifying_variations qv
            ON pe.variation_id = qv.variation_id AND qv.merchant_id = pe.merchant_id
        LEFT JOIN variations v
            ON pe.variation_id = v.id
        LEFT JOIN variation_vendors vv
            ON pe.variation_id = vv.variation_id
        WHERE pe.reward_id = $1 AND pe.merchant_id = $2
        ORDER BY pe.purchased_at ASC
    `, [rewardId, merchantId]);

    // Calculate lowest price for vendor credit amount (per BCR policy)
    const lowestPriceResult = await db.query(`
        SELECT MIN(unit_price_cents) as lowest_price_cents
        FROM loyalty_purchase_events
        WHERE reward_id = $1 AND merchant_id = $2 AND quantity > 0
    `, [rewardId, merchantId]);
    const lowestPriceCents = lowestPriceResult.rows[0]?.lowest_price_cents || 0;

    // Fetch ALL unique orders to get full line items and payment types
    // This provides complete order context for vendor receipts
    const purchases = purchasesResult.rows;
    const uniqueOrderIds = [...new Set(
        purchases
            .filter(p => p.square_order_id)
            .map(p => p.square_order_id)
    )];

    const fullOrders = {};
    if (uniqueOrderIds.length > 0) {
        try {
            const squareClient = await getSquareClientForMerchant(merchantId);

            // Fetch each order to get full line items and tender info
            for (const orderId of uniqueOrderIds) {
                try {
                    const orderResponse = await squareClient.orders.get({ orderId });
                    if (orderResponse.order) {
                        fullOrders[orderId] = orderResponse.order;
                    }
                } catch (orderError) {
                    logger.debug('Failed to fetch order for enrichment', {
                        orderId,
                        error: orderError.message
                    });
                }
            }
        } catch (error) {
            logger.warn('Failed to fetch Square orders for enrichment', {
                merchantId,
                rewardId,
                error: error.message
            });
            // Continue without enrichment
        }
    }

    // Enrich each purchase with order data (payment type, line items, order total)
    for (const purchase of purchases) {
        const fullOrder = fullOrders[purchase.square_order_id];
        if (!fullOrder) continue;

        // Payment type fallback
        if (!purchase.payment_type && fullOrder.tenders?.length > 0) {
            purchase.payment_type = fullOrder.tenders[0].type;
        }

        // Order total
        purchase.order_total_cents = fullOrder.totalMoney?.amount
            ? parseInt(fullOrder.totalMoney.amount)
            : null;

        // Extract all line items from the order
        if (fullOrder.lineItems) {
            purchase.allLineItems = fullOrder.lineItems.map(item => {
                const basePriceCents = item.basePriceMoney?.amount
                    ? parseInt(item.basePriceMoney.amount)
                    : null;
                const totalCents = item.totalMoney?.amount
                    ? parseInt(item.totalMoney.amount)
                    : null;

                return {
                    name: item.name,
                    variationName: item.variationName || null,
                    quantity: parseInt(item.quantity) || 1,
                    unitPriceCents: basePriceCents,
                    totalCents: totalCents,
                    isFreeItem: (totalCents === 0 || totalCents === null) && basePriceCents > 0,
                    catalogObjectId: item.catalogObjectId || null,
                    // Check if this line item is the qualifying one for this purchase
                    isQualifying: item.catalogObjectId === purchase.variation_id
                };
            });
        }
    }

    return {
        ...redemption,
        contributingPurchases: purchases,
        lowestPriceCents
    };
}

/**
 * Get redemptions for export with filters
 * Migrated from loyalty_redemptions to loyalty_rewards WHERE status = 'redeemed'
 *
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Filter options
 */
async function getRedemptionsForExport(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { startDate, endDate, offerId, brandName } = options;

    let query = `
        SELECT
            r.id,
            r.merchant_id,
            r.offer_id,
            r.square_customer_id,
            r.redeemed_at,
            r.redemption_order_id as square_order_id,
            r.window_start_date,
            r.window_end_date,
            r.earned_at,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.required_quantity as offer_required_quantity,
            m.business_name,
            COALESCE(lr.redeemed_item_name, pe_info.item_name) as redeemed_item_name,
            COALESCE(lr.redeemed_variation_name, pe_info.variation_name) as redeemed_variation_name,
            COALESCE(lr.redeemed_value_cents, pe_info.avg_price) as redeemed_value_cents
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        JOIN merchants m ON r.merchant_id = m.id
        LEFT JOIN loyalty_redemptions lr
            ON r.redemption_id = lr.id
        LEFT JOIN LATERAL (
            SELECT
                lqv.item_name,
                lqv.variation_name,
                AVG(pe.unit_price_cents) FILTER (WHERE pe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events pe
            LEFT JOIN loyalty_qualifying_variations lqv
                ON pe.variation_id = lqv.variation_id AND pe.offer_id = lqv.offer_id
            WHERE pe.reward_id = r.id
            GROUP BY lqv.item_name, lqv.variation_name
            LIMIT 1
        ) pe_info ON true
        WHERE r.merchant_id = $1 AND r.status = 'redeemed'
    `;
    const params = [merchantId];

    if (startDate) {
        params.push(startDate);
        query += ` AND r.redeemed_at >= $${params.length}`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND r.redeemed_at <= $${params.length}`;
    }

    if (offerId) {
        params.push(offerId);
        query += ` AND r.offer_id = $${params.length}`;
    }

    if (brandName) {
        params.push(brandName);
        query += ` AND o.brand_name = $${params.length}`;
    }

    query += ` ORDER BY r.redeemed_at DESC`;

    const result = await db.query(query, params);
    return result.rows;
}

// ============================================================================
// PDF GENERATION - Vendor Receipt
// ============================================================================

/**
 * Generate a vendor receipt document (HTML format for PDF conversion)
 * Can be converted to PDF using a headless browser or PDF library
 *
 * @param {string} rewardId - Reward UUID (previously redemptionId)
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Receipt data with HTML content
 */
async function generateVendorReceipt(rewardId, merchantId) {
    const data = await getRedemptionDetails(rewardId, merchantId);

    if (!data) {
        throw new Error('Redemption not found');
    }

    // Fetch fresh merchant info from Square APIs (source of truth)
    const squareMerchantInfo = await fetchMerchantInfoFromSquare(merchantId);

    // Build merchant display info with Square as source of truth, DB as fallback
    const merchantDisplay = {
        businessName: squareMerchantInfo?.businessName || data.business_name || 'N/A',
        locationName: squareMerchantInfo?.location?.name || null,
        locationId: squareMerchantInfo?.location?.id || null,
        businessEmail: squareMerchantInfo?.location?.businessEmail || null,
        phoneNumber: squareMerchantInfo?.location?.phoneNumber || null
    };

    // Use shared formatting utilities
    const formatDate = formatReportDate;

    // Build privacy-masked customer info
    const customerDisplayName = formatPrivacyName(data.given_name, data.family_name);
    const customerPhone = formatPrivacyPhone(data.phone_number);
    const customerEmail = formatPrivacyEmail(data.email_address);

    // Build purchase history table rows grouped by order
    // Group purchases by order to avoid showing same order multiple times
    // Within each order: show qualifying items first, then non-qualifying items
    const orderGroups = new Map();
    for (const p of data.contributingPurchases) {
        const orderId = p.square_order_id || `no-order-${p.id}`;
        if (!orderGroups.has(orderId)) {
            orderGroups.set(orderId, {
                orderId: p.square_order_id,
                purchasedAt: p.purchased_at,
                paymentType: p.payment_type,
                orderTotalCents: p.order_total_cents,
                allLineItems: p.allLineItems || [],
                qualifyingPurchases: []
            });
        }
        orderGroups.get(orderId).qualifyingPurchases.push(p);
    }

    const purchaseRows = Array.from(orderGroups.values()).map(order => {
        // Build qualifying items from purchase_events (these are the authoritative source)
        const qualifyingItems = order.qualifyingPurchases.map(p => ({
            name: p.item_name || 'Unknown',
            variationName: p.variation_name || null,
            quantity: p.quantity,
            unitPriceCents: p.unit_price_cents,
            isQualifying: true,
            isFreeItem: false,
            catalogObjectId: p.variation_id,
            vendorItemNumber: p.vendor_item_number || p.sku || 'N/A',
            wholesaleCostCents: p.wholesale_cost_cents || p.vendor_unit_cost
        }));

        // Track which catalog objects are qualifying to avoid duplicates
        const qualifyingCatalogIds = new Set(qualifyingItems.map(q => q.catalogObjectId));

        // Non-qualifying items: all order line items that aren't qualifying
        // Also exclude items that are free (these are the redemption rewards)
        const nonQualifyingItems = order.allLineItems
            .filter(item => !qualifyingCatalogIds.has(item.catalogObjectId))
            .map(item => ({
                ...item,
                isQualifying: false,
                vendorItemNumber: '',
                wholesaleCostCents: null
            }));

        // Combine: qualifying first, then non-qualifying (sorted)
        const allItems = [...qualifyingItems, ...nonQualifyingItems];

        if (allItems.length === 0) {
            // Fallback: no items at all, use purchase event data directly
            const p = order.qualifyingPurchases[0];
            return `
            <tr class="qualifying-row">
                <td>${formatDate(order.purchasedAt)}</td>
                <td>${escapeHtml(p.item_name || 'Unknown')} - ${escapeHtml(p.variation_name || p.variation_id)}</td>
                <td>${escapeHtml(p.vendor_item_number || p.sku || 'N/A')}</td>
                <td class="quantity">${p.quantity}</td>
                <td class="currency">${formatCents(p.unit_price_cents)}</td>
                <td class="currency">${formatCents(p.wholesale_cost_cents || p.vendor_unit_cost)}</td>
                <td>${escapeHtml(order.paymentType || 'N/A')}</td>
                <td style="font-size: 8px; word-break: break-all;">${escapeHtml(order.orderId || 'N/A')}</td>
                <td class="currency">${formatCents(order.orderTotalCents)}</td>
            </tr>`;
        }

        // Render all items with proper rowspan for order-level columns
        return allItems.map((item, idx) => {
            const isFirst = idx === 0;
            const rowClass = item.isQualifying ? 'qualifying-row' : 'non-qualifying-row';
            const itemClass = item.isFreeItem ? 'free-item' : '';

            return `
            <tr class="${rowClass} ${itemClass}">
                ${isFirst ? `<td rowspan="${allItems.length}">${formatDate(order.purchasedAt)}</td>` : ''}
                <td>${escapeHtml(item.name || 'Unknown')}${item.variationName ? ` - ${escapeHtml(item.variationName)}` : ''}</td>
                <td>${item.isQualifying ? escapeHtml(item.vendorItemNumber) : ''}</td>
                <td class="quantity">${item.quantity}</td>
                <td class="currency">${formatCents(item.unitPriceCents)}</td>
                <td class="currency">${item.isQualifying ? formatCents(item.wholesaleCostCents) : ''}</td>
                ${isFirst ? `<td rowspan="${allItems.length}">${escapeHtml(order.paymentType || 'N/A')}</td>` : ''}
                ${isFirst ? `<td rowspan="${allItems.length}" style="font-size: 8px; word-break: break-all;">${escapeHtml(order.orderId || 'N/A')}</td>` : ''}
                ${isFirst ? `<td rowspan="${allItems.length}" class="currency">${formatCents(order.orderTotalCents)}</td>` : ''}
            </tr>`;
        }).join('');
    }).join('');

    // Fetch the redemption order (where customer received the free item)
    // This is separate from contributing purchases - it's the order where reward was applied
    let redemptionOrderRows = '';
    if (data.square_order_id) {
        try {
            // Fetch qualifying variation IDs for this offer to identify the free item
            const qualifyingVarsResult = await db.query(`
                SELECT variation_id
                FROM loyalty_qualifying_variations
                WHERE offer_id = $1 AND merchant_id = $2 AND is_active = true
            `, [data.offer_id, merchantId]);
            const qualifyingVariationIds = new Set(qualifyingVarsResult.rows.map(r => r.variation_id));

            const squareClient = await getSquareClientForMerchant(merchantId);
            const redemptionOrderResponse = await squareClient.orders.get({
                orderId: data.square_order_id
            });
            const redemptionOrder = redemptionOrderResponse.order;

            if (redemptionOrder && redemptionOrder.lineItems) {
                // Build redemption items, splitting line items where qty > 1 for the redeemed item
                // Only 1 item is free (the redeemed item), the rest are paid purchases
                const freeQuantity = 1; // Standard: buy X get 1 free
                const redemptionItems = [];

                // Identify the free item by matching against qualifying variations for this offer
                // (customer may redeem with a different flavor than what they purchased)
                let freeItemFound = false;
                let freeItemVariationId = null;
                for (const item of redemptionOrder.lineItems) {
                    if (!freeItemFound && qualifyingVariationIds.has(item.catalogObjectId)) {
                        freeItemVariationId = item.catalogObjectId;
                        break;
                    }
                }

                // Fetch vendor code AND wholesale cost for the free item's actual variation
                let redeemedVendorCode = null;
                let redeemedWholesaleCostCents = null;
                if (freeItemVariationId) {
                    const vendorResult = await db.query(`
                        SELECT
                            COALESCE(vv.vendor_code, v.supplier_item_number) as vendor_item_number,
                            v.last_cost_cents as wholesale_cost_cents,
                            vv.unit_cost_money as vendor_unit_cost
                        FROM variations v
                        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id
                        WHERE v.id = $1
                    `, [freeItemVariationId]);
                    redeemedVendorCode = vendorResult.rows[0]?.vendor_item_number || null;
                    redeemedWholesaleCostCents = vendorResult.rows[0]?.wholesale_cost_cents
                        || vendorResult.rows[0]?.vendor_unit_cost || null;
                }

                for (const item of redemptionOrder.lineItems) {
                    const basePriceCents = item.basePriceMoney?.amount
                        ? parseInt(item.basePriceMoney.amount)
                        : null;
                    const itemQty = parseInt(item.quantity) || 1;
                    const isQualifyingVariation = !freeItemFound && qualifyingVariationIds.has(item.catalogObjectId);

                    if (isQualifyingVariation && itemQty > freeQuantity) {
                        freeItemFound = true;
                        // Split: 1 free item + (qty-1) paid items
                        redemptionItems.push({
                            name: item.name,
                            variationName: item.variationName || null,
                            quantity: freeQuantity,
                            unitPriceCents: 0,
                            isFreeItem: true,
                            vendorItemNumber: redeemedVendorCode,
                            wholesaleCostCents: redeemedWholesaleCostCents
                        });
                        redemptionItems.push({
                            name: item.name,
                            variationName: item.variationName || null,
                            quantity: itemQty - freeQuantity,
                            unitPriceCents: basePriceCents,
                            isFreeItem: false,
                            vendorItemNumber: null,
                            wholesaleCostCents: null
                        });
                    } else if (isQualifyingVariation) {
                        freeItemFound = true;
                        // Single free item (qty === 1)
                        redemptionItems.push({
                            name: item.name,
                            variationName: item.variationName || null,
                            quantity: itemQty,
                            unitPriceCents: 0,
                            isFreeItem: true,
                            vendorItemNumber: redeemedVendorCode,
                            wholesaleCostCents: redeemedWholesaleCostCents
                        });
                    } else {
                        // Regular item (not the redeemed variation)
                        redemptionItems.push({
                            name: item.name,
                            variationName: item.variationName || null,
                            quantity: itemQty,
                            unitPriceCents: basePriceCents,
                            isFreeItem: false,
                            vendorItemNumber: null,
                            wholesaleCostCents: null
                        });
                    }
                }

                // Sort: free items first (the redeemed item), then others
                redemptionItems.sort((a, b) => (b.isFreeItem ? 1 : 0) - (a.isFreeItem ? 1 : 0));

                const redemptionPaymentType = redemptionOrder.tenders?.[0]?.type || 'N/A';
                const redemptionTotalCents = redemptionOrder.totalMoney?.amount
                    ? parseInt(redemptionOrder.totalMoney.amount)
                    : null;

                redemptionOrderRows = `
                <tr class="redemption-separator">
                    <td colspan="9" style="background: #ff9800; color: white; text-align: center; font-weight: bold; padding: 8px;">
                        REDEMPTION ORDER — Free Item Received
                    </td>
                </tr>
                ${redemptionItems.map((item, idx) => {
                    const isFirst = idx === 0;
                    const rowClass = item.isFreeItem ? 'redemption-row free-item' : 'redemption-row';

                    return `
                    <tr class="${rowClass}">
                        ${isFirst ? `<td rowspan="${redemptionItems.length}">${formatDate(data.redeemed_at)}</td>` : ''}
                        <td>${escapeHtml(item.name || 'Unknown')}${item.variationName ? ` - ${escapeHtml(item.variationName)}` : ''}${item.isFreeItem ? ' <strong>(FREE)</strong>' : ''}</td>
                        <td>${item.isFreeItem ? escapeHtml(item.vendorItemNumber || '') : ''}</td>
                        <td class="quantity">${item.quantity}</td>
                        <td class="currency">${item.isFreeItem ? '$0.00' : formatCents(item.unitPriceCents)}</td>
                        <td class="currency">${item.isFreeItem ? formatCents(item.wholesaleCostCents) : ''}</td>
                        ${isFirst ? `<td rowspan="${redemptionItems.length}">${escapeHtml(redemptionPaymentType)}</td>` : ''}
                        ${isFirst ? `<td rowspan="${redemptionItems.length}" style="font-size: 8px; word-break: break-all;">${escapeHtml(data.square_order_id || 'N/A')}</td>` : ''}
                        ${isFirst ? `<td rowspan="${redemptionItems.length}" class="currency">${formatCents(redemptionTotalCents)}</td>` : ''}
                    </tr>`;
                }).join('')}`;
            }
        } catch (error) {
            logger.debug('Failed to fetch redemption order for receipt', {
                orderId: data.square_order_id,
                error: error.message
            });
            // Continue without redemption order display
        }
    }

    // Calculate totals
    const totalPurchases = data.contributingPurchases.reduce((sum, p) => sum + (p.quantity > 0 ? p.quantity : 0), 0);
    const totalRefunds = data.contributingPurchases.reduce((sum, p) => sum + (p.quantity < 0 ? Math.abs(p.quantity) : 0), 0);
    const netQuantity = totalPurchases - totalRefunds;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Vendor Redemption Receipt - ${data.id}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 11px;
            line-height: 1.3;
            color: #333;
            padding: 12px;
            max-width: 800px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            border-bottom: 2px solid #333;
            padding-bottom: 6px;
            margin-bottom: 10px;
        }
        .header h1 {
            font-size: 18px;
            display: inline;
        }
        .header .receipt-id {
            font-family: monospace;
            font-size: 9px;
            color: #666;
            margin-left: 10px;
        }
        .section {
            margin-bottom: 8px;
        }
        .section h2 {
            font-size: 11px;
            color: #333;
            border-bottom: 1px solid #ddd;
            padding-bottom: 2px;
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }
        .info-grid-4 {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
        }
        .info-box {
            background: #f9f9f9;
            padding: 4px 6px;
            border-radius: 3px;
        }
        .info-box label {
            font-weight: bold;
            font-size: 8px;
            text-transform: uppercase;
            color: #666;
            display: block;
            margin-bottom: 1px;
        }
        .info-box .value {
            font-size: 11px;
        }
        .divider {
            grid-column: 1 / -1;
            border-top: 1px dashed #ccc;
            margin: 4px 0;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10px;
        }
        th {
            background: #333;
            color: white;
            padding: 4px 3px;
            text-align: left;
            font-weight: normal;
            font-size: 9px;
        }
        td {
            padding: 4px 3px;
            border-bottom: 1px solid #eee;
        }
        tr:nth-child(even) { background: #f9f9f9; }
        .quantity, .currency { text-align: right; }
        .table-note {
            font-size: 9px;
            color: #666;
            margin-bottom: 4px;
            font-style: italic;
        }
        .qualifying-row {
            font-weight: bold;
            background: #e8f5e9 !important;
        }
        .qualifying-row td { border-left: 2px solid #4caf50; }
        .non-qualifying-row {
            font-style: italic;
            color: #666;
        }
        .non-qualifying-row td { border-left: 2px solid transparent; }
        .free-item { background: #fff3e0 !important; }
        .free-item td { border-left-color: #ff9800 !important; }
        .redemption-row { background: #fff8e1 !important; }
        .redemption-row td { border-left: 2px solid #ff9800; }
        .redemption-row.free-item {
            background: #ffecb3 !important;
            font-weight: bold;
        }
        .summary-footer {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 8px;
        }
        .summary {
            background: #f0f0f0;
            padding: 8px;
            border-radius: 4px;
            font-size: 10px;
        }
        .summary-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2px;
        }
        .summary-row.total {
            font-weight: bold;
            border-top: 1px solid #ccc;
            padding-top: 4px;
            margin-top: 4px;
        }
        .summary-row.credit {
            background: #e8f5e9;
            padding: 4px;
            margin: 4px -8px -8px;
            border-radius: 0 0 4px 4px;
        }
        .signature-section {
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
        }
        .signature-line {
            display: flex;
            justify-content: space-between;
            gap: 15px;
        }
        .signature-box {
            flex: 1;
            border-top: 1px solid #333;
            padding-top: 3px;
            text-align: center;
            font-size: 9px;
        }
        .footer {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid #ddd;
            font-size: 8px;
            color: #666;
            text-align: center;
        }
        @media print {
            body { padding: 8px; font-size: 10px; }
            .no-print { display: none !important; }
            .section { margin-bottom: 6px; }
            table { font-size: 9px; }
            th, td { padding: 3px 2px; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>VENDOR REDEMPTION RECEIPT</h1>
        <span class="receipt-id">${escapeHtml(data.id)}</span>
    </div>

    <!-- Section 1: Merchant & Customer -->
    <div class="section">
        <h2>Merchant & Customer</h2>
        <div class="info-grid-4">
            <div class="info-box">
                <label>Business</label>
                <div class="value">${escapeHtml(merchantDisplay.businessName)}</div>
            </div>
            <div class="info-box">
                <label>Business Email</label>
                <div class="value">${escapeHtml(merchantDisplay.businessEmail || 'N/A')}</div>
            </div>
            <div class="info-box">
                <label>Customer</label>
                <div class="value">${escapeHtml(customerDisplayName)}</div>
            </div>
            <div class="info-box">
                <label>Customer Phone</label>
                <div class="value">${escapeHtml(customerPhone || 'N/A')}</div>
            </div>
        </div>
    </div>

    <!-- Section 2: Program & Redemption -->
    <div class="section">
        <h2>Program & Redemption</h2>
        <div class="info-grid-4">
            <div class="info-box">
                <label>Brand</label>
                <div class="value">${escapeHtml(data.brand_name)}</div>
            </div>
            <div class="info-box">
                <label>Size Group</label>
                <div class="value">${escapeHtml(data.size_group)}</div>
            </div>
            <div class="info-box">
                <label>Program</label>
                <div class="value">${escapeHtml(data.offer_name)}</div>
            </div>
            <div class="info-box">
                <label>Type</label>
                <div class="value">Buy ${data.required_quantity} Get 1 Free</div>
            </div>
            <div class="divider"></div>
            <div class="info-box">
                <label>Redeemed</label>
                <div class="value">${formatDate(data.redeemed_at)}</div>
            </div>
            <div class="info-box">
                <label>Item Value</label>
                <div class="value">${formatCents(data.redeemed_value_cents)}</div>
            </div>
            <div class="info-box">
                <label>Window</label>
                <div class="value">${formatDate(data.window_start_date)} - ${formatDate(data.window_end_date)}</div>
            </div>
            <div class="info-box">
                <label>Earned</label>
                <div class="value">${formatDate(data.earned_at)}</div>
            </div>
        </div>
    </div>

    <!-- Transactions Table -->
    <div class="section">
        <h2>Contributing Transactions</h2>
        <p class="table-note"><strong>Green</strong> = qualifying purchases | <strong>Orange</strong> = redemption order (free item)</p>
        <table>
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Item</th>
                    <th>Vendor #</th>
                    <th>Qty</th>
                    <th>Retail</th>
                    <th>Wholesale</th>
                    <th>Payment</th>
                    <th>Order ID</th>
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>
                ${purchaseRows || '<tr><td colspan="9">No purchase records available</td></tr>'}
                ${redemptionOrderRows}
            </tbody>
        </table>
    </div>

    <!-- Vendor Credit Status (read-only display for printed receipt) -->
    <div class="section" style="padding: 8px; border-radius: 6px; ${
        data.vendor_credit_status === 'CREDITED' ? 'background: #e8f5e9; border: 1px solid #4caf50;' :
        data.vendor_credit_status === 'DENIED' ? 'background: #ffebee; border: 1px solid #f44336;' :
        data.vendor_credit_status === 'SUBMITTED' ? 'background: #fff3e0; border: 1px solid #ff9800;' :
        'background: #f5f5f5; border: 1px dashed #9e9e9e;'
    }">
        <h2 style="color: ${
            data.vendor_credit_status === 'CREDITED' ? '#2e7d32' :
            data.vendor_credit_status === 'DENIED' ? '#c62828' :
            data.vendor_credit_status === 'SUBMITTED' ? '#e65100' : '#616161'
        }; border: none; margin-bottom: 6px;">Vendor Credit Status</h2>

        ${data.vendor_name ? `
        <div style="display: flex; gap: 10px; margin-bottom: 6px; font-size: 10px;">
            <span><strong>Vendor:</strong> ${escapeHtml(data.vendor_name)}</span>
            <span><strong>Email:</strong> ${escapeHtml(data.vendor_email || 'N/A')}</span>
        </div>
        ` : ''}

        <div style="font-size: 11px;">
            ${!data.vendor_credit_status ? `
            <p style="color: #666;"><strong>Status:</strong> Not yet submitted for vendor credit</p>
            ` : ''}

            ${data.vendor_credit_status === 'SUBMITTED' ? `
            <p><strong style="color: #e65100;">Status: SUBMITTED</strong></p>
            <p>Submitted: ${formatDate(data.vendor_credit_submitted_at)}${data.vendor_credit_notes ? ` | Notes: ${escapeHtml(data.vendor_credit_notes)}` : ''}</p>
            ` : ''}

            ${data.vendor_credit_status === 'CREDITED' ? `
            <p><strong style="color: #2e7d32;">Status: CREDIT RECEIVED</strong></p>
            <p>Submitted: ${formatDate(data.vendor_credit_submitted_at)} | Credited: ${formatDate(data.vendor_credit_resolved_at)}${data.vendor_credit_notes ? ` | Notes: ${escapeHtml(data.vendor_credit_notes)}` : ''}</p>
            ` : ''}

            ${data.vendor_credit_status === 'DENIED' ? `
            <p><strong style="color: #c62828;">Status: CREDIT DENIED</strong></p>
            <p>Submitted: ${formatDate(data.vendor_credit_submitted_at)} | Denied: ${formatDate(data.vendor_credit_resolved_at)}${data.vendor_credit_notes ? ` | Reason: ${escapeHtml(data.vendor_credit_notes)}` : ''}</p>
            ` : ''}
        </div>
    </div>

    <!-- Summary & Signature (side by side) -->
    <div class="summary-footer">
        <div class="summary">
            <div class="summary-row"><span>Purchases:</span><span>${totalPurchases} units</span></div>
            <div class="summary-row"><span>Refunds:</span><span>${totalRefunds} units</span></div>
            <div class="summary-row"><span>Required:</span><span>${data.required_quantity} units</span></div>
            <div class="summary-row total"><span>Net Qualifying:</span><span>${netQuantity} units</span></div>
            <div class="summary-row"><span>Item Value:</span><span>${formatCents(data.redeemed_value_cents)}</span></div>
            <div class="summary-row"><span>Lowest Price:</span><span>${formatCents(data.lowestPriceCents)}</span></div>
            <div class="summary-row total credit"><span><strong>VENDOR CREDIT:</strong></span><span><strong>${formatCents(data.lowestPriceCents)}</strong></span></div>
        </div>
        <div class="signature-section">
            <div class="signature-line">
                <div class="signature-box">Vendor Representative</div>
                <div class="signature-box">Date</div>
            </div>
        </div>
    </div>

    <div class="footer">
        Generated ${formatDate(new Date())} | ${data.id} | Square Dashboard Addon - Loyalty Program
    </div>
</body>
</html>
`;

    return {
        html,
        data,
        filename: `vendor-receipt-${data.id.slice(0, 8)}.html`
    };
}

// ============================================================================
// CSV EXPORT - Audit Reports
// ============================================================================

/**
 * Generate CSV export of redemptions
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Export options
 * @returns {Promise<Object>} CSV content and metadata
 */
async function generateRedemptionsCSV(merchantId, options = {}) {
    const redemptions = await getRedemptionsForExport(merchantId, options);

    if (redemptions.length === 0) {
        return {
            csv: UTF8_BOM + 'No redemptions found for the specified criteria',
            filename: `loyalty-redemptions-export-${Date.now()}.csv`,
            count: 0
        };
    }

    const headers = [
        'Redemption ID',
        'Redemption Date',
        'Brand Name',
        'Size Group',
        'Offer Name',
        'Customer ID',
        'Redemption Type',
        'Square Order ID',
        'Redeemed Item',
        'Redeemed Value ($)',
        'Window Start',
        'Window End',
        'Reward Earned Date',
        'Required Qty',
        'Admin Notes',
        'Merchant Name'
    ];

    const rows = redemptions.map(r => [
        r.id,
        r.redeemed_at ? new Date(r.redeemed_at).toISOString() : '',
        r.brand_name,
        r.size_group,
        r.offer_name,
        r.square_customer_id,
        r.redemption_type || 'STANDARD',
        r.square_order_id || '',
        r.redeemed_item_name ? `${r.redeemed_item_name} - ${r.redeemed_variation_name || ''}` : '',
        r.redeemed_value_cents ? (r.redeemed_value_cents / 100).toFixed(2) : '',
        r.window_start_date ? new Date(r.window_start_date).toISOString().split('T')[0] : '',
        r.window_end_date ? new Date(r.window_end_date).toISOString().split('T')[0] : '',
        r.earned_at ? new Date(r.earned_at).toISOString() : '',
        r.offer_required_quantity || '',
        r.admin_notes || '',
        r.business_name
    ]);

    const csv = UTF8_BOM + [
        headers.map(h => escapeCSVField(h)).join(','),
        ...rows.map(row => row.map(cell => escapeCSVField(String(cell ?? ''))).join(','))
    ].join('\n');

    return {
        csv,
        filename: `loyalty-redemptions-${new Date().toISOString().split('T')[0]}.csv`,
        count: redemptions.length
    };
}

/**
 * Generate detailed audit CSV with all purchase events
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Export options
 */
async function generateAuditCSV(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { startDate, endDate, offerId, squareCustomerId } = options;

    let query = `
        SELECT
            pe.*,
            o.offer_name,
            o.brand_name,
            o.size_group,
            qv.item_name,
            qv.variation_name,
            qv.sku
        FROM loyalty_purchase_events pe
        JOIN loyalty_offers o ON pe.offer_id = o.id
        LEFT JOIN loyalty_qualifying_variations qv
            ON pe.variation_id = qv.variation_id AND qv.merchant_id = pe.merchant_id
        WHERE pe.merchant_id = $1
    `;
    const params = [merchantId];

    if (startDate) {
        params.push(startDate);
        query += ` AND pe.purchased_at >= $${params.length}`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND pe.purchased_at <= $${params.length}`;
    }

    if (offerId) {
        params.push(offerId);
        query += ` AND pe.offer_id = $${params.length}`;
    }

    if (squareCustomerId) {
        params.push(squareCustomerId);
        query += ` AND pe.square_customer_id = $${params.length}`;
    }

    query += ` ORDER BY pe.purchased_at DESC`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
        return {
            csv: UTF8_BOM + 'No audit records found for the specified criteria',
            filename: `loyalty-audit-export-${Date.now()}.csv`,
            count: 0
        };
    }

    const headers = [
        'Event ID',
        'Event Date',
        'Event Type',
        'Customer Source',
        'Payment Type',
        'Brand Name',
        'Size Group',
        'Offer Name',
        'Customer ID',
        'Square Order ID',
        'Variation ID',
        'Item Name',
        'Variation Name',
        'SKU',
        'Quantity',
        'Unit Price ($)',
        'Window Start',
        'Window End',
        'Reward ID',
        'Is Refund',
        'Receipt URL'
    ];

    // Map customer_source values to human-readable labels
    const sourceLabels = {
        'order': 'Direct (Order)',
        'tender': 'Payment Tender',
        'loyalty_api': 'Loyalty API',
        'manual': 'Manual Admin Add'
    };

    const rows = result.rows.map(r => [
        r.id,
        r.purchased_at ? new Date(r.purchased_at).toISOString() : '',
        r.is_refund ? 'REFUND' : 'PURCHASE',
        sourceLabels[r.customer_source] || r.customer_source || 'Direct (Order)',
        r.payment_type || '',
        r.brand_name,
        r.size_group,
        r.offer_name,
        r.square_customer_id,
        r.square_order_id || '',
        r.variation_id,
        r.item_name || '',
        r.variation_name || '',
        r.sku || '',
        r.quantity,
        r.unit_price_cents ? (r.unit_price_cents / 100).toFixed(2) : '',
        r.window_start_date ? new Date(r.window_start_date).toISOString().split('T')[0] : '',
        r.window_end_date ? new Date(r.window_end_date).toISOString().split('T')[0] : '',
        r.reward_id || '',
        r.is_refund ? 'Yes' : 'No',
        r.receipt_url || ''
    ]);

    const csv = UTF8_BOM + [
        headers.map(h => escapeCSVField(h)).join(','),
        ...rows.map(row => row.map(cell => escapeCSVField(String(cell ?? ''))).join(','))
    ].join('\n');

    return {
        csv,
        filename: `loyalty-audit-${new Date().toISOString().split('T')[0]}.csv`,
        count: result.rows.length
    };
}

/**
 * Generate summary CSV grouped by brand/offer
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Export options
 */
async function generateSummaryCSV(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { startDate, endDate } = options;

    // Migrated from loyalty_redemptions - now calculates value from purchase events
    let query = `
        SELECT
            o.brand_name,
            o.size_group,
            o.offer_name,
            o.required_quantity,
            COUNT(DISTINCT CASE WHEN r.status = 'earned' THEN r.id END) as pending_rewards,
            COUNT(DISTINCT CASE WHEN r.status = 'redeemed' THEN r.id END) as redeemed_rewards,
            COUNT(DISTINCT CASE WHEN r.status = 'revoked' THEN r.id END) as revoked_rewards,
            -- Calculate value from purchase events linked to redeemed rewards
            COALESCE(SUM(CASE WHEN r.status = 'redeemed' THEN reward_values.avg_price END), 0) as total_redemption_value_cents,
            COUNT(DISTINCT r.square_customer_id) as unique_customers,
            COUNT(DISTINCT pe.id) as total_purchase_events
        FROM loyalty_offers o
        LEFT JOIN loyalty_rewards r ON o.id = r.offer_id
        LEFT JOIN LATERAL (
            SELECT AVG(lpe.unit_price_cents) FILTER (WHERE lpe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events lpe
            WHERE lpe.reward_id = r.id
        ) reward_values ON r.status = 'redeemed'
        LEFT JOIN loyalty_purchase_events pe ON o.id = pe.offer_id
        WHERE o.merchant_id = $1 AND o.is_active = TRUE
    `;
    const params = [merchantId];

    if (startDate) {
        params.push(startDate);
        query += ` AND (r.redeemed_at IS NULL OR r.redeemed_at >= $${params.length})`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND (r.redeemed_at IS NULL OR r.redeemed_at <= $${params.length})`;
    }

    query += `
        GROUP BY o.id, o.brand_name, o.size_group, o.offer_name, o.required_quantity
        ORDER BY o.brand_name, o.size_group
    `;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
        return {
            csv: UTF8_BOM + 'No offers found',
            filename: `loyalty-summary-${Date.now()}.csv`,
            count: 0
        };
    }

    const headers = [
        'Brand Name',
        'Size Group',
        'Offer Name',
        'Required Qty',
        'Pending Rewards',
        'Redeemed Rewards',
        'Revoked Rewards',
        'Total Redemption Value ($)',
        'Unique Customers',
        'Total Purchase Events'
    ];

    const rows = result.rows.map(r => [
        r.brand_name,
        r.size_group,
        r.offer_name,
        r.required_quantity,
        r.pending_rewards || 0,
        r.redeemed_rewards || 0,
        r.revoked_rewards || 0,
        r.total_redemption_value_cents ? (r.total_redemption_value_cents / 100).toFixed(2) : '0.00',
        r.unique_customers || 0,
        r.total_purchase_events || 0
    ]);

    const csv = UTF8_BOM + [
        headers.map(h => escapeCSVField(h)).join(','),
        ...rows.map(row => row.map(cell => escapeCSVField(String(cell ?? ''))).join(','))
    ].join('\n');

    return {
        csv,
        filename: `loyalty-summary-${new Date().toISOString().split('T')[0]}.csv`,
        count: result.rows.length
    };
}

/**
 * Generate customer activity CSV
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Export options
 */
async function generateCustomerActivityCSV(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { offerId, minPurchases = 1 } = options;

    let query = `
        SELECT
            cs.square_customer_id,
            o.brand_name,
            o.size_group,
            o.offer_name,
            cs.current_quantity,
            cs.required_quantity,
            cs.total_lifetime_purchases,
            cs.total_rewards_earned,
            cs.total_rewards_redeemed,
            cs.has_earned_reward,
            cs.window_start_date,
            cs.window_end_date,
            cs.last_purchase_at
        FROM loyalty_customer_summary cs
        JOIN loyalty_offers o ON cs.offer_id = o.id
        WHERE cs.merchant_id = $1
          AND cs.total_lifetime_purchases >= $2
    `;
    const params = [merchantId, minPurchases];

    if (offerId) {
        params.push(offerId);
        query += ` AND cs.offer_id = $${params.length}`;
    }

    query += ` ORDER BY o.brand_name, o.size_group, cs.current_quantity DESC`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
        return {
            csv: UTF8_BOM + 'No customer activity found',
            filename: `loyalty-customers-${Date.now()}.csv`,
            count: 0
        };
    }

    const headers = [
        'Customer ID',
        'Brand Name',
        'Size Group',
        'Offer Name',
        'Current Progress',
        'Required Qty',
        'Progress %',
        'Lifetime Purchases',
        'Rewards Earned',
        'Rewards Redeemed',
        'Has Pending Reward',
        'Window Start',
        'Window End',
        'Last Purchase'
    ];

    const rows = result.rows.map(r => [
        r.square_customer_id,
        r.brand_name,
        r.size_group,
        r.offer_name,
        r.current_quantity,
        r.required_quantity,
        r.required_quantity > 0 ? ((r.current_quantity / r.required_quantity) * 100).toFixed(1) + '%' : '0%',
        r.total_lifetime_purchases,
        r.total_rewards_earned,
        r.total_rewards_redeemed,
        r.has_earned_reward ? 'Yes' : 'No',
        r.window_start_date ? new Date(r.window_start_date).toISOString().split('T')[0] : '',
        r.window_end_date ? new Date(r.window_end_date).toISOString().split('T')[0] : '',
        r.last_purchase_at ? new Date(r.last_purchase_at).toISOString() : ''
    ]);

    const csv = UTF8_BOM + [
        headers.map(h => escapeCSVField(h)).join(','),
        ...rows.map(row => row.map(cell => escapeCSVField(String(cell ?? ''))).join(','))
    ].join('\n');

    return {
        csv,
        filename: `loyalty-customers-${new Date().toISOString().split('T')[0]}.csv`,
        count: result.rows.length
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Data queries
    getRedemptionDetails,
    getRedemptionsForExport,

    // PDF generation
    generateVendorReceipt,

    // CSV exports
    generateRedemptionsCSV,
    generateAuditCSV,
    generateSummaryCSV,
    generateCustomerActivityCSV
};
