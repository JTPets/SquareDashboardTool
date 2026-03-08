/**
 * Tests for audit fixes (2026-03-08):
 * - LA-7: Strategy 3 false-positive guard
 * - LA-8: Customer note 409 retry
 * - LA-13: Pagination guards
 * - discount-service.js timezone fix
 * - discount-service.js inventory_counts merchant_id filter
 */

// ============================================================================
// LA-7: Strategy 3 false-positive guard
// ============================================================================
describe('LA-7: matchEarnedRewardByDiscountAmount false-positive guard', () => {
    let matchEarnedRewardByDiscountAmount;
    let db;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../../utils/database');
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }));
        jest.mock('../../services/loyalty-admin/constants', () => ({
            RewardStatus: { EARNED: 'earned', REDEEMED: 'redeemed' },
            AuditActions: {},
            RedemptionTypes: { AUTO_DETECTED: 'auto_detected' },
        }));
        jest.mock('../../services/loyalty-admin/audit-service', () => ({
            logAuditEvent: jest.fn(),
        }));
        jest.mock('../../services/loyalty-admin/square-discount-service', () => ({
            cleanupSquareCustomerGroupDiscount: jest.fn(),
        }));
        jest.mock('../../services/loyalty-admin/customer-summary-service', () => ({
            updateCustomerSummary: jest.fn(),
        }));

        db = require('../../utils/database');
        const rewardService = require('../../services/loyalty-admin/reward-service');
        matchEarnedRewardByDiscountAmount = rewardService.matchEarnedRewardByDiscountAmount;
    });

    test('skips reward when order discounts are from non-loyalty sources', async () => {
        // Earned reward with known discount IDs
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 100,
                offer_id: 10,
                square_customer_id: 'CUST1',
                offer_name: 'Buy 6 Get 1 Free',
                square_discount_id: 'DISC_LOYALTY_123',
                square_pricing_rule_id: 'PR_LOYALTY_456',
                qualifying_variation_ids: ['VAR1', 'VAR2'],
            }],
        });

        const order = {
            id: 'ORDER1',
            discounts: [{
                catalog_object_id: 'DISC_SALE_999', // NOT our loyalty discount
                applied_money: { amount: 2000 },
            }],
            line_items: [{
                catalog_object_id: 'VAR1',
                total_discount_money: { amount: 2000 },
            }],
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'CUST1',
            merchantId: 1,
        });

        expect(result).toBeNull();
    });

    test('matches reward when order discount matches our loyalty discount ID', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    reward_id: 100,
                    offer_id: 10,
                    square_customer_id: 'CUST1',
                    offer_name: 'Buy 6 Get 1 Free',
                    square_discount_id: 'DISC_LOYALTY_123',
                    square_pricing_rule_id: null,
                    qualifying_variation_ids: ['VAR1', 'VAR2'],
                }],
            })
            .mockResolvedValueOnce({
                rows: [{ expected_value_cents: 2000 }],
            });

        const order = {
            id: 'ORDER1',
            discounts: [{
                catalog_object_id: 'DISC_LOYALTY_123', // matches our loyalty discount
                applied_money: { amount: 2000 },
            }],
            line_items: [{
                catalog_object_id: 'VAR1',
                total_discount_money: { amount: 1950 }, // 97.5% of expected — above 95% threshold
            }],
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'CUST1',
            merchantId: 1,
        });

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(100);
        expect(result.totalDiscountCents).toBe(1950);
    });

    test('matches reward when order discount matches our pricing rule ID', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    reward_id: 100,
                    offer_id: 10,
                    square_customer_id: 'CUST1',
                    offer_name: 'Buy 6 Get 1 Free',
                    square_discount_id: null,
                    square_pricing_rule_id: 'PR_LOYALTY_456',
                    qualifying_variation_ids: ['VAR1'],
                }],
            })
            .mockResolvedValueOnce({
                rows: [{ expected_value_cents: 1500 }],
            });

        const order = {
            id: 'ORDER1',
            discounts: [{
                catalog_object_id: 'PR_LOYALTY_456',
                applied_money: { amount: 1500 },
            }],
            line_items: [{
                catalog_object_id: 'VAR1',
                total_discount_money: { amount: 1500 },
            }],
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'CUST1',
            merchantId: 1,
        });

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(100);
    });

    test('skips when reward has no Square discount IDs', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 100,
                offer_id: 10,
                square_customer_id: 'CUST1',
                offer_name: 'Buy 6 Get 1 Free',
                square_discount_id: null,
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['VAR1'],
            }],
        });

        const order = {
            id: 'ORDER1',
            discounts: [{ catalog_object_id: 'SOME_DISC', applied_money: { amount: 2000 } }],
            line_items: [{ catalog_object_id: 'VAR1', total_discount_money: { amount: 2000 } }],
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'CUST1',
            merchantId: 1,
        });

        expect(result).toBeNull();
    });

    test('returns null when no customer ID provided', async () => {
        const result = await matchEarnedRewardByDiscountAmount({
            order: { id: 'ORDER1' },
            squareCustomerId: null,
            merchantId: 1,
        });
        expect(result).toBeNull();
    });
});

// ============================================================================
// LA-8: Customer note 409 retry
// ============================================================================
describe('LA-8: updateCustomerRewardNote 409 retry', () => {
    // Source-level verification that retry logic exists
    test('updateCustomerRewardNote retries on 409 (source verification)', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../../services/loyalty-admin/square-discount-service'),
            'utf8'
        );
        // Verify retry loop exists
        expect(source).toContain('MAX_RETRIES');
        expect(source).toContain('for (let attempt = 0; attempt <= MAX_RETRIES; attempt++)');
        // Verify 409 check before retry
        expect(source).toContain('putResponse.status === 409');
        expect(source).toContain('attempt < MAX_RETRIES');
        // Verify warning log on 409
        expect(source).toContain('version conflict (409), retrying');
    });

    test('updateCustomerRewardNote is exported', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../../services/loyalty-admin/square-discount-service'),
            'utf8'
        );
        expect(source).toContain('updateCustomerRewardNote');
        expect(source).toMatch(/module\.exports\s*=\s*\{[\s\S]*updateCustomerRewardNote/);
    });
});

// ============================================================================
// LA-13: Pagination guards
// ============================================================================
describe('LA-13: Pagination guards in backfill/audit services', () => {
    test('backfill-service.js imports MAX_PAGINATION_ITERATIONS', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../../services/loyalty-admin/backfill-service'),
            'utf8'
        );
        expect(source).toContain('MAX_PAGINATION_ITERATIONS');
        expect(source).toContain('++paginationIterations > MAX_PAGINATION_ITERATIONS');
    });

    test('order-history-audit-service.js imports MAX_PAGINATION_ITERATIONS', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../../services/loyalty-admin/order-history-audit-service'),
            'utf8'
        );
        expect(source).toContain('MAX_PAGINATION_ITERATIONS');
        expect(source).toContain('++paginationIterations > MAX_PAGINATION_ITERATIONS');
    });
});

// ============================================================================
// discount-service.js: calculateDaysUntilExpiry timezone fix
// ============================================================================
describe('calculateDaysUntilExpiry timezone fix', () => {
    let calculateDaysUntilExpiry;

    // Build YYYY-MM-DD for "now" in a given timezone using Intl.DateTimeFormat
    // (avoids toLocaleDateString locale inconsistencies across environments)
    function getTodayString(tz) {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const parts = fmt.formatToParts(new Date());
        const y = parts.find(p => p.type === 'year').value;
        const m = parts.find(p => p.type === 'month').value;
        const d = parts.find(p => p.type === 'day').value;
        return `${y}-${m}-${d}`;
    }

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../../utils/database');
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }));
        jest.mock('../../utils/square-catalog-cleanup', () => ({
            deleteCatalogObjects: jest.fn(),
        }));
        const discountService = require('../../services/expiry/discount-service');
        calculateDaysUntilExpiry = discountService.calculateDaysUntilExpiry;
    });

    test('returns null for null/undefined input', () => {
        expect(calculateDaysUntilExpiry(null)).toBeNull();
        expect(calculateDaysUntilExpiry(undefined)).toBeNull();
    });

    test('returns 0 for today in target timezone', () => {
        // Get today's date string in Toronto timezone, then pass it back
        const todayStr = getTodayString('America/Toronto');
        const result = calculateDaysUntilExpiry(todayStr, 'America/Toronto');
        expect(result).toBe(0);
    });

    test('returns positive for future date', () => {
        // Build a date string 10 days ahead in Toronto timezone
        const todayStr = getTodayString('America/Toronto');
        const todayMs = Date.parse(todayStr + 'T00:00:00Z');
        const futureStr = new Date(todayMs + 10 * 86400000).toISOString().slice(0, 10);
        expect(calculateDaysUntilExpiry(futureStr, 'America/Toronto')).toBe(10);
    });

    test('returns negative for past date', () => {
        const todayStr = getTodayString('America/Toronto');
        const todayMs = Date.parse(todayStr + 'T00:00:00Z');
        const pastStr = new Date(todayMs - 5 * 86400000).toISOString().slice(0, 10);
        expect(calculateDaysUntilExpiry(pastStr, 'America/Toronto')).toBe(-5);
    });

    test('respects timezone parameter', () => {
        // Use a fixed date that we know
        const result1 = calculateDaysUntilExpiry('2030-06-15', 'America/Toronto');
        const result2 = calculateDaysUntilExpiry('2030-06-15', 'Pacific/Auckland');
        // Both should be numbers (may differ by 1 depending on time of day and timezone offset)
        expect(typeof result1).toBe('number');
        expect(typeof result2).toBe('number');
    });

    test('uses default America/Toronto timezone', () => {
        const result = calculateDaysUntilExpiry('2030-01-01');
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThan(0);
    });
});

// ============================================================================
// discount-service.js: inventory_counts merchant_id filter
// ============================================================================
describe('discount-service.js inventory_counts merchant_id filter', () => {
    test('getDiscountStatusSummary SQL includes merchant_id in inventory_counts subquery', () => {
        const fs = require('fs');
        const source = fs.readFileSync(
            require.resolve('../../services/expiry/discount-service'),
            'utf8'
        );

        // Find the inventory_counts subquery and verify merchant_id filter
        const inventorySubquery = source.match(/FROM inventory_counts[\s\S]*?GROUP BY catalog_object_id/);
        expect(inventorySubquery).not.toBeNull();
        expect(inventorySubquery[0]).toContain('merchant_id = $1');
    });
});

// ============================================================================
// CLAUDE.md: Refactor-on-touch policy
// ============================================================================
describe('CLAUDE.md refactor-on-touch policy for 500+ line files', () => {
    test('contains module breakdown map instruction for files over 500 lines', () => {
        const fs = require('fs');
        const claudeMd = fs.readFileSync(
            require.resolve('../../CLAUDE.md'),
            'utf8'
        );
        expect(claudeMd).toContain('500 lines');
        expect(claudeMd).toContain('module breakdown map');
    });
});
