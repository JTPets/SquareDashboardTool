/**
 * Brand Redemption Report Service
 *
 * Generates comprehensive proof-of-purchase documentation for brands supplying
 * free product giveaways through loyalty programs.
 *
 * Key features:
 * - Privacy-aware customer info (masked phone/email)
 * - Full order line items for each contributing purchase
 * - Summary metrics (total spend, average order value, time span, visits)
 * - Multiple export formats (JSON, HTML, CSV)
 *
 * This service extends the existing loyalty-reports.js functionality.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { formatMoney, escapeCSVField, UTF8_BOM } = require('../../utils/csv-helpers');
const { getSquareClientForMerchant } = require('../../middleware/merchant');

// ============================================================================
// PRIVACY-AWARE FORMATTING
// ============================================================================

/**
 * Format customer name as "First L."
 * @param {string} givenName - First name
 * @param {string} familyName - Last name
 * @returns {string} Formatted name
 */
function formatPrivacyName(givenName, familyName) {
    const first = givenName ? givenName.trim() : '';
    const lastInitial = familyName ? familyName.trim().charAt(0).toUpperCase() + '.' : '';

    if (first && lastInitial) {
        return `${first} ${lastInitial}`;
    } else if (first) {
        return first;
    }
    return 'Customer';
}

/**
 * Format phone number as "***-XXXX" (last 4 digits)
 * @param {string} phone - Full phone number
 * @returns {string} Masked phone
 */
function formatPrivacyPhone(phone) {
    if (!phone) return null;

    // Extract digits only
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return '***-****';

    const last4 = digits.slice(-4);
    return `***-${last4}`;
}

/**
 * Format email as "user@d..." (truncated domain)
 * @param {string} email - Full email
 * @returns {string} Truncated email
 */
function formatPrivacyEmail(email) {
    if (!email) return null;

    const atIndex = email.indexOf('@');
    if (atIndex === -1) return email.slice(0, 8) + '...';

    const localPart = email.slice(0, atIndex);
    const domain = email.slice(atIndex + 1);
    const domainTrunc = domain.length > 2 ? domain.slice(0, 1) + '...' : domain;

    return `${localPart}@${domainTrunc}`;
}

// ============================================================================
// DATA QUERIES
// ============================================================================

/**
 * Get redemptions with all data needed for brand report
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Filter options
 */
async function getBrandRedemptions(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { startDate, endDate, offerId, brandName } = options;

    let query = `
        SELECT
            r.id as reward_id,
            r.square_customer_id,
            r.redeemed_at,
            r.redemption_order_id,
            r.window_start_date,
            r.window_end_date,
            r.earned_at,
            r.current_quantity,
            r.required_quantity,
            o.id as offer_id,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.vendor_name,
            o.vendor_email,
            m.business_name,
            -- Customer info from cache
            lc.given_name,
            lc.family_name,
            lc.phone_number,
            lc.email_address,
            -- Redeemed item info
            pe_info.item_name as redeemed_item_name,
            pe_info.variation_name as redeemed_variation_name,
            pe_info.sku as redeemed_sku,
            pe_info.avg_price as redeemed_value_cents
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        JOIN merchants m ON r.merchant_id = m.id
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        LEFT JOIN LATERAL (
            SELECT
                lqv.item_name,
                lqv.variation_name,
                lqv.sku,
                AVG(pe.unit_price_cents) FILTER (WHERE pe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events pe
            LEFT JOIN loyalty_qualifying_variations lqv
                ON pe.variation_id = lqv.variation_id AND pe.offer_id = lqv.offer_id
            WHERE pe.reward_id = r.id
            GROUP BY lqv.item_name, lqv.variation_name, lqv.sku
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

/**
 * Get contributing purchases for a reward
 * @param {string} rewardId - Reward UUID
 * @param {number} merchantId - Merchant ID
 */
async function getContributingPurchases(rewardId, merchantId) {
    const result = await db.query(`
        SELECT
            pe.id as event_id,
            pe.square_order_id,
            pe.variation_id,
            pe.quantity,
            pe.unit_price_cents,
            pe.purchased_at,
            pe.payment_type,
            pe.receipt_url,
            pe.customer_source,
            pe.is_refund,
            qv.item_name,
            qv.variation_name,
            qv.sku
        FROM loyalty_purchase_events pe
        LEFT JOIN loyalty_qualifying_variations qv
            ON pe.variation_id = qv.variation_id AND qv.merchant_id = pe.merchant_id
        WHERE pe.reward_id = $1 AND pe.merchant_id = $2
        ORDER BY pe.purchased_at ASC
    `, [rewardId, merchantId]);

    return result.rows;
}

/**
 * Fetch full order details from Square API
 * @param {number} merchantId - Merchant ID
 * @param {string} orderId - Square Order ID
 */
async function fetchSquareOrderDetails(merchantId, orderId) {
    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const response = await squareClient.ordersApi.retrieveOrder(orderId);
        return response.result.order;
    } catch (error) {
        logger.warn('Failed to fetch Square order', { merchantId, orderId, error: error.message });
        return null;
    }
}

/**
 * Build complete brand redemption data with enriched order details
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Filter options
 * @param {boolean} options.includeFullOrders - Whether to fetch full Square order data
 */
async function buildBrandRedemptionReport(merchantId, options = {}) {
    const { includeFullOrders = false, ...filterOptions } = options;

    const redemptions = await getBrandRedemptions(merchantId, filterOptions);

    if (redemptions.length === 0) {
        return { redemptions: [], summary: null };
    }

    const enrichedRedemptions = [];

    for (const redemption of redemptions) {
        // Get contributing purchases
        const purchases = await getContributingPurchases(redemption.reward_id, merchantId);

        // Get unique order IDs
        const orderIds = [...new Set(purchases.map(p => p.square_order_id).filter(Boolean))];

        // Fetch full order details if requested
        let fullOrders = {};
        if (includeFullOrders && orderIds.length > 0) {
            for (const orderId of orderIds) {
                const order = await fetchSquareOrderDetails(merchantId, orderId);
                if (order) {
                    fullOrders[orderId] = order;
                }
            }
        }

        // Calculate summary metrics
        const purchaseDates = purchases
            .filter(p => p.purchased_at && !p.is_refund)
            .map(p => new Date(p.purchased_at))
            .sort((a, b) => a - b);

        const totalSpendCents = purchases.reduce((sum, p) => {
            if (p.is_refund) return sum;
            return sum + (p.quantity * (p.unit_price_cents || 0));
        }, 0);

        const visitCount = orderIds.length;
        const averageOrderValueCents = visitCount > 0 ? Math.round(totalSpendCents / visitCount) : 0;

        let timeSpanDays = 0;
        if (purchaseDates.length >= 2) {
            const firstPurchase = purchaseDates[0];
            const lastPurchase = purchaseDates[purchaseDates.length - 1];
            timeSpanDays = Math.ceil((lastPurchase - firstPurchase) / (1000 * 60 * 60 * 24));
        }

        // Format privacy-aware customer info
        const customerInfo = {
            displayName: formatPrivacyName(redemption.given_name, redemption.family_name),
            phoneLastFour: formatPrivacyPhone(redemption.phone_number),
            emailTruncated: formatPrivacyEmail(redemption.email_address),
            squareCustomerId: redemption.square_customer_id
        };

        // Build enriched purchases with full order line items
        const enrichedPurchases = purchases.map(purchase => {
            const fullOrder = fullOrders[purchase.square_order_id];

            // Get all line items from full order (not just qualifying ones)
            let allLineItems = [];
            if (fullOrder && fullOrder.lineItems) {
                allLineItems = fullOrder.lineItems.map(item => ({
                    name: item.name,
                    variationName: item.variationName || null,
                    quantity: parseInt(item.quantity) || 1,
                    unitPriceCents: item.basePriceMoney?.amount
                        ? parseInt(item.basePriceMoney.amount)
                        : null,
                    totalCents: item.totalMoney?.amount
                        ? parseInt(item.totalMoney.amount)
                        : null,
                    catalogObjectId: item.catalogObjectId || null
                }));
            }

            return {
                eventId: purchase.event_id,
                orderId: purchase.square_order_id,
                purchasedAt: purchase.purchased_at,
                paymentType: purchase.payment_type,
                receiptUrl: purchase.receipt_url,
                isRefund: purchase.is_refund,
                // Qualifying item that counted toward punch card
                qualifyingItem: {
                    itemName: purchase.item_name,
                    variationName: purchase.variation_name,
                    sku: purchase.sku,
                    quantity: purchase.quantity,
                    unitPriceCents: purchase.unit_price_cents
                },
                // All items on this order (if fetched)
                allLineItems: allLineItems.length > 0 ? allLineItems : null,
                // Full order metadata
                orderTotal: fullOrder?.totalMoney?.amount
                    ? parseInt(fullOrder.totalMoney.amount)
                    : null
            };
        });

        enrichedRedemptions.push({
            rewardId: redemption.reward_id,
            redemptionDate: redemption.redeemed_at,
            redemptionOrderId: redemption.redemption_order_id,
            offer: {
                id: redemption.offer_id,
                name: redemption.offer_name,
                brandName: redemption.brand_name,
                sizeGroup: redemption.size_group,
                vendorName: redemption.vendor_name,
                vendorEmail: redemption.vendor_email
            },
            customer: customerInfo,
            redeemedItem: {
                name: redemption.redeemed_item_name,
                variation: redemption.redeemed_variation_name,
                sku: redemption.redeemed_sku,
                retailValueCents: redemption.redeemed_value_cents
                    ? Math.round(redemption.redeemed_value_cents)
                    : null
            },
            earningWindow: {
                start: redemption.window_start_date,
                end: redemption.window_end_date,
                earnedAt: redemption.earned_at
            },
            contributingPurchases: enrichedPurchases,
            summary: {
                totalSpendCents,
                averageOrderValueCents,
                timeSpanDays,
                visitCount,
                qualifyingPurchaseCount: purchases.filter(p => !p.is_refund).length,
                refundCount: purchases.filter(p => p.is_refund).length
            },
            merchantName: redemption.business_name
        });
    }

    // Calculate overall summary
    const overallSummary = {
        totalRedemptions: enrichedRedemptions.length,
        totalValue: enrichedRedemptions.reduce(
            (sum, r) => sum + (r.redeemedItem.retailValueCents || 0),
            0
        ),
        uniqueCustomers: new Set(enrichedRedemptions.map(r => r.customer.squareCustomerId)).size,
        dateRange: {
            earliest: enrichedRedemptions.length > 0
                ? enrichedRedemptions[enrichedRedemptions.length - 1].redemptionDate
                : null,
            latest: enrichedRedemptions.length > 0
                ? enrichedRedemptions[0].redemptionDate
                : null
        }
    };

    return {
        redemptions: enrichedRedemptions,
        summary: overallSummary
    };
}

// ============================================================================
// HTML REPORT GENERATION
// ============================================================================

/**
 * Generate printable HTML report for brand representatives
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Report options
 */
async function generateBrandRedemptionHTML(merchantId, options = {}) {
    const report = await buildBrandRedemptionReport(merchantId, {
        ...options,
        includeFullOrders: true
    });

    if (report.redemptions.length === 0) {
        return {
            html: '<html><body><h1>No redemptions found</h1></body></html>',
            data: report,
            filename: 'brand-redemption-report-empty.html'
        };
    }

    const formatDate = (date) => {
        if (!date) return 'N/A';
        return new Date(date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const formatCents = (cents) => {
        if (cents === null || cents === undefined) return 'N/A';
        return `$${(cents / 100).toFixed(2)}`;
    };

    // Build redemption cards
    const redemptionCards = report.redemptions.map((r, index) => {
        // Build contributing purchases table
        const purchaseRows = r.contributingPurchases.map((p, pIndex) => {
            // All line items column
            let lineItemsHtml = '';
            if (p.allLineItems && p.allLineItems.length > 0) {
                const itemsList = p.allLineItems.map(item =>
                    `<div class="line-item ${item.catalogObjectId === p.qualifyingItem.variationId ? 'qualifying' : ''}">
                        <span class="item-name">${item.name}${item.variationName ? ` - ${item.variationName}` : ''}</span>
                        <span class="item-details">x${item.quantity} @ ${formatCents(item.unitPriceCents)} = ${formatCents(item.totalCents)}</span>
                    </div>`
                ).join('');
                lineItemsHtml = `<div class="line-items-list">${itemsList}</div>`;
            } else {
                lineItemsHtml = `<div class="line-items-list">
                    <div class="line-item qualifying">
                        <span class="item-name">${p.qualifyingItem.itemName || 'Unknown'} - ${p.qualifyingItem.variationName || ''}</span>
                        <span class="item-details">x${p.qualifyingItem.quantity} @ ${formatCents(p.qualifyingItem.unitPriceCents)}</span>
                    </div>
                </div>`;
            }

            return `
                <tr class="${p.isRefund ? 'refund-row' : ''}">
                    <td class="date-col">${formatDate(p.purchasedAt)}</td>
                    <td class="order-col">
                        <div class="order-id">${p.orderId?.slice(0, 12) || 'N/A'}...</div>
                        ${p.receiptUrl ? `<a href="${p.receiptUrl}" target="_blank" class="receipt-link">View Receipt</a>` : '<span class="no-receipt">No digital receipt</span>'}
                    </td>
                    <td class="items-col">${lineItemsHtml}</td>
                    <td class="qualifying-col">
                        <div class="qualifying-item">
                            <strong>${p.qualifyingItem.itemName || 'Unknown'}</strong>
                            ${p.qualifyingItem.sku ? `<div class="sku">SKU: ${p.qualifyingItem.sku}</div>` : ''}
                        </div>
                    </td>
                    <td class="payment-col">${p.paymentType || 'Unknown'}</td>
                    <td class="total-col">${formatCents(p.orderTotal)}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="redemption-card" id="redemption-${index + 1}">
                <div class="card-header">
                    <h2>Redemption #${index + 1}</h2>
                    <div class="reward-id">ID: ${r.rewardId}</div>
                </div>

                <div class="info-sections">
                    <div class="info-section customer-section">
                        <h3>Customer Information</h3>
                        <div class="info-grid">
                            <div class="info-item">
                                <label>Name</label>
                                <span>${r.customer.displayName}</span>
                            </div>
                            <div class="info-item">
                                <label>Phone</label>
                                <span>${r.customer.phoneLastFour || 'Not on file'}</span>
                            </div>
                            <div class="info-item">
                                <label>Email</label>
                                <span>${r.customer.emailTruncated || 'Not on file'}</span>
                            </div>
                            <div class="info-item">
                                <label>Customer ID</label>
                                <span class="monospace">${r.customer.squareCustomerId}</span>
                            </div>
                        </div>
                    </div>

                    <div class="info-section redemption-section">
                        <h3>Redemption Details</h3>
                        <div class="info-grid">
                            <div class="info-item">
                                <label>Pickup Date/Time</label>
                                <span>${formatDate(r.redemptionDate)}</span>
                            </div>
                            <div class="info-item">
                                <label>Order ID</label>
                                <span class="monospace">${r.redemptionOrderId || 'N/A'}</span>
                            </div>
                            <div class="info-item">
                                <label>Free Item</label>
                                <span>${r.redeemedItem.name || 'Unknown'}${r.redeemedItem.variation ? ` - ${r.redeemedItem.variation}` : ''}</span>
                            </div>
                            <div class="info-item">
                                <label>SKU</label>
                                <span>${r.redeemedItem.sku || 'N/A'}</span>
                            </div>
                            <div class="info-item highlight">
                                <label>Retail Value</label>
                                <span class="value">${formatCents(r.redeemedItem.retailValueCents)}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="purchases-section">
                    <h3>Contributing Purchases (${r.summary.qualifyingPurchaseCount} orders that earned this reward)</h3>
                    <table class="purchases-table">
                        <thead>
                            <tr>
                                <th>Date/Time</th>
                                <th>Order ID / Receipt</th>
                                <th>All Items on Order</th>
                                <th>Qualifying Item</th>
                                <th>Payment</th>
                                <th>Order Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${purchaseRows}
                        </tbody>
                    </table>
                </div>

                <div class="summary-section">
                    <h3>Customer Summary for This Redemption</h3>
                    <div class="summary-grid">
                        <div class="summary-item">
                            <label>Total Customer Spend</label>
                            <span class="value">${formatCents(r.summary.totalSpendCents)}</span>
                        </div>
                        <div class="summary-item">
                            <label>Average Order Value</label>
                            <span>${formatCents(r.summary.averageOrderValueCents)}</span>
                        </div>
                        <div class="summary-item">
                            <label>Time from First to Redemption</label>
                            <span>${r.summary.timeSpanDays} days</span>
                        </div>
                        <div class="summary-item">
                            <label>Number of Visits</label>
                            <span>${r.summary.visitCount}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('<div class="page-break"></div>');

    // Determine brand name for title
    const brandNames = [...new Set(report.redemptions.map(r => r.offer.brandName))];
    const brandTitle = brandNames.length === 1 ? brandNames[0] : 'Multi-Brand';

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Brand Redemption Report - ${brandTitle}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 11px;
            line-height: 1.4;
            color: #333;
            padding: 20px;
            max-width: 1100px;
            margin: 0 auto;
            background: #f5f5f5;
        }
        .report-header {
            background: linear-gradient(135deg, #1a5f7a 0%, #2d8eb8 100%);
            color: white;
            padding: 25px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }
        .report-header h1 {
            font-size: 24px;
            margin-bottom: 8px;
        }
        .report-header .subtitle {
            font-size: 14px;
            opacity: 0.9;
        }
        .report-header .meta {
            margin-top: 15px;
            font-size: 12px;
            opacity: 0.8;
        }
        .overall-summary {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .overall-summary .stat {
            text-align: center;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
        }
        .overall-summary .stat label {
            display: block;
            font-size: 10px;
            text-transform: uppercase;
            color: #666;
            margin-bottom: 5px;
        }
        .overall-summary .stat .value {
            font-size: 24px;
            font-weight: bold;
            color: #1a5f7a;
        }
        .redemption-card {
            background: white;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .card-header {
            background: #f8f9fa;
            padding: 15px 20px;
            border-bottom: 1px solid #eee;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .card-header h2 {
            font-size: 16px;
            color: #333;
        }
        .card-header .reward-id {
            font-size: 10px;
            color: #999;
            font-family: monospace;
        }
        .info-sections {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            padding: 20px;
        }
        .info-section {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
        }
        .info-section h3 {
            font-size: 12px;
            text-transform: uppercase;
            color: #666;
            margin-bottom: 12px;
            border-bottom: 1px solid #ddd;
            padding-bottom: 8px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .info-item {
            padding: 8px;
            background: white;
            border-radius: 4px;
        }
        .info-item label {
            display: block;
            font-size: 9px;
            text-transform: uppercase;
            color: #888;
            margin-bottom: 3px;
        }
        .info-item span {
            font-size: 12px;
            color: #333;
        }
        .info-item.highlight {
            background: #e8f5e9;
            grid-column: span 2;
        }
        .info-item.highlight .value {
            font-size: 18px;
            font-weight: bold;
            color: #2e7d32;
        }
        .monospace {
            font-family: monospace;
            font-size: 10px !important;
        }
        .purchases-section {
            padding: 20px;
        }
        .purchases-section h3 {
            font-size: 12px;
            text-transform: uppercase;
            color: #666;
            margin-bottom: 15px;
        }
        .purchases-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10px;
        }
        .purchases-table th {
            background: #1a5f7a;
            color: white;
            padding: 10px 8px;
            text-align: left;
            font-weight: 500;
        }
        .purchases-table td {
            padding: 10px 8px;
            border-bottom: 1px solid #eee;
            vertical-align: top;
        }
        .purchases-table tr:nth-child(even) {
            background: #fafafa;
        }
        .purchases-table .refund-row {
            background: #ffebee !important;
        }
        .date-col { width: 120px; }
        .order-col { width: 130px; }
        .items-col { width: auto; }
        .qualifying-col { width: 150px; }
        .payment-col { width: 70px; }
        .total-col { width: 80px; text-align: right; }
        .order-id {
            font-family: monospace;
            font-size: 9px;
            color: #666;
        }
        .receipt-link {
            font-size: 9px;
            color: #1a5f7a;
        }
        .no-receipt {
            font-size: 9px;
            color: #999;
            font-style: italic;
        }
        .line-items-list {
            max-height: 100px;
            overflow-y: auto;
        }
        .line-item {
            padding: 3px 6px;
            margin-bottom: 2px;
            background: #f5f5f5;
            border-radius: 3px;
            font-size: 9px;
        }
        .line-item.qualifying {
            background: #e3f2fd;
            border-left: 3px solid #1a5f7a;
        }
        .item-name {
            display: block;
            font-weight: 500;
        }
        .item-details {
            color: #666;
        }
        .qualifying-item .sku {
            font-size: 9px;
            color: #666;
            font-family: monospace;
        }
        .summary-section {
            padding: 20px;
            background: #e8f5e9;
            border-top: 2px solid #c8e6c9;
        }
        .summary-section h3 {
            font-size: 12px;
            text-transform: uppercase;
            color: #2e7d32;
            margin-bottom: 15px;
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
        }
        .summary-item {
            background: white;
            padding: 12px;
            border-radius: 6px;
            text-align: center;
        }
        .summary-item label {
            display: block;
            font-size: 9px;
            text-transform: uppercase;
            color: #666;
            margin-bottom: 5px;
        }
        .summary-item .value {
            font-size: 18px;
            font-weight: bold;
            color: #2e7d32;
        }
        .summary-item span:not(.value) {
            font-size: 14px;
            font-weight: 500;
            color: #333;
        }
        .page-break {
            page-break-before: always;
            height: 20px;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #999;
            font-size: 10px;
        }
        @media print {
            body {
                background: white;
                padding: 0;
            }
            .redemption-card {
                box-shadow: none;
                border: 1px solid #ddd;
            }
            .page-break {
                page-break-before: always;
            }
        }
    </style>
</head>
<body>
    <div class="report-header">
        <h1>Brand Redemption Report</h1>
        <div class="subtitle">${brandTitle} Frequent Buyer Program - Proof of Purchase Documentation</div>
        <div class="meta">
            Generated on ${formatDate(new Date())} |
            ${report.summary.dateRange.earliest ? `Redemptions from ${formatDate(report.summary.dateRange.earliest)} to ${formatDate(report.summary.dateRange.latest)}` : 'No date range'}
        </div>
    </div>

    <div class="overall-summary">
        <div class="stat">
            <label>Total Redemptions</label>
            <span class="value">${report.summary.totalRedemptions}</span>
        </div>
        <div class="stat">
            <label>Total Retail Value</label>
            <span class="value">${formatCents(report.summary.totalValue)}</span>
        </div>
        <div class="stat">
            <label>Unique Customers</label>
            <span class="value">${report.summary.uniqueCustomers}</span>
        </div>
        <div class="stat">
            <label>Merchant</label>
            <span class="value" style="font-size: 14px;">${report.redemptions[0]?.merchantName || 'N/A'}</span>
        </div>
    </div>

    ${redemptionCards}

    <div class="footer">
        <p>This report is generated for brand reimbursement and compliance purposes.</p>
        <p>Powered by Square Dashboard Tool - Loyalty Program</p>
    </div>
</body>
</html>
`;

    return {
        html,
        data: report,
        filename: `brand-redemption-report-${brandTitle.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.html`
    };
}

// ============================================================================
// CSV EXPORT
// ============================================================================

/**
 * Generate CSV export with one row per qualifying purchase, grouped by redemption
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Export options
 */
async function generateBrandRedemptionCSV(merchantId, options = {}) {
    const report = await buildBrandRedemptionReport(merchantId, {
        ...options,
        includeFullOrders: true
    });

    if (report.redemptions.length === 0) {
        return {
            csv: UTF8_BOM + 'No redemptions found for the specified criteria',
            filename: `brand-redemption-export-${Date.now()}.csv`,
            count: 0
        };
    }

    const headers = [
        // Redemption info
        'Redemption ID',
        'Redemption Date',
        'Brand',
        'Offer Name',
        'Size Group',
        // Customer info (privacy-aware)
        'Customer Name',
        'Phone (Last 4)',
        'Email (Truncated)',
        'Customer ID',
        // Redeemed item
        'Free Item Name',
        'Free Item SKU',
        'Free Item Retail Value ($)',
        // Contributing purchase info
        'Purchase #',
        'Purchase Date',
        'Order ID',
        'Qualifying Item Name',
        'Qualifying Item SKU',
        'Qualifying Qty',
        'Qualifying Unit Price ($)',
        'Payment Type',
        'Order Total ($)',
        'Receipt URL',
        'All Items on Order',
        // Summary (only on first row per redemption)
        'Total Customer Spend ($)',
        'Avg Order Value ($)',
        'Days to Redemption',
        'Visit Count'
    ];

    const rows = [];

    for (const redemption of report.redemptions) {
        redemption.contributingPurchases.forEach((purchase, purchaseIndex) => {
            // Format all line items as a single cell
            let allItemsText = '';
            if (purchase.allLineItems && purchase.allLineItems.length > 0) {
                allItemsText = purchase.allLineItems.map(item =>
                    `${item.name}${item.variationName ? ' - ' + item.variationName : ''} x${item.quantity} @ $${((item.unitPriceCents || 0) / 100).toFixed(2)}`
                ).join('; ');
            }

            rows.push([
                redemption.rewardId,
                redemption.redemptionDate ? new Date(redemption.redemptionDate).toISOString() : '',
                redemption.offer.brandName,
                redemption.offer.name,
                redemption.offer.sizeGroup,
                redemption.customer.displayName,
                redemption.customer.phoneLastFour || '',
                redemption.customer.emailTruncated || '',
                redemption.customer.squareCustomerId,
                redemption.redeemedItem.name || '',
                redemption.redeemedItem.sku || '',
                redemption.redeemedItem.retailValueCents
                    ? (redemption.redeemedItem.retailValueCents / 100).toFixed(2)
                    : '',
                purchaseIndex + 1,
                purchase.purchasedAt ? new Date(purchase.purchasedAt).toISOString() : '',
                purchase.orderId || '',
                purchase.qualifyingItem.itemName || '',
                purchase.qualifyingItem.sku || '',
                purchase.qualifyingItem.quantity,
                purchase.qualifyingItem.unitPriceCents
                    ? (purchase.qualifyingItem.unitPriceCents / 100).toFixed(2)
                    : '',
                purchase.paymentType || '',
                purchase.orderTotal ? (purchase.orderTotal / 100).toFixed(2) : '',
                purchase.receiptUrl || '',
                allItemsText,
                // Summary only on first row
                purchaseIndex === 0 ? (redemption.summary.totalSpendCents / 100).toFixed(2) : '',
                purchaseIndex === 0 ? (redemption.summary.averageOrderValueCents / 100).toFixed(2) : '',
                purchaseIndex === 0 ? redemption.summary.timeSpanDays : '',
                purchaseIndex === 0 ? redemption.summary.visitCount : ''
            ]);
        });
    }

    const csv = UTF8_BOM + [
        headers.map(h => escapeCSVField(h)).join(','),
        ...rows.map(row => row.map(cell => escapeCSVField(String(cell ?? ''))).join(','))
    ].join('\n');

    // Determine brand for filename
    const brandNames = [...new Set(report.redemptions.map(r => r.offer.brandName))];
    const brandSlug = brandNames.length === 1
        ? brandNames[0].toLowerCase().replace(/\s+/g, '-')
        : 'multi-brand';

    return {
        csv,
        filename: `brand-redemption-${brandSlug}-${new Date().toISOString().split('T')[0]}.csv`,
        count: rows.length,
        redemptionCount: report.redemptions.length
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Privacy formatting (exported for testing)
    formatPrivacyName,
    formatPrivacyPhone,
    formatPrivacyEmail,

    // Data queries
    getBrandRedemptions,
    getContributingPurchases,
    buildBrandRedemptionReport,

    // Report generation
    generateBrandRedemptionHTML,
    generateBrandRedemptionCSV
};
