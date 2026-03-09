/**
 * Tests for Loyalty Reports Service
 *
 * Covers:
 * - Fix 1: Redemption order section shows error placeholder on Square API failure
 * - Fix 2: CSV export selects redemption_type and admin_notes from DB
 * - Fix 3: variation_vendors JOIN includes merchant_id filter
 * - Fix 4: Number() used instead of parseInt() for BigInt money amounts
 * - Fix 5: getMerchantLocaleConfig returns merchant locale settings
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Mock database
jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn()
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock Square client
const mockSquareClient = {
    merchants: { get: jest.fn() },
    locations: { list: jest.fn() },
    orders: { get: jest.fn() }
};

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient)
}));

// Mock privacy-format
jest.mock('../../utils/privacy-format', () => ({
    formatPrivacyName: (first, last) => first ? `${first} ${last ? last[0] + '.' : ''}` : 'Customer',
    formatPrivacyPhone: (phone) => phone ? `***-${phone.slice(-4)}` : null,
    formatPrivacyEmail: (email) => email || null,
    formatReportDate: (date) => date ? new Date(date).toISOString().split('T')[0] : 'N/A',
    formatCents: (cents) => cents != null ? `$${(cents / 100).toFixed(2)}` : 'N/A',
    escapeHtml: (text) => String(text ?? '')
}));

// Mock csv-helpers
jest.mock('../../utils/csv-helpers', () => ({
    formatMoney: jest.fn(),
    escapeCSVField: (val) => `"${String(val).replace(/"/g, '""')}"`,
    UTF8_BOM: '\uFEFF'
}));

const {
    getRedemptionDetails,
    generateVendorReceipt,
    generateRedemptionsCSV,
    getRedemptionsForExport
} = require('../../services/reports/loyalty-reports');

// ============================================================================
// Fix 1: Redemption order section error placeholder
// ============================================================================

describe('Fix 1: Redemption order error placeholder', () => {
    const merchantId = 1;
    const rewardId = 'reward-uuid-123';

    const baseRedemption = {
        id: rewardId,
        merchant_id: merchantId,
        offer_id: 1,
        square_customer_id: 'CUST_1',
        redeemed_at: '2026-03-01T12:00:00Z',
        square_order_id: 'ORDER_REDEEM_1',
        current_quantity: 8,
        required_quantity: 8,
        window_start_date: '2025-12-01',
        window_end_date: '2026-06-01',
        earned_at: '2026-02-28T10:00:00Z',
        vendor_credit_status: null,
        vendor_credit_submitted_at: null,
        vendor_credit_resolved_at: null,
        vendor_credit_notes: null,
        offer_name: 'Buy 8 Get 1 Free',
        brand_name: 'Acme Dog Food',
        size_group: 'Large',
        window_months: 6,
        vendor_id: 'V1',
        vendor_name: 'Acme',
        vendor_email: 'acme@example.com',
        business_name: 'Test Pet Store',
        business_email: 'store@example.com',
        given_name: 'Jane',
        family_name: 'Doe',
        phone_number: '5551234567',
        email_address: 'jane@example.com',
        redeemed_item_name: 'Acme Dog Food',
        redeemed_variation_name: '15kg',
        redeemed_variation_id: 'VAR_1',
        redeemed_value_cents: 5999
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Default: redemption found
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM loyalty_rewards r')) {
                return { rows: [baseRedemption] };
            }
            if (sql.includes('FROM loyalty_purchase_events pe')) {
                return { rows: [] };
            }
            if (sql.includes('MIN(unit_price_cents)')) {
                return { rows: [{ lowest_price_cents: 5999 }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) {
                return { rows: [{ variation_id: 'VAR_1' }] };
            }
            if (sql.includes('FROM variations v')) {
                return { rows: [{ vendor_item_number: 'VN-001', wholesale_cost_cents: 3500 }] };
            }
            return { rows: [] };
        });

        // Default: Square merchant info fails gracefully
        mockSquareClient.merchants.get.mockRejectedValue(new Error('test'));
        mockSquareClient.locations.list.mockRejectedValue(new Error('test'));
    });

    test('shows error placeholder when redemption order fetch fails', async () => {
        // Make the redemption order fetch fail
        mockSquareClient.orders.get.mockRejectedValue(
            new Error('UNAUTHORIZED: Token expired')
        );

        const result = await generateVendorReceipt(rewardId, merchantId);

        // The HTML should contain the error placeholder, not silently omit
        expect(result.html).toContain('Data Unavailable');
        expect(result.html).toContain('ORDER_REDEEM_1');
        expect(result.html).toContain('UNAUTHORIZED: Token expired');
        expect(result.html).not.toContain('REDEMPTION ORDER — Free Item Received');
    });

    test('shows normal redemption section when fetch succeeds', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{
                    name: 'Acme Dog Food',
                    variationName: '15kg',
                    catalogObjectId: 'VAR_1',
                    quantity: '1',
                    basePriceMoney: { amount: 5999n, currency: 'CAD' },
                    totalMoney: { amount: 0n, currency: 'CAD' }
                }],
                tenders: [{ type: 'CARD' }],
                totalMoney: { amount: 0n, currency: 'CAD' }
            }
        });

        const result = await generateVendorReceipt(rewardId, merchantId);

        expect(result.html).toContain('REDEMPTION ORDER');
        expect(result.html).not.toContain('Data Unavailable');
    });

    test('logs warning (not debug) when redemption order fetch fails', async () => {
        mockSquareClient.orders.get.mockRejectedValue(
            new Error('API error')
        );

        await generateVendorReceipt(rewardId, merchantId);

        expect(logger.warn).toHaveBeenCalledWith(
            'Failed to fetch redemption order for receipt',
            expect.objectContaining({
                orderId: 'ORDER_REDEEM_1',
                error: 'API error'
            })
        );
    });
});

// ============================================================================
// Fix 2: CSV export selects redemption_type and admin_notes
// ============================================================================

describe('Fix 2: CSV export redemption_type and admin_notes', () => {
    const merchantId = 1;

    test('SQL query selects lr.redemption_type and lr.admin_notes', async () => {
        db.query.mockResolvedValue({
            rows: [{
                id: 'reward-1',
                redeemed_at: '2026-03-01T12:00:00Z',
                brand_name: 'Acme',
                size_group: 'Large',
                offer_name: 'Buy 8',
                square_customer_id: 'CUST_1',
                redemption_type: 'order_discount',
                admin_notes: 'Approved by manager',
                square_order_id: 'ORD_1',
                redeemed_item_name: 'Dog Food',
                redeemed_variation_name: '15kg',
                redeemed_value_cents: 5999,
                window_start_date: '2025-12-01',
                window_end_date: '2026-06-01',
                earned_at: '2026-02-28T10:00:00Z',
                offer_required_quantity: 8,
                business_name: 'Test Store'
            }]
        });

        const result = await generateRedemptionsCSV(merchantId);

        // Verify the SQL includes redemption_type and admin_notes columns
        const sqlCall = db.query.mock.calls[0][0];
        expect(sqlCall).toContain('lr.redemption_type');
        expect(sqlCall).toContain('lr.admin_notes');

        // Verify the CSV uses DB values not defaults
        expect(result.csv).toContain('order_discount');
        expect(result.csv).toContain('Approved by manager');
    });

    test('falls back to auto_detected when redemption_type is null', async () => {
        db.query.mockResolvedValue({
            rows: [{
                id: 'reward-1',
                redeemed_at: '2026-03-01T12:00:00Z',
                brand_name: 'Acme',
                size_group: 'Large',
                offer_name: 'Buy 8',
                square_customer_id: 'CUST_1',
                redemption_type: null,
                admin_notes: null,
                square_order_id: null,
                redeemed_item_name: null,
                redeemed_variation_name: null,
                redeemed_value_cents: null,
                window_start_date: null,
                window_end_date: null,
                earned_at: null,
                offer_required_quantity: 8,
                business_name: 'Test Store'
            }]
        });

        const result = await generateRedemptionsCSV(merchantId);
        expect(result.csv).toContain('auto_detected');
    });
});

// ============================================================================
// Fix 3: variation_vendors JOIN includes merchant_id filter
// ============================================================================

describe('Fix 3: variation_vendors merchant_id filter', () => {
    const merchantId = 1;
    const rewardId = 'reward-uuid-123';

    test('getRedemptionDetails JOIN includes merchant_id on variation_vendors', async () => {
        // Must return a redemption row so the function proceeds to the purchases query
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM loyalty_rewards r')) {
                return { rows: [{ id: rewardId, merchant_id: merchantId, offer_id: 1, square_order_id: null }] };
            }
            return { rows: [] };
        });

        await getRedemptionDetails(rewardId, merchantId);

        // Check the purchases query includes merchant_id in variation_vendors JOIN
        const purchaseQueryCalls = db.query.mock.calls.filter(
            call => call[0].includes('FROM loyalty_purchase_events pe') && call[0].includes('variation_vendors')
        );

        expect(purchaseQueryCalls.length).toBeGreaterThan(0);
        const sql = purchaseQueryCalls[0][0];
        expect(sql).toContain('vv.merchant_id = pe.merchant_id');
    });

    test('getRedemptionDetails redemptions JOIN includes merchant_id', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getRedemptionDetails(rewardId, merchantId);

        // Check the main query includes merchant_id on loyalty_redemptions JOIN
        const mainQueryCalls = db.query.mock.calls.filter(
            call => call[0].includes('FROM loyalty_rewards r')
        );

        if (mainQueryCalls.length > 0) {
            const sql = mainQueryCalls[0][0];
            expect(sql).toContain('lr.merchant_id = r.merchant_id');
        }
    });

    test('getRedemptionsForExport redemptions JOIN includes merchant_id', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getRedemptionsForExport(merchantId);

        const call = db.query.mock.calls[0];
        const sql = call[0];
        expect(sql).toContain('lr.merchant_id = r.merchant_id');
    });
});

// ============================================================================
// Fix 4: Number() instead of parseInt() for BigInt money amounts
// ============================================================================

describe('Fix 4: Number() handles BigInt money amounts', () => {
    const merchantId = 1;
    const rewardId = 'reward-uuid-123';

    const baseRedemption = {
        id: rewardId,
        merchant_id: merchantId,
        offer_id: 1,
        square_customer_id: 'CUST_1',
        redeemed_at: '2026-03-01T12:00:00Z',
        square_order_id: 'ORDER_1',
        current_quantity: 8,
        required_quantity: 8,
        window_start_date: '2025-12-01',
        window_end_date: '2026-06-01',
        earned_at: '2026-02-28T10:00:00Z',
        vendor_credit_status: null,
        vendor_credit_submitted_at: null,
        vendor_credit_resolved_at: null,
        vendor_credit_notes: null,
        offer_name: 'Buy 8 Get 1 Free',
        brand_name: 'Acme',
        size_group: 'Large',
        window_months: 6,
        vendor_id: 'V1',
        vendor_name: 'Acme',
        vendor_email: null,
        business_name: 'Test Store',
        business_email: null,
        given_name: 'Jane',
        family_name: 'Doe',
        phone_number: null,
        email_address: null,
        redeemed_item_name: 'Dog Food',
        redeemed_variation_name: '15kg',
        redeemed_variation_id: 'VAR_1',
        redeemed_value_cents: 5999
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockSquareClient.merchants.get.mockRejectedValue(new Error('test'));
        mockSquareClient.locations.list.mockRejectedValue(new Error('test'));
    });

    test('correctly handles BigInt .amount values from Square SDK v43+', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM loyalty_rewards r')) {
                return { rows: [baseRedemption] };
            }
            if (sql.includes('FROM loyalty_purchase_events pe')) {
                return {
                    rows: [{
                        id: 1,
                        variation_id: 'VAR_1',
                        square_order_id: 'ORD_1',
                        quantity: 1,
                        unit_price_cents: 5999,
                        item_name: 'Dog Food',
                        variation_name: '15kg',
                        purchased_at: '2026-01-15',
                        payment_type: null,
                        wholesale_cost_cents: null,
                        vendor_item_number: null,
                        vendor_unit_cost: null,
                        merchant_id: merchantId
                    }]
                };
            }
            if (sql.includes('MIN(unit_price_cents)')) {
                return { rows: [{ lowest_price_cents: 5999 }] };
            }
            return { rows: [] };
        });

        // Return order with BigInt amounts (SDK v43+)
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{
                    name: 'Dog Food',
                    variationName: '15kg',
                    catalogObjectId: 'VAR_1',
                    quantity: '1',
                    basePriceMoney: { amount: 5999n, currency: 'CAD' },
                    totalMoney: { amount: 5999n, currency: 'CAD' }
                }],
                tenders: [{ type: 'CARD' }],
                totalMoney: { amount: 5999n, currency: 'CAD' }
            }
        });

        const data = await getRedemptionDetails(rewardId, merchantId);

        // Verify the BigInt amounts were correctly converted
        const purchase = data.contributingPurchases[0];
        expect(purchase.order_total_cents).toBe(5999);
        expect(typeof purchase.order_total_cents).toBe('number');

        const lineItem = purchase.allLineItems[0];
        expect(lineItem.unitPriceCents).toBe(5999);
        expect(lineItem.totalCents).toBe(5999);
        expect(typeof lineItem.unitPriceCents).toBe('number');
    });

    test('correctly handles regular number .amount values', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM loyalty_rewards r')) {
                return { rows: [baseRedemption] };
            }
            if (sql.includes('FROM loyalty_purchase_events pe')) {
                return {
                    rows: [{
                        id: 1,
                        variation_id: 'VAR_1',
                        square_order_id: 'ORD_1',
                        quantity: 1,
                        unit_price_cents: 5999,
                        item_name: 'Dog Food',
                        variation_name: '15kg',
                        purchased_at: '2026-01-15',
                        payment_type: null,
                        wholesale_cost_cents: null,
                        vendor_item_number: null,
                        vendor_unit_cost: null,
                        merchant_id: merchantId
                    }]
                };
            }
            if (sql.includes('MIN(unit_price_cents)')) {
                return { rows: [{ lowest_price_cents: 5999 }] };
            }
            return { rows: [] };
        });

        // Return order with regular number amounts (older SDK)
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{
                    name: 'Dog Food',
                    variationName: '15kg',
                    catalogObjectId: 'VAR_1',
                    quantity: '1',
                    basePriceMoney: { amount: 5999, currency: 'CAD' },
                    totalMoney: { amount: 5999, currency: 'CAD' }
                }],
                tenders: [{ type: 'CARD' }],
                totalMoney: { amount: 5999, currency: 'CAD' }
            }
        });

        const data = await getRedemptionDetails(rewardId, merchantId);

        const purchase = data.contributingPurchases[0];
        expect(purchase.order_total_cents).toBe(5999);

        const lineItem = purchase.allLineItems[0];
        expect(lineItem.unitPriceCents).toBe(5999);
        expect(lineItem.totalCents).toBe(5999);
    });

    test('handles zero amount BigInt without treating as falsy', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('FROM loyalty_rewards r')) {
                return { rows: [baseRedemption] };
            }
            if (sql.includes('FROM loyalty_purchase_events pe')) {
                return {
                    rows: [{
                        id: 1,
                        variation_id: 'VAR_1',
                        square_order_id: 'ORD_1',
                        quantity: 1,
                        unit_price_cents: 0,
                        item_name: 'Free Item',
                        variation_name: '15kg',
                        purchased_at: '2026-01-15',
                        payment_type: null,
                        wholesale_cost_cents: null,
                        vendor_item_number: null,
                        vendor_unit_cost: null,
                        merchant_id: merchantId
                    }]
                };
            }
            if (sql.includes('MIN(unit_price_cents)')) {
                return { rows: [{ lowest_price_cents: 0 }] };
            }
            return { rows: [] };
        });

        // BigInt zero - Number(0n) === 0, but parseInt(0n) also works
        // The key fix: `!= null` instead of truthy check, so 0n is preserved as 0
        mockSquareClient.orders.get.mockResolvedValue({
            order: {
                lineItems: [{
                    name: 'Free Item',
                    catalogObjectId: 'VAR_1',
                    quantity: '1',
                    basePriceMoney: { amount: 0n, currency: 'CAD' },
                    totalMoney: { amount: 0n, currency: 'CAD' }
                }],
                totalMoney: { amount: 0n, currency: 'CAD' }
            }
        });

        const data = await getRedemptionDetails(rewardId, merchantId);

        const purchase = data.contributingPurchases[0];
        // With `!= null` check, 0n is not null, so Number(0n) = 0
        expect(purchase.order_total_cents).toBe(0);

        const lineItem = purchase.allLineItems[0];
        expect(lineItem.unitPriceCents).toBe(0);
        expect(lineItem.totalCents).toBe(0);
    });
});

// ============================================================================
// Fix 5: getMerchantLocaleConfig
// ============================================================================

describe('Fix 5: getMerchantLocaleConfig', () => {
    // Need to require directly since settings-service has its own db import
    let getMerchantLocaleConfig;

    beforeEach(() => {
        jest.clearAllMocks();
        // Clear module cache to get fresh import
        jest.isolateModules(() => {
            getMerchantLocaleConfig = require('../../services/merchant/settings-service').getMerchantLocaleConfig;
        });
    });

    test('returns merchant locale config from database', async () => {
        db.query.mockResolvedValue({
            rows: [{
                timezone: 'America/Vancouver',
                currency: 'USD',
                locale: 'en-US'
            }]
        });

        const config = await getMerchantLocaleConfig(1);

        expect(config.timezone).toBe('America/Vancouver');
        expect(config.currency).toBe('USD');
        expect(config.locale).toBe('en-US');
        expect(db.query).toHaveBeenCalledWith(
            'SELECT timezone, currency, locale FROM merchants WHERE id = $1',
            [1]
        );
    });

    test('returns CAD/Toronto/en-CA defaults when merchant has no config', async () => {
        db.query.mockResolvedValue({ rows: [{}] });

        const config = await getMerchantLocaleConfig(99);

        expect(config.timezone).toBe('America/Toronto');
        expect(config.currency).toBe('CAD');
        expect(config.locale).toBe('en-CA');
    });

    test('returns CAD/Toronto/en-CA defaults when merchant not found', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const config = await getMerchantLocaleConfig(999);

        expect(config.timezone).toBe('America/Toronto');
        expect(config.currency).toBe('CAD');
        expect(config.locale).toBe('en-CA');
    });
});
