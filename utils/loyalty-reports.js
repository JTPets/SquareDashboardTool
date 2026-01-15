/**
 * Square Loyalty Addon - Report Generation Module
 *
 * Generates vendor receipts and audit exports for loyalty program redemptions.
 * This is a FIRST-CLASS FEATURE for vendor reimbursement compliance.
 *
 * Report Types:
 * - Vendor Receipt: Human-readable transaction report per redemption
 * - Audit Export: Detailed transaction history with all contributing purchases
 *
 * Output Formats:
 * - PDF: Printable vendor receipts
 * - CSV: Machine-readable audit exports
 */

const db = require('./database');
const logger = require('./logger');
const path = require('path');
const fs = require('fs').promises;
const { formatMoney, escapeCSVField, UTF8_BOM } = require('./csv-helpers');

// ============================================================================
// REPORT DATA QUERIES
// ============================================================================

/**
 * Get complete redemption details for vendor receipt
 * @param {string} redemptionId - Redemption UUID
 * @param {number} merchantId - Merchant ID for tenant isolation
 * @returns {Promise<Object>} Complete redemption data
 */
async function getRedemptionDetails(redemptionId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Get redemption with reward and offer details
    const redemptionResult = await db.query(`
        SELECT
            rd.*,
            r.current_quantity,
            r.required_quantity,
            r.window_start_date,
            r.window_end_date,
            r.earned_at,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.window_months,
            m.business_name,
            m.business_email,
            u.name as redeemed_by_name
        FROM loyalty_redemptions rd
        JOIN loyalty_rewards r ON rd.reward_id = r.id
        JOIN loyalty_offers o ON rd.offer_id = o.id
        JOIN merchants m ON rd.merchant_id = m.id
        LEFT JOIN users u ON rd.redeemed_by_user_id = u.id
        WHERE rd.id = $1 AND rd.merchant_id = $2
    `, [redemptionId, merchantId]);

    if (redemptionResult.rows.length === 0) {
        return null;
    }

    const redemption = redemptionResult.rows[0];

    // Get all contributing purchase events for this reward
    const purchasesResult = await db.query(`
        SELECT
            pe.*,
            qv.item_name,
            qv.variation_name,
            qv.sku
        FROM loyalty_purchase_events pe
        LEFT JOIN loyalty_qualifying_variations qv
            ON pe.variation_id = qv.variation_id AND qv.merchant_id = pe.merchant_id
        WHERE pe.reward_id = $1 AND pe.merchant_id = $2
        ORDER BY pe.purchased_at ASC
    `, [redemption.reward_id, merchantId]);

    return {
        ...redemption,
        contributingPurchases: purchasesResult.rows
    };
}

/**
 * Get redemptions for export with filters
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
            rd.*,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.required_quantity as offer_required_quantity,
            r.window_start_date,
            r.window_end_date,
            r.earned_at,
            m.business_name
        FROM loyalty_redemptions rd
        JOIN loyalty_rewards r ON rd.reward_id = r.id
        JOIN loyalty_offers o ON rd.offer_id = o.id
        JOIN merchants m ON rd.merchant_id = m.id
        WHERE rd.merchant_id = $1
    `;
    const params = [merchantId];

    if (startDate) {
        params.push(startDate);
        query += ` AND rd.redeemed_at >= $${params.length}`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND rd.redeemed_at <= $${params.length}`;
    }

    if (offerId) {
        params.push(offerId);
        query += ` AND rd.offer_id = $${params.length}`;
    }

    if (brandName) {
        params.push(brandName);
        query += ` AND o.brand_name = $${params.length}`;
    }

    query += ` ORDER BY rd.redeemed_at DESC`;

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
 * @param {string} redemptionId - Redemption UUID
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Receipt data with HTML content
 */
async function generateVendorReceipt(redemptionId, merchantId) {
    const data = await getRedemptionDetails(redemptionId, merchantId);

    if (!data) {
        throw new Error('Redemption not found');
    }

    const formatDate = (date) => {
        if (!date) return 'N/A';
        return new Date(date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const formatCents = (cents) => {
        if (cents === null || cents === undefined) return 'N/A';
        return `$${(cents / 100).toFixed(2)}`;
    };

    // Build purchase history table rows
    const purchaseRows = data.contributingPurchases.map(p => `
        <tr>
            <td>${formatDate(p.purchased_at)}</td>
            <td>${p.item_name || 'Unknown'} - ${p.variation_name || p.variation_id}</td>
            <td>${p.sku || 'N/A'}</td>
            <td class="quantity">${p.quantity}</td>
            <td class="currency">${formatCents(p.unit_price_cents)}</td>
            <td>${p.square_order_id}</td>
        </tr>
    `).join('');

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
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 12px;
            line-height: 1.4;
            color: #333;
            padding: 20px;
            max-width: 800px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            border-bottom: 2px solid #333;
            padding-bottom: 15px;
            margin-bottom: 20px;
        }
        .header h1 {
            font-size: 24px;
            margin-bottom: 5px;
        }
        .header .subtitle {
            color: #666;
            font-size: 14px;
        }
        .receipt-number {
            font-family: monospace;
            font-size: 10px;
            color: #888;
            margin-top: 5px;
        }
        .section {
            margin-bottom: 20px;
        }
        .section h2 {
            font-size: 14px;
            color: #333;
            border-bottom: 1px solid #ddd;
            padding-bottom: 5px;
            margin-bottom: 10px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }
        .info-box {
            background: #f9f9f9;
            padding: 10px;
            border-radius: 4px;
        }
        .info-box label {
            font-weight: bold;
            font-size: 10px;
            text-transform: uppercase;
            color: #666;
            display: block;
            margin-bottom: 3px;
        }
        .info-box .value {
            font-size: 14px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }
        th {
            background: #333;
            color: white;
            padding: 8px 5px;
            text-align: left;
            font-weight: normal;
        }
        td {
            padding: 8px 5px;
            border-bottom: 1px solid #eee;
        }
        tr:nth-child(even) {
            background: #f9f9f9;
        }
        .quantity, .currency {
            text-align: right;
        }
        .summary {
            background: #f0f0f0;
            padding: 15px;
            margin-top: 20px;
            border-radius: 4px;
        }
        .summary-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
        }
        .summary-row.total {
            font-weight: bold;
            font-size: 14px;
            border-top: 1px solid #ccc;
            padding-top: 10px;
            margin-top: 10px;
        }
        .footer {
            margin-top: 30px;
            padding-top: 15px;
            border-top: 1px solid #ddd;
            font-size: 10px;
            color: #666;
            text-align: center;
        }
        .signature-line {
            margin-top: 40px;
            display: flex;
            justify-content: space-between;
        }
        .signature-box {
            width: 45%;
            border-top: 1px solid #333;
            padding-top: 5px;
            text-align: center;
            font-size: 10px;
        }
        @media print {
            body {
                padding: 0;
            }
            .no-print {
                display: none;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>VENDOR REDEMPTION RECEIPT</h1>
        <div class="subtitle">${data.brand_name} Frequent Buyer Program</div>
        <div class="receipt-number">Receipt ID: ${data.id}</div>
    </div>

    <div class="section">
        <h2>Merchant Information</h2>
        <div class="info-grid">
            <div class="info-box">
                <label>Business Name</label>
                <div class="value">${data.business_name}</div>
            </div>
            <div class="info-box">
                <label>Business Email</label>
                <div class="value">${data.business_email || 'N/A'}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Offer Details</h2>
        <div class="info-grid">
            <div class="info-box">
                <label>Brand</label>
                <div class="value">${data.brand_name}</div>
            </div>
            <div class="info-box">
                <label>Size Group</label>
                <div class="value">${data.size_group}</div>
            </div>
            <div class="info-box">
                <label>Program Name</label>
                <div class="value">${data.offer_name}</div>
            </div>
            <div class="info-box">
                <label>Program Type</label>
                <div class="value">Buy ${data.required_quantity} Get 1 Free</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Redemption Details</h2>
        <div class="info-grid">
            <div class="info-box">
                <label>Customer ID</label>
                <div class="value">${data.square_customer_id}</div>
            </div>
            <div class="info-box">
                <label>Redemption Date</label>
                <div class="value">${formatDate(data.redeemed_at)}</div>
            </div>
            <div class="info-box">
                <label>Redemption Type</label>
                <div class="value">${data.redemption_type.replace(/_/g, ' ').toUpperCase()}</div>
            </div>
            <div class="info-box">
                <label>Redeemed Item Value</label>
                <div class="value">${formatCents(data.redeemed_value_cents)}</div>
            </div>
            ${data.square_order_id ? `
            <div class="info-box">
                <label>Square Order ID</label>
                <div class="value">${data.square_order_id}</div>
            </div>
            ` : ''}
            ${data.redeemed_by_name ? `
            <div class="info-box">
                <label>Processed By</label>
                <div class="value">${data.redeemed_by_name}</div>
            </div>
            ` : ''}
        </div>
    </div>

    <div class="section">
        <h2>Earning Window</h2>
        <div class="info-grid">
            <div class="info-box">
                <label>Window Start</label>
                <div class="value">${formatDate(data.window_start_date)}</div>
            </div>
            <div class="info-box">
                <label>Window End</label>
                <div class="value">${formatDate(data.window_end_date)}</div>
            </div>
            <div class="info-box">
                <label>Reward Earned</label>
                <div class="value">${formatDate(data.earned_at)}</div>
            </div>
            <div class="info-box">
                <label>Window Duration</label>
                <div class="value">${data.window_months} months</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Contributing Transactions</h2>
        <table>
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Item</th>
                    <th>SKU</th>
                    <th>Qty</th>
                    <th>Unit Price</th>
                    <th>Order ID</th>
                </tr>
            </thead>
            <tbody>
                ${purchaseRows || '<tr><td colspan="6">No purchase records available</td></tr>'}
            </tbody>
        </table>
    </div>

    <div class="summary">
        <div class="summary-row">
            <span>Total Purchases:</span>
            <span>${totalPurchases} units</span>
        </div>
        <div class="summary-row">
            <span>Total Refunds:</span>
            <span>${totalRefunds} units</span>
        </div>
        <div class="summary-row">
            <span>Required Quantity:</span>
            <span>${data.required_quantity} units</span>
        </div>
        <div class="summary-row total">
            <span>Net Qualifying Purchases:</span>
            <span>${netQuantity} units</span>
        </div>
        <div class="summary-row total">
            <span>Reward Value:</span>
            <span>${formatCents(data.redeemed_value_cents)}</span>
        </div>
    </div>

    ${data.admin_notes ? `
    <div class="section" style="margin-top: 20px;">
        <h2>Notes</h2>
        <p>${data.admin_notes}</p>
    </div>
    ` : ''}

    <div class="signature-line">
        <div class="signature-box">
            Vendor Representative
        </div>
        <div class="signature-box">
            Date
        </div>
    </div>

    <div class="footer">
        <p>This receipt is generated for vendor reimbursement compliance purposes.</p>
        <p>Generated on ${formatDate(new Date())} | Receipt ID: ${data.id}</p>
        <p>Powered by Square Dashboard Addon Tool - Loyalty Program</p>
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
        r.redemption_type,
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
        'Is Refund'
    ];

    const rows = result.rows.map(r => [
        r.id,
        r.purchased_at ? new Date(r.purchased_at).toISOString() : '',
        r.is_refund ? 'REFUND' : 'PURCHASE',
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
        r.is_refund ? 'Yes' : 'No'
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

    let query = `
        SELECT
            o.brand_name,
            o.size_group,
            o.offer_name,
            o.required_quantity,
            COUNT(DISTINCT CASE WHEN r.status = 'earned' THEN r.id END) as pending_rewards,
            COUNT(DISTINCT CASE WHEN r.status = 'redeemed' THEN r.id END) as redeemed_rewards,
            COUNT(DISTINCT CASE WHEN r.status = 'revoked' THEN r.id END) as revoked_rewards,
            COALESCE(SUM(CASE WHEN r.status = 'redeemed' THEN rd.redeemed_value_cents END), 0) as total_redemption_value_cents,
            COUNT(DISTINCT r.square_customer_id) as unique_customers,
            COUNT(DISTINCT pe.id) as total_purchase_events
        FROM loyalty_offers o
        LEFT JOIN loyalty_rewards r ON o.id = r.offer_id
        LEFT JOIN loyalty_redemptions rd ON r.id = rd.reward_id
        LEFT JOIN loyalty_purchase_events pe ON o.id = pe.offer_id
        WHERE o.merchant_id = $1 AND o.is_active = TRUE
    `;
    const params = [merchantId];

    if (startDate) {
        params.push(startDate);
        query += ` AND (rd.redeemed_at IS NULL OR rd.redeemed_at >= $${params.length})`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND (rd.redeemed_at IS NULL OR rd.redeemed_at <= $${params.length})`;
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
