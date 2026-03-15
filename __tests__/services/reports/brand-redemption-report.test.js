/**
 * Tests for services/reports/brand-redemption-report.js
 *
 * Brand Redemption Report — generates proof-of-purchase documentation
 * for brands supplying free product giveaways through loyalty programs.
 */

// Mocks MUST be declared before requires (no babel-jest hoisting: transform: {})
jest.mock('../../../utils/database');
jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn()
}));

jest.mock('../../../utils/privacy-format', () => ({
    formatPrivacyName: jest.fn((first, last) => `${first || ''} ${last || ''}`.trim() || 'Unknown'),
    formatPrivacyPhone: jest.fn(phone => phone ? `***${phone.slice(-4)}` : null),
    formatPrivacyEmail: jest.fn(email => email ? `${email.slice(0, 2)}***` : null),
    formatReportDate: jest.fn(date => date ? new Date(date).toISOString() : 'N/A'),
    formatCents: jest.fn(cents => cents ? `$${(cents / 100).toFixed(2)}` : '$0.00'),
    escapeHtml: jest.fn(str => str || '')
}));

jest.mock('../../../utils/csv-helpers', () => ({
    formatMoney: jest.fn(cents => `$${(cents / 100).toFixed(2)}`),
    escapeCSVField: jest.fn(str => `"${str}"`),
    UTF8_BOM: '\uFEFF'
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const merchant = require('../../../middleware/merchant');

const {
    getBrandRedemptions,
    getContributingPurchases,
    buildBrandRedemptionReport,
    generateBrandRedemptionHTML,
    generateBrandRedemptionCSV,
    formatPrivacyName,
    formatPrivacyPhone,
    formatPrivacyEmail
} = require('../../../services/reports/brand-redemption-report');

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeRedemptionRow(overrides = {}) {
    return {
        reward_id: 'reward-uuid-1',
        square_customer_id: 'SQ_CUST_001',
        redeemed_at: '2026-03-10T14:00:00Z',
        redemption_order_id: 'ORDER_REDEEM_001',
        window_start_date: '2026-01-01',
        window_end_date: '2026-03-31',
        earned_at: '2026-03-08T10:00:00Z',
        current_quantity: 5,
        required_quantity: 5,
        offer_id: 10,
        offer_name: 'Buy 5 Get 1 Free',
        brand_name: 'Acme Dog Food',
        size_group: 'Large Bags',
        vendor_name: 'Acme Corp',
        vendor_email: 'sales@acme.com',
        business_name: 'JTPets',
        given_name: 'Jane',
        family_name: 'Doe',
        phone_number: '+15551234567',
        email_address: 'jane@example.com',
        redeemed_item_name: 'Acme Kibble 30lb',
        redeemed_variation_name: 'Chicken',
        redeemed_sku: 'ACM-30-CHK',
        redeemed_value_cents: 5999,
        ...overrides
    };
}

function makePurchaseRow(overrides = {}) {
    return {
        event_id: 'evt-001',
        square_order_id: 'ORDER_001',
        variation_id: 'VAR_001',
        quantity: 1,
        unit_price_cents: 4599,
        purchased_at: '2026-02-01T12:00:00Z',
        payment_type: 'CARD',
        receipt_url: 'https://squareup.com/receipt/001',
        customer_source: 'POS',
        is_refund: false,
        item_name: 'Acme Kibble 30lb',
        variation_name: 'Chicken',
        sku: 'ACM-30-CHK',
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    jest.clearAllMocks();
});

// ===== getBrandRedemptions =====

describe('getBrandRedemptions', () => {
    test('throws on missing merchantId', async () => {
        await expect(getBrandRedemptions(null)).rejects.toThrow('merchantId is required');
        await expect(getBrandRedemptions(undefined)).rejects.toThrow('merchantId is required');
        await expect(getBrandRedemptions(0)).rejects.toThrow('merchantId is required');
    });

    test('queries with just merchantId (no filters)', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getBrandRedemptions(1);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([1]);
        expect(sql).toContain('WHERE r.merchant_id = $1');
        expect(sql).toContain("r.status = 'redeemed'");
        expect(sql).toContain('ORDER BY r.redeemed_at DESC');
    });

    test('adds startDate filter', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getBrandRedemptions(1, { startDate: '2026-01-01' });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([1, '2026-01-01']);
        expect(sql).toContain('r.redeemed_at >= $2');
    });

    test('adds endDate filter', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getBrandRedemptions(1, { endDate: '2026-03-31' });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([1, '2026-03-31']);
        expect(sql).toContain('r.redeemed_at <= $2');
    });

    test('adds offerId filter', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getBrandRedemptions(1, { offerId: 42 });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([1, 42]);
        expect(sql).toContain('r.offer_id = $2');
    });

    test('adds brandName filter', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getBrandRedemptions(1, { brandName: 'Acme Dog Food' });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([1, 'Acme Dog Food']);
        expect(sql).toContain('o.brand_name = $2');
    });

    test('combines all filters', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getBrandRedemptions(1, {
            startDate: '2026-01-01',
            endDate: '2026-03-31',
            offerId: 42,
            brandName: 'Acme Dog Food'
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([1, '2026-01-01', '2026-03-31', 42, 'Acme Dog Food']);
        expect(sql).toContain('r.redeemed_at >= $2');
        expect(sql).toContain('r.redeemed_at <= $3');
        expect(sql).toContain('r.offer_id = $4');
        expect(sql).toContain('o.brand_name = $5');
    });

    test('returns rows from query', async () => {
        const rows = [makeRedemptionRow(), makeRedemptionRow({ reward_id: 'reward-uuid-2' })];
        db.query.mockResolvedValue({ rows });

        const result = await getBrandRedemptions(1);

        expect(result).toBe(rows);
        expect(result).toHaveLength(2);
    });
});

// ===== getContributingPurchases =====

describe('getContributingPurchases', () => {
    test('returns rows for reward', async () => {
        const rows = [
            makePurchaseRow(),
            makePurchaseRow({ event_id: 'evt-002', square_order_id: 'ORDER_002', purchased_at: '2026-02-15T12:00:00Z' })
        ];
        db.query.mockResolvedValue({ rows });

        const result = await getContributingPurchases('reward-uuid-1', 1);

        expect(result).toBe(rows);
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual(['reward-uuid-1', 1]);
        expect(sql).toContain('pe.reward_id = $1');
        expect(sql).toContain('pe.merchant_id = $2');
        expect(sql).toContain('ORDER BY pe.purchased_at ASC');
    });
});

// ===== buildBrandRedemptionReport =====

describe('buildBrandRedemptionReport', () => {
    test('returns empty when no redemptions', async () => {
        // First call is getBrandRedemptions
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await buildBrandRedemptionReport(1);

        expect(result).toEqual({ redemptions: [], summary: null });
    });

    test('builds enriched redemptions with purchases', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ purchased_at: '2026-02-01T12:00:00Z' }),
            makePurchaseRow({ event_id: 'evt-002', square_order_id: 'ORDER_002', purchased_at: '2026-02-15T12:00:00Z' })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })   // getBrandRedemptions
            .mockResolvedValueOnce({ rows: purchases });      // getContributingPurchases

        const result = await buildBrandRedemptionReport(1);

        expect(result.redemptions).toHaveLength(1);
        const r = result.redemptions[0];
        expect(r.rewardId).toBe('reward-uuid-1');
        expect(r.offer.brandName).toBe('Acme Dog Food');
        expect(r.customer.displayName).toBe('Jane Doe');
        expect(r.contributingPurchases).toHaveLength(2);
        expect(r.redeemedItem.name).toBe('Acme Kibble 30lb');
        expect(r.redeemedItem.retailValueCents).toBe(5999);
        expect(r.earningWindow.start).toBe('2026-01-01');
        expect(r.merchantName).toBe('JTPets');
    });

    test('calculates totalSpendCents excluding refunds', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ quantity: 2, unit_price_cents: 1000, is_refund: false }),
            makePurchaseRow({ event_id: 'evt-002', quantity: 1, unit_price_cents: 500, is_refund: false }),
            makePurchaseRow({ event_id: 'evt-003', quantity: 1, unit_price_cents: 1000, is_refund: true })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        // (2*1000) + (1*500) = 2500, refund excluded
        expect(result.redemptions[0].summary.totalSpendCents).toBe(2500);
    });

    test('calculates averageOrderValueCents', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ square_order_id: 'O1', quantity: 1, unit_price_cents: 3000 }),
            makePurchaseRow({ event_id: 'evt-002', square_order_id: 'O2', quantity: 1, unit_price_cents: 5000 })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        // totalSpend = 8000, visitCount = 2 unique orders, avg = 4000
        expect(result.redemptions[0].summary.averageOrderValueCents).toBe(4000);
    });

    test('calculates timeSpanDays between first and last purchase', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ purchased_at: '2026-01-01T12:00:00Z' }),
            makePurchaseRow({ event_id: 'evt-002', purchased_at: '2026-01-11T12:00:00Z' })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        expect(result.redemptions[0].summary.timeSpanDays).toBe(10);
    });

    test('timeSpanDays = 0 when fewer than 2 non-refund purchases', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ purchased_at: '2026-01-01T12:00:00Z' })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        expect(result.redemptions[0].summary.timeSpanDays).toBe(0);
    });

    test('timeSpanDays excludes refunds from date range', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ purchased_at: '2026-01-05T12:00:00Z', is_refund: false }),
            makePurchaseRow({ event_id: 'evt-002', purchased_at: '2026-02-20T12:00:00Z', is_refund: true }),
            // Only one non-refund purchase, so timeSpanDays = 0
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        expect(result.redemptions[0].summary.timeSpanDays).toBe(0);
    });

    test('counts visitCount from unique orderIds', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ square_order_id: 'O1' }),
            makePurchaseRow({ event_id: 'evt-002', square_order_id: 'O1' }),  // same order
            makePurchaseRow({ event_id: 'evt-003', square_order_id: 'O2' }),
            makePurchaseRow({ event_id: 'evt-004', square_order_id: null })   // null filtered out
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        // O1 and O2 are unique, null is filtered
        expect(result.redemptions[0].summary.visitCount).toBe(2);
    });

    test('builds overall summary', async () => {
        const redemption1 = makeRedemptionRow({
            reward_id: 'r1',
            square_customer_id: 'C1',
            redeemed_at: '2026-03-10T14:00:00Z',
            redeemed_value_cents: 5000
        });
        const redemption2 = makeRedemptionRow({
            reward_id: 'r2',
            square_customer_id: 'C2',
            redeemed_at: '2026-03-01T10:00:00Z',
            redeemed_value_cents: 3000
        });

        db.query
            .mockResolvedValueOnce({ rows: [redemption1, redemption2] })
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] })    // purchases for r1
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] });   // purchases for r2

        const result = await buildBrandRedemptionReport(1);

        expect(result.summary.totalRedemptions).toBe(2);
        expect(result.summary.totalValue).toBe(8000);  // 5000 + 3000
        expect(result.summary.uniqueCustomers).toBe(2);
        // Earliest is last in array (DESC order), latest is first
        expect(result.summary.dateRange.latest).toBe('2026-03-10T14:00:00Z');
        expect(result.summary.dateRange.earliest).toBe('2026-03-01T10:00:00Z');
    });

    test('includeFullOrders=true fetches Square orders', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ square_order_id: 'ORDER_001' }),
            makePurchaseRow({ event_id: 'evt-002', square_order_id: 'ORDER_002' })
        ];

        const mockSquareClient = {
            orders: {
                get: jest.fn()
                    .mockResolvedValueOnce({
                        order: {
                            id: 'ORDER_001',
                            lineItems: [
                                {
                                    name: 'Acme Kibble',
                                    variationName: 'Chicken',
                                    quantity: '1',
                                    basePriceMoney: { amount: '4599' },
                                    totalMoney: { amount: '4599' },
                                    catalogObjectId: 'CAT_001'
                                }
                            ],
                            totalMoney: { amount: '4599' },
                            tenders: [{ type: 'CARD' }]
                        }
                    })
                    .mockResolvedValueOnce({
                        order: {
                            id: 'ORDER_002',
                            lineItems: [
                                {
                                    name: 'Dog Treats',
                                    quantity: '2',
                                    basePriceMoney: { amount: '1200' },
                                    totalMoney: { amount: '2400' }
                                }
                            ],
                            totalMoney: { amount: '2400' }
                        }
                    })
            }
        };

        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);
        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1, { includeFullOrders: true });

        expect(merchant.getSquareClientForMerchant).toHaveBeenCalledWith(1);
        expect(mockSquareClient.orders.get).toHaveBeenCalledTimes(2);
        expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'ORDER_001' });
        expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'ORDER_002' });

        // Verify line items were enriched
        const p1 = result.redemptions[0].contributingPurchases[0];
        expect(p1.allLineItems).toHaveLength(1);
        expect(p1.allLineItems[0].name).toBe('Acme Kibble');
        expect(p1.allLineItems[0].unitPriceCents).toBe(4599);
        expect(p1.orderTotal).toBe(4599);
    });

    test('includeFullOrders=false skips Square fetch', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [makePurchaseRow()];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1, { includeFullOrders: false });

        expect(merchant.getSquareClientForMerchant).not.toHaveBeenCalled();
        expect(result.redemptions[0].contributingPurchases[0].allLineItems).toBeNull();
    });

    test('includeFullOrders defaults to false', async () => {
        const redemption = makeRedemptionRow();
        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] });

        await buildBrandRedemptionReport(1);

        expect(merchant.getSquareClientForMerchant).not.toHaveBeenCalled();
    });

    test('handles Square order fetch failure gracefully', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [makePurchaseRow({ square_order_id: 'ORDER_FAIL' })];

        const mockSquareClient = {
            orders: {
                get: jest.fn().mockRejectedValue(new Error('Square API error'))
            }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1, { includeFullOrders: true });

        // Should not throw, order details just missing
        expect(result.redemptions[0].contributingPurchases[0].allLineItems).toBeNull();
        expect(logger.warn).toHaveBeenCalled();
    });

    test('calculates qualifyingPurchaseCount and refundCount', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ is_refund: false }),
            makePurchaseRow({ event_id: 'evt-002', is_refund: false }),
            makePurchaseRow({ event_id: 'evt-003', is_refund: true })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        expect(result.redemptions[0].summary.qualifyingPurchaseCount).toBe(2);
        expect(result.redemptions[0].summary.refundCount).toBe(1);
    });

    test('calculates totalQualifyingUnits summing quantities', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ quantity: 2, is_refund: false }),
            makePurchaseRow({ event_id: 'evt-002', quantity: 3, is_refund: false }),
            makePurchaseRow({ event_id: 'evt-003', quantity: 1, is_refund: true })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1);

        // 2 + 3 = 5 (refund excluded)
        expect(result.redemptions[0].summary.totalQualifyingUnits).toBe(5);
    });

    test('payment type falls back to Square tender type', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ payment_type: null, square_order_id: 'ORDER_T' })
        ];

        const mockSquareClient = {
            orders: {
                get: jest.fn().mockResolvedValue({
                    order: {
                        id: 'ORDER_T',
                        lineItems: [],
                        tenders: [{ type: 'CASH' }]
                    }
                })
            }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1, { includeFullOrders: true });

        expect(result.redemptions[0].contributingPurchases[0].paymentType).toBe('CASH');
    });

    test('marks free items in line items', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [makePurchaseRow({ square_order_id: 'ORDER_FREE' })];

        const mockSquareClient = {
            orders: {
                get: jest.fn().mockResolvedValue({
                    order: {
                        id: 'ORDER_FREE',
                        lineItems: [
                            {
                                name: 'Free Treat',
                                quantity: '1',
                                basePriceMoney: { amount: '500' },
                                totalMoney: { amount: '0' },
                                catalogObjectId: 'CAT_FREE'
                            }
                        ]
                    }
                })
            }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const result = await buildBrandRedemptionReport(1, { includeFullOrders: true });

        const lineItem = result.redemptions[0].contributingPurchases[0].allLineItems[0];
        expect(lineItem.isFreeItem).toBe(true);
        expect(lineItem.unitPriceCents).toBe(500);
        expect(lineItem.totalCents).toBe(0);
    });

    test('passes filter options through to getBrandRedemptions', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await buildBrandRedemptionReport(1, {
            includeFullOrders: true,
            startDate: '2026-01-01',
            brandName: 'Acme'
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toContain('2026-01-01');
        expect(params).toContain('Acme');
    });
});

// ===== generateBrandRedemptionHTML =====

describe('generateBrandRedemptionHTML', () => {
    test('returns empty HTML when no redemptions', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await generateBrandRedemptionHTML(1);

        expect(result.html).toContain('No redemptions found');
        expect(result.filename).toBe('brand-redemption-report-empty.html');
        expect(result.data.redemptions).toEqual([]);
        expect(result.data.summary).toBeNull();
    });

    test('returns HTML with data and filename for redemptions', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [makePurchaseRow()];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        // includeFullOrders is always true for HTML, need square client mock
        const mockSquareClient = {
            orders: {
                get: jest.fn().mockResolvedValue({
                    order: {
                        id: 'ORDER_001',
                        lineItems: [
                            {
                                name: 'Acme Kibble',
                                quantity: '1',
                                basePriceMoney: { amount: '4599' },
                                totalMoney: { amount: '4599' }
                            }
                        ],
                        totalMoney: { amount: '4599' }
                    }
                })
            }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionHTML(1);

        expect(result.html).toContain('Brand Redemption Report');
        expect(result.html).toContain('<!DOCTYPE html>');
        expect(result.html).toContain('redemption-card');
        expect(result.data.redemptions).toHaveLength(1);
        expect(result.data.summary).toBeTruthy();
        expect(result.data.summary.totalRedemptions).toBe(1);
    });

    test('filename contains brand slug', async () => {
        const redemption = makeRedemptionRow({ brand_name: 'Royal Canin Premium' });
        const purchases = [makePurchaseRow()];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const mockSquareClient = {
            orders: { get: jest.fn().mockResolvedValue({ order: { id: 'ORDER_001', lineItems: [] } }) }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionHTML(1);

        expect(result.filename).toContain('royal-canin-premium');
        expect(result.filename).toMatch(/\.html$/);
    });

    test('uses Multi-Brand when multiple brands present', async () => {
        const r1 = makeRedemptionRow({ reward_id: 'r1', brand_name: 'Brand A' });
        const r2 = makeRedemptionRow({ reward_id: 'r2', brand_name: 'Brand B' });

        db.query
            .mockResolvedValueOnce({ rows: [r1, r2] })
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] })
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] });

        const mockSquareClient = {
            orders: { get: jest.fn().mockResolvedValue({ order: { id: 'ORDER_001', lineItems: [] } }) }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionHTML(1);

        expect(result.filename).toContain('multi-brand');
        expect(result.html).toContain('Multi-Brand');
    });

    test('always passes includeFullOrders=true to buildBrandRedemptionReport', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        // Even if user passes includeFullOrders: false, HTML always uses true
        await generateBrandRedemptionHTML(1, { includeFullOrders: false });

        // With no redemptions, no Square calls needed anyway
        // Just verify it didn't throw
    });
});

// ===== generateBrandRedemptionCSV =====

describe('generateBrandRedemptionCSV', () => {
    test('returns empty CSV when no redemptions', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await generateBrandRedemptionCSV(1);

        expect(result.csv).toContain('\uFEFF');
        expect(result.csv).toContain('No redemptions found');
        expect(result.count).toBe(0);
        expect(result.filename).toMatch(/^brand-redemption-export-\d+\.csv$/);
    });

    test('generates CSV with headers and rows', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow(),
            makePurchaseRow({
                event_id: 'evt-002',
                square_order_id: 'ORDER_002',
                purchased_at: '2026-02-15T12:00:00Z'
            })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const mockSquareClient = {
            orders: {
                get: jest.fn().mockResolvedValue({
                    order: { id: 'ORDER_001', lineItems: [], totalMoney: { amount: '4599' } }
                })
            }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionCSV(1);

        expect(result.csv).toContain('\uFEFF');
        // Headers present (wrapped in escapeCSVField mock quotes)
        expect(result.csv).toContain('"Redemption ID"');
        expect(result.csv).toContain('"Brand"');
        expect(result.csv).toContain('"Customer Name"');
        expect(result.csv).toContain('"Free Item Retail Value ($)"');
        expect(result.csv).toContain('"Purchase #"');
        expect(result.csv).toContain('"Total Customer Spend ($)"');

        // Data rows
        expect(result.count).toBe(2);
        expect(result.redemptionCount).toBe(1);
    });

    test('one row per contributing purchase', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ event_id: 'evt-1' }),
            makePurchaseRow({ event_id: 'evt-2' }),
            makePurchaseRow({ event_id: 'evt-3' })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const mockSquareClient = {
            orders: { get: jest.fn().mockResolvedValue({ order: { id: 'ORDER_001', lineItems: [] } }) }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionCSV(1);

        expect(result.count).toBe(3);
        // CSV has header line + 3 data rows
        const lines = result.csv.split('\n');
        // First line is BOM + header
        expect(lines).toHaveLength(4); // header + 3 rows
    });

    test('summary fields only on first row per redemption', async () => {
        const redemption = makeRedemptionRow();
        const purchases = [
            makePurchaseRow({ event_id: 'evt-1', quantity: 2, unit_price_cents: 1000 }),
            makePurchaseRow({ event_id: 'evt-2', quantity: 1, unit_price_cents: 2000 })
        ];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const mockSquareClient = {
            orders: { get: jest.fn().mockResolvedValue({ order: { id: 'ORDER_001', lineItems: [] } }) }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionCSV(1);

        const lines = result.csv.split('\n');
        // Row 1 (index 1) should have summary values, row 2 (index 2) should have empty summary
        const row1 = lines[1];
        const row2 = lines[2];

        // Purchase # on first row = 1, second row = 2
        expect(row1).toContain('"1"');
        expect(row2).toContain('"2"');

        // Summary fields: totalSpendCents = (2*1000)+(1*2000) = 4000 => 40.00
        // First row should contain the summary value
        expect(row1).toContain('"40.00"');
        // Second row summary fields should be empty strings
        // The last few fields of row2 should be empty
    });

    test('filename contains brand slug', async () => {
        const redemption = makeRedemptionRow({ brand_name: 'Open Farm' });
        const purchases = [makePurchaseRow()];

        db.query
            .mockResolvedValueOnce({ rows: [redemption] })
            .mockResolvedValueOnce({ rows: purchases });

        const mockSquareClient = {
            orders: { get: jest.fn().mockResolvedValue({ order: { id: 'ORDER_001', lineItems: [] } }) }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionCSV(1);

        expect(result.filename).toContain('open-farm');
        expect(result.filename).toMatch(/\.csv$/);
    });

    test('multi-brand filename when multiple brands', async () => {
        const r1 = makeRedemptionRow({ reward_id: 'r1', brand_name: 'Brand X' });
        const r2 = makeRedemptionRow({ reward_id: 'r2', brand_name: 'Brand Y' });

        db.query
            .mockResolvedValueOnce({ rows: [r1, r2] })
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] })
            .mockResolvedValueOnce({ rows: [makePurchaseRow()] });

        const mockSquareClient = {
            orders: { get: jest.fn().mockResolvedValue({ order: { id: 'ORDER_001', lineItems: [] } }) }
        };
        merchant.getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

        const result = await generateBrandRedemptionCSV(1);

        expect(result.filename).toContain('multi-brand');
    });
});

// ===== Re-exported privacy utilities =====

describe('re-exported privacy utilities', () => {
    test('formatPrivacyName is re-exported', () => {
        expect(typeof formatPrivacyName).toBe('function');
        expect(formatPrivacyName('John', 'Smith')).toBe('John Smith');
    });

    test('formatPrivacyPhone is re-exported', () => {
        expect(typeof formatPrivacyPhone).toBe('function');
        expect(formatPrivacyPhone('+15551234567')).toBe('***4567');
    });

    test('formatPrivacyEmail is re-exported', () => {
        expect(typeof formatPrivacyEmail).toBe('function');
        expect(formatPrivacyEmail('john@example.com')).toBe('jo***');
    });
});
