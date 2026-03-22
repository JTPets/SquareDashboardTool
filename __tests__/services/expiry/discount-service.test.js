/**
 * Tests for services/expiry/discount-service.js
 *
 * Covers: tier management, days-until-expiry calculation, discount automation,
 * Square discount/pricing-rule management, tier regression detection,
 * reorder clearing, flagged variation resolution.
 */

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

// Mock Square API (lazy-loaded)
const mockSquareApi = {
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn().mockResolvedValue({}),
    generateIdempotencyKey: jest.fn(prefix => `${prefix}-idem-key`)
};
jest.mock('../../../services/square', () => mockSquareApi);

// Mock square-catalog-cleanup
const mockDeleteCatalogObjects = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../../utils/square-catalog-cleanup', () => ({
    deleteCatalogObjects: mockDeleteCatalogObjects
}));

const discountService = require('../../../services/expiry/discount-service');

// ============================================================================
// TEST DATA
// ============================================================================

const MERCHANT_ID = 1;

const MOCK_TIERS = [
    { id: 100, tier_code: 'EXPIRED', tier_name: 'Expired', min_days_to_expiry: null, max_days_to_expiry: 0, discount_percent: 0, is_auto_apply: false, requires_review: false, priority: 100, is_active: true, merchant_id: MERCHANT_ID },
    { id: 90, tier_code: 'AUTO50', tier_name: '50% Off', min_days_to_expiry: 1, max_days_to_expiry: 30, discount_percent: 50, is_auto_apply: true, requires_review: false, priority: 90, is_active: true, merchant_id: MERCHANT_ID, square_discount_id: 'SQ_DISC_50' },
    { id: 80, tier_code: 'AUTO25', tier_name: '25% Off', min_days_to_expiry: 31, max_days_to_expiry: 89, discount_percent: 25, is_auto_apply: true, requires_review: false, priority: 80, is_active: true, merchant_id: MERCHANT_ID, square_discount_id: 'SQ_DISC_25' },
    { id: 70, tier_code: 'REVIEW', tier_name: 'Review', min_days_to_expiry: 90, max_days_to_expiry: 120, discount_percent: 0, is_auto_apply: false, requires_review: true, priority: 70, is_active: true, merchant_id: MERCHANT_ID },
    { id: 10, tier_code: 'OK', tier_name: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null, discount_percent: 0, is_auto_apply: false, requires_review: false, priority: 10, is_active: true, merchant_id: MERCHANT_ID }
];

// ============================================================================
// HELPERS
// ============================================================================

function setupDbQuery(responses) {
    let callIndex = 0;
    db.query.mockImplementation(() => {
        const resp = responses[callIndex] || { rows: [], rowCount: 0 };
        callIndex++;
        return Promise.resolve(resp);
    });
}

// ============================================================================
// TESTS
// ============================================================================

beforeEach(() => {
    jest.resetAllMocks();
    // Re-apply default mock behavior (restoreMocks: true in jest.config clears between tests)
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    db.transaction.mockImplementation(async (fn) => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        return fn(mockClient);
    });
});

// ----------------------------------------------------------------------------
// Pure functions (no DB)
// ----------------------------------------------------------------------------

describe('calculateDaysUntilExpiry', () => {
    it('returns null for null/undefined input', () => {
        expect(discountService.calculateDaysUntilExpiry(null)).toBeNull();
        expect(discountService.calculateDaysUntilExpiry(undefined)).toBeNull();
    });

    it('returns null for invalid date string', () => {
        expect(discountService.calculateDaysUntilExpiry('not-a-date')).toBeNull();
    });

    it('returns 0 for today', () => {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Toronto',
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const parts = fmt.formatToParts(new Date());
        const y = parts.find(p => p.type === 'year').value;
        const m = parts.find(p => p.type === 'month').value;
        const d = parts.find(p => p.type === 'day').value;
        const today = `${y}-${m}-${d}`;
        expect(discountService.calculateDaysUntilExpiry(today)).toBe(0);
    });

    it('returns positive number for future date', () => {
        const future = new Date();
        future.setDate(future.getDate() + 10);
        const dateStr = future.toISOString().slice(0, 10);
        const days = discountService.calculateDaysUntilExpiry(dateStr);
        // Should be approximately 10 (timezone could shift by 1)
        expect(days).toBeGreaterThanOrEqual(9);
        expect(days).toBeLessThanOrEqual(11);
    });

    it('returns negative number for past date', () => {
        const past = new Date();
        past.setDate(past.getDate() - 5);
        const dateStr = past.toISOString().slice(0, 10);
        const days = discountService.calculateDaysUntilExpiry(dateStr);
        expect(days).toBeLessThanOrEqual(-4);
        expect(days).toBeGreaterThanOrEqual(-6);
    });

    it('handles Date objects', () => {
        const future = new Date();
        future.setDate(future.getDate() + 30);
        const days = discountService.calculateDaysUntilExpiry(future);
        expect(days).toBeGreaterThanOrEqual(29);
        expect(days).toBeLessThanOrEqual(31);
    });

    it('handles ISO string with time component', () => {
        const future = new Date();
        future.setDate(future.getDate() + 15);
        const isoStr = future.toISOString(); // includes T and Z
        const days = discountService.calculateDaysUntilExpiry(isoStr);
        expect(days).toBeGreaterThanOrEqual(14);
        expect(days).toBeLessThanOrEqual(16);
    });
});

describe('determineTier', () => {
    it('returns null for null days', () => {
        expect(discountService.determineTier(null, MOCK_TIERS)).toBeNull();
    });

    it('returns EXPIRED for negative days', () => {
        const tier = discountService.determineTier(-5, MOCK_TIERS);
        expect(tier.tier_code).toBe('EXPIRED');
    });

    it('returns EXPIRED for day 0', () => {
        const tier = discountService.determineTier(0, MOCK_TIERS);
        expect(tier.tier_code).toBe('EXPIRED');
    });

    it('returns AUTO50 for 1-30 days', () => {
        expect(discountService.determineTier(1, MOCK_TIERS).tier_code).toBe('AUTO50');
        expect(discountService.determineTier(15, MOCK_TIERS).tier_code).toBe('AUTO50');
        expect(discountService.determineTier(30, MOCK_TIERS).tier_code).toBe('AUTO50');
    });

    it('returns AUTO25 for 31-89 days', () => {
        expect(discountService.determineTier(31, MOCK_TIERS).tier_code).toBe('AUTO25');
        expect(discountService.determineTier(60, MOCK_TIERS).tier_code).toBe('AUTO25');
        expect(discountService.determineTier(89, MOCK_TIERS).tier_code).toBe('AUTO25');
    });

    it('returns REVIEW for 90-120 days', () => {
        expect(discountService.determineTier(90, MOCK_TIERS).tier_code).toBe('REVIEW');
        expect(discountService.determineTier(120, MOCK_TIERS).tier_code).toBe('REVIEW');
    });

    it('returns OK for 121+ days', () => {
        expect(discountService.determineTier(121, MOCK_TIERS).tier_code).toBe('OK');
        expect(discountService.determineTier(365, MOCK_TIERS).tier_code).toBe('OK');
    });

    it('returns null for empty tiers array', () => {
        expect(discountService.determineTier(10, [])).toBeNull();
    });
});

describe('buildTierRankMap', () => {
    it('assigns ranks by urgency (OK=0, EXPIRED=highest)', () => {
        const rankMap = discountService.buildTierRankMap(MOCK_TIERS);
        // OK has highest min_days (121) → sorted first → rank 0
        expect(rankMap.get(10)).toBe(0);  // OK
        // EXPIRED has null min_days → sorted last → rank 4
        expect(rankMap.get(100)).toBe(4); // EXPIRED
        // AUTO50 should be rank 3, AUTO25 rank 2, REVIEW rank 1
        expect(rankMap.get(90)).toBe(3);  // AUTO50
        expect(rankMap.get(80)).toBe(2);  // AUTO25
        expect(rankMap.get(70)).toBe(1);  // REVIEW
    });

    it('handles empty tiers', () => {
        const rankMap = discountService.buildTierRankMap([]);
        expect(rankMap.size).toBe(0);
    });
});

// ----------------------------------------------------------------------------
// DB-backed functions
// ----------------------------------------------------------------------------

describe('getActiveTiers', () => {
    it('throws if merchantId missing', async () => {
        await expect(discountService.getActiveTiers(null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns tiers from database', async () => {
        db.query.mockResolvedValueOnce({ rows: MOCK_TIERS });
        const tiers = await discountService.getActiveTiers(MERCHANT_ID);
        expect(tiers).toEqual(MOCK_TIERS);
        expect(db.query).toHaveBeenCalledWith(expect.stringContaining('expiry_discount_tiers'), [MERCHANT_ID]);
    });
});

describe('getTierByCode', () => {
    it('throws if merchantId missing', async () => {
        await expect(discountService.getTierByCode('AUTO50', null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns tier by code', async () => {
        db.query.mockResolvedValueOnce({ rows: [MOCK_TIERS[1]] });
        const tier = await discountService.getTierByCode('AUTO50', MERCHANT_ID);
        expect(tier.tier_code).toBe('AUTO50');
    });

    it('returns null when not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const tier = await discountService.getTierByCode('NONEXISTENT', MERCHANT_ID);
        expect(tier).toBeNull();
    });
});

describe('getSetting / updateSetting', () => {
    it('getSetting throws without merchantId', async () => {
        await expect(discountService.getSetting('key', null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns setting value', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ setting_value: '6' }] });
        const val = await discountService.getSetting('cron_hour', MERCHANT_ID);
        expect(val).toBe('6');
    });

    it('returns null when not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const val = await discountService.getSetting('missing', MERCHANT_ID);
        expect(val).toBeNull();
    });

    it('updateSetting inserts/updates', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await discountService.updateSetting('key', 'value', MERCHANT_ID);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('ON CONFLICT'),
            ['key', 'value', MERCHANT_ID]
        );
    });
});

describe('logAuditEvent', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.logAuditEvent({ variationId: 'v1' }))
            .rejects.toThrow('merchantId is required');
    });

    it('inserts audit event', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await discountService.logAuditEvent({
            merchantId: MERCHANT_ID,
            variationId: 'v1',
            action: 'TIER_CHANGED',
            oldTierId: 10,
            newTierId: 90,
            daysUntilExpiry: 5,
            triggeredBy: 'CRON'
        });
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('expiry_discount_audit_log'),
            expect.arrayContaining([MERCHANT_ID, 'v1', 'TIER_CHANGED'])
        );
    });
});

// ----------------------------------------------------------------------------
// evaluateAllVariations
// ----------------------------------------------------------------------------

describe('evaluateAllVariations', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.evaluateAllVariations({}))
            .rejects.toThrow('merchantId is required');
    });

    it('evaluates variations and assigns tiers correctly', async () => {
        // Future date = 15 days from now → AUTO50
        const future15 = new Date();
        future15.setDate(future15.getDate() + 15);

        db.query
            // getActiveTiers
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            // variations query
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    item_id: 'item1',
                    variation_name: 'Size A',
                    sku: 'SKU001',
                    current_price_cents: 1000,
                    item_name: 'Dog Food',
                    expiration_date: future15.toISOString().slice(0, 10),
                    does_not_expire: false,
                    current_tier_id: null,
                    original_price_cents: null,
                    discounted_price_cents: null
                }]
            })
            // getSetting (timezone)
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] })
            // INSERT variation_discount_status
            .mockResolvedValueOnce({ rows: [] })
            // INSERT audit log
            .mockResolvedValueOnce({ rows: [] });

        const results = await discountService.evaluateAllVariations({
            merchantId: MERCHANT_ID,
            dryRun: false,
            triggeredBy: 'CRON'
        });

        expect(results.totalEvaluated).toBe(1);
        expect(results.newAssignments).toHaveLength(1);
        expect(results.newAssignments[0].newTierCode).toBe('AUTO50');
        expect(results.newAssignments[0].discountPercent).toBe(50);
    });

    it('skips items that do not expire', async () => {
        db.query
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    does_not_expire: true,
                    current_tier_id: null,
                    expiration_date: null
                }]
            })
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] });

        const results = await discountService.evaluateAllVariations({
            merchantId: MERCHANT_ID,
            dryRun: true
        });

        expect(results.totalEvaluated).toBe(1);
        expect(results.byTier['NO_EXPIRY']).toBe(1);
        expect(results.tierChanges).toHaveLength(0);
    });

    it('detects tier regressions and flags for review', async () => {
        // Item currently at AUTO50 (rank 3), but now calculates to OK (rank 0) = regression
        const future200 = new Date();
        future200.setDate(future200.getDate() + 200);

        db.query
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    item_id: 'item1',
                    variation_name: 'Size A',
                    sku: 'SKU001',
                    current_price_cents: 1000,
                    item_name: 'Dog Food',
                    expiration_date: future200.toISOString().slice(0, 10),
                    does_not_expire: false,
                    current_tier_id: 90, // AUTO50
                    original_price_cents: 1000,
                    discounted_price_cents: 500
                }]
            })
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] })
            // UPDATE for regression flag
            .mockResolvedValueOnce({ rows: [] })
            // INSERT audit log for regression
            .mockResolvedValueOnce({ rows: [] });

        const results = await discountService.evaluateAllVariations({
            merchantId: MERCHANT_ID,
            dryRun: false,
            triggeredBy: 'SYSTEM'
        });

        expect(results.regressionsFlagged).toHaveLength(1);
        expect(results.regressionsFlagged[0].isRegression).toBe(true);
    });

    it('dry run does not write to database', async () => {
        const future15 = new Date();
        future15.setDate(future15.getDate() + 15);

        db.query
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    item_id: 'item1',
                    variation_name: 'Size A',
                    sku: 'SKU001',
                    current_price_cents: 1000,
                    item_name: 'Dog Food',
                    expiration_date: future15.toISOString().slice(0, 10),
                    does_not_expire: false,
                    current_tier_id: null,
                    original_price_cents: null,
                    discounted_price_cents: null
                }]
            })
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] });

        const results = await discountService.evaluateAllVariations({
            merchantId: MERCHANT_ID,
            dryRun: true
        });

        // Only 3 queries: getActiveTiers, variations, getSetting (timezone)
        expect(db.query).toHaveBeenCalledTimes(3);
        expect(results.newAssignments).toHaveLength(1);
    });

    it('handles errors on individual variations gracefully', async () => {
        db.query
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    does_not_expire: false,
                    expiration_date: '2026-04-01',
                    current_tier_id: null
                }]
            })
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] })
            // INSERT fails
            .mockRejectedValueOnce(new Error('DB constraint error'));

        const results = await discountService.evaluateAllVariations({
            merchantId: MERCHANT_ID,
            dryRun: false
        });

        expect(results.errors).toHaveLength(1);
        expect(results.errors[0].variationId).toBe('var1');
    });
});

// ----------------------------------------------------------------------------
// Discount application
// ----------------------------------------------------------------------------

describe('applyDiscounts', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.applyDiscounts({}))
            .rejects.toThrow('merchantId is required');
    });

    it('calculates discounted price correctly (25% off 1000 = 750)', async () => {
        // Setup: one auto-apply tier with one variation
        db.query
            // Get auto-apply tiers
            .mockResolvedValueOnce({
                rows: [{
                    id: 80,
                    tier_code: 'AUTO25',
                    discount_percent: 25,
                    is_auto_apply: true,
                    is_active: true,
                    merchant_id: MERCHANT_ID,
                    square_discount_id: 'SQ_DISC_25'
                }]
            })
            // Get variations in this tier
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    original_price_cents: 1000,
                    current_price_cents: 1000,
                    sku: 'SKU001',
                    item_name: 'Dog Food'
                }]
            });

        // Mock upsertPricingRule chain (filterValidVariations + search + batch-upsert)
        mockSquareApi.makeSquareRequest
            // filterValidVariations (batch-retrieve)
            .mockResolvedValueOnce({ objects: [{ id: 'var1' }] })
            // search for existing pricing rule
            .mockResolvedValueOnce({ objects: [] })
            // batch-upsert
            .mockResolvedValueOnce({ objects: [{ type: 'PRICING_RULE', id: 'PR1' }] });

        db.query
            // UPDATE tier record after pricing rule
            .mockResolvedValueOnce({ rows: [] })
            // UPDATE variation_discount_status (discounted price)
            .mockResolvedValueOnce({ rows: [] })
            // INSERT audit log
            .mockResolvedValueOnce({ rows: [] })
            // Query for removed discounts
            .mockResolvedValueOnce({ rows: [] });

        const results = await discountService.applyDiscounts({
            merchantId: MERCHANT_ID,
            dryRun: false
        });

        expect(results.applied).toHaveLength(1);
        expect(results.applied[0].discountedPrice).toBe(750); // 1000 * (1 - 25/100)
        expect(results.applied[0].originalPrice).toBe(1000);
        expect(results.applied[0].discountPercent).toBe(25);
    });

    it('calculates 50% discount correctly (1099 → 550)', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 90,
                    tier_code: 'AUTO50',
                    discount_percent: 50,
                    is_auto_apply: true,
                    is_active: true,
                    merchant_id: MERCHANT_ID,
                    square_discount_id: 'SQ_DISC_50'
                }]
            })
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    original_price_cents: 1099,
                    current_price_cents: 1099,
                    sku: 'SKU001',
                    item_name: 'Cat Treats'
                }]
            });

        mockSquareApi.makeSquareRequest
            .mockResolvedValueOnce({ objects: [{ id: 'var1' }] })
            .mockResolvedValueOnce({ objects: [] })
            .mockResolvedValueOnce({ objects: [{ type: 'PRICING_RULE', id: 'PR1' }] });

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const results = await discountService.applyDiscounts({
            merchantId: MERCHANT_ID,
            dryRun: false
        });

        expect(results.applied[0].discountedPrice).toBe(550); // Math.round(1099 * 0.5)
    });

    it('removes discounts from items no longer in auto-apply tiers', async () => {
        db.query
            // No auto-apply tiers
            .mockResolvedValueOnce({ rows: [] })
            // Items with discounts that are now in non-auto-apply tiers
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    original_price_cents: 1000,
                    discounted_price_cents: 750,
                    discount_applied_at: new Date(),
                    tier_code: 'OK',
                    is_auto_apply: false
                }]
            })
            // UPDATE discount status (clear)
            .mockResolvedValueOnce({ rows: [] })
            // INSERT audit log
            .mockResolvedValueOnce({ rows: [] });

        const results = await discountService.applyDiscounts({
            merchantId: MERCHANT_ID,
            dryRun: false
        });

        expect(results.removed).toHaveLength(1);
        expect(results.removed[0].variationId).toBe('var1');
    });
});

// ----------------------------------------------------------------------------
// Square discount management
// ----------------------------------------------------------------------------

describe('upsertSquareDiscount', () => {
    it('creates new discount when no square_discount_id', async () => {
        const tier = { ...MOCK_TIERS[1], square_discount_id: null };

        mockSquareApi.makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'NEW_DISC_ID', version: 1 }
        });
        db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE tier with new ID

        const result = await discountService.upsertSquareDiscount(tier);

        expect(result.success).toBe(true);
        expect(result.discountId).toBe('NEW_DISC_ID');
        expect(mockSquareApi.makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/object',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('updates existing discount with version', async () => {
        const tier = { ...MOCK_TIERS[1] };

        // Retrieve existing
        mockSquareApi.makeSquareRequest.mockResolvedValueOnce({
            object: { id: 'SQ_DISC_50', version: 5, discount_data: {} }
        });
        // Upsert
        mockSquareApi.makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'SQ_DISC_50', version: 6 }
        });

        const result = await discountService.upsertSquareDiscount(tier);

        expect(result.success).toBe(true);
        expect(result.discountId).toBe('SQ_DISC_50');
    });

    it('handles deleted discount in Square gracefully', async () => {
        const tier = { ...MOCK_TIERS[1] };

        // Retrieve fails (deleted in Square)
        mockSquareApi.makeSquareRequest.mockRejectedValueOnce(new Error('NOT_FOUND'));
        // Clear stale ID
        db.query.mockResolvedValueOnce({ rows: [] });
        // Create new
        mockSquareApi.makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'NEW_DISC_ID', version: 1 }
        });
        // Update tier record
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await discountService.upsertSquareDiscount(tier);

        expect(result.success).toBe(true);
        expect(result.discountId).toBe('NEW_DISC_ID');
    });
});

describe('filterValidVariations (via upsertPricingRule)', () => {
    it('marks invalid variations as deleted in DB', async () => {
        const tier = { ...MOCK_TIERS[1] };

        // filterValidVariations
        mockSquareApi.makeSquareRequest
            // batch-retrieve: only var1 exists
            .mockResolvedValueOnce({ objects: [{ id: 'var1' }] })
            // search for existing rule
            .mockResolvedValueOnce({ objects: [] })
            // batch-upsert
            .mockResolvedValueOnce({ objects: [{ type: 'PRICING_RULE', id: 'PR1' }] });

        // DB calls for filter cleanup + pricing rule update
        db.query
            .mockResolvedValueOnce({ rows: [] })  // UPDATE variations is_deleted
            .mockResolvedValueOnce({ rows: [] })  // DELETE variation_discount_status
            .mockResolvedValueOnce({ rows: [] }); // UPDATE tier

        await discountService.upsertPricingRule(tier, ['var1', 'var2_deleted']);

        // Verify var2_deleted was cleaned up
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE variations SET is_deleted = TRUE'),
            expect.arrayContaining([['var2_deleted'], MERCHANT_ID])
        );
    });
});

// ----------------------------------------------------------------------------
// initializeDefaultTiers
// ----------------------------------------------------------------------------

describe('initializeDefaultTiers', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.initializeDefaultTiers(null))
            .rejects.toThrow('merchantId is required');
    });

    it('creates 5 default tiers for new merchant', async () => {
        // No existing tiers
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        // INSERT calls for 5 tiers + 4 settings = 9
        for (let i = 0; i < 9; i++) {
            db.query.mockResolvedValueOnce({ rows: [] });
        }

        const result = await discountService.initializeDefaultTiers(MERCHANT_ID);

        expect(result.created).toBe(true);
        expect(result.tierCount).toBe(5);
    });

    it('skips if merchant already has tiers', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '3' }] });

        const result = await discountService.initializeDefaultTiers(MERCHANT_ID);

        expect(result.created).toBe(false);
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});

describe('ensureMerchantTiers', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.ensureMerchantTiers(null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns existing tiers without creating', async () => {
        db.query.mockResolvedValueOnce({ rows: MOCK_TIERS });

        const result = await discountService.ensureMerchantTiers(MERCHANT_ID);

        expect(result.created).toBe(false);
        expect(result.tierCount).toBe(5);
    });
});

// ----------------------------------------------------------------------------
// clearExpiryDiscountForReorder
// ----------------------------------------------------------------------------

describe('clearExpiryDiscountForReorder', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.clearExpiryDiscountForReorder(null, 'var1'))
            .rejects.toThrow('merchantId is required');
    });

    it('throws without variationId', async () => {
        await expect(discountService.clearExpiryDiscountForReorder(MERCHANT_ID, null))
            .rejects.toThrow('variationId is required');
    });

    it('returns cleared=false when no discount status exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await discountService.clearExpiryDiscountForReorder(MERCHANT_ID, 'var1');

        expect(result.cleared).toBe(false);
        expect(result.message).toContain('No discount status found');
    });

    it('returns cleared=false for non-auto-apply tier (OK)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                status_id: 1,
                current_tier_id: 10,
                tier_code: 'OK',
                is_auto_apply: false,
                discounted_price_cents: null,
                discount_applied_at: null
            }]
        });

        const result = await discountService.clearExpiryDiscountForReorder(MERCHANT_ID, 'var1');

        expect(result.cleared).toBe(false);
        expect(result.previousTier).toBe('OK');
    });

    it('clears discount for AUTO50 tier using transaction', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                status_id: 1,
                current_tier_id: 90,
                tier_code: 'AUTO50',
                is_auto_apply: true,
                discounted_price_cents: 500,
                discount_applied_at: new Date()
            }]
        });

        // OK tier lookup
        db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });

        // Transaction mock (from setup.js) will call client.query for each step
        const result = await discountService.clearExpiryDiscountForReorder(MERCHANT_ID, 'var1');

        expect(result.cleared).toBe(true);
        expect(result.previousTier).toBe('AUTO50');
        expect(db.transaction).toHaveBeenCalled();
    });

    it('throws when OK tier not found', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    status_id: 1,
                    current_tier_id: 90,
                    tier_code: 'AUTO50',
                    is_auto_apply: true,
                    discounted_price_cents: 500,
                    discount_applied_at: new Date()
                }]
            })
            .mockResolvedValueOnce({ rows: [] }); // No OK tier

        await expect(discountService.clearExpiryDiscountForReorder(MERCHANT_ID, 'var1'))
            .rejects.toThrow('OK tier not found');
    });
});

// ----------------------------------------------------------------------------
// resolveFlaggedVariation
// ----------------------------------------------------------------------------

describe('resolveFlaggedVariation', () => {
    it('requires merchantId', async () => {
        await expect(discountService.resolveFlaggedVariation({}))
            .rejects.toThrow('merchantId is required');
    });

    it('requires note', async () => {
        await expect(discountService.resolveFlaggedVariation({
            merchantId: MERCHANT_ID,
            variationId: 'var1',
            action: 'keep_current',
            note: ''
        })).rejects.toThrow('note is required');
    });

    it('returns error for unknown variation', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await discountService.resolveFlaggedVariation({
            merchantId: MERCHANT_ID,
            variationId: 'var1',
            action: 'keep_current',
            note: 'Keeping current tier'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('keeps current tier when action=keep_current', async () => {
        db.query
            // Get current state
            .mockResolvedValueOnce({
                rows: [{
                    current_tier_id: 90,
                    current_tier_code: 'AUTO50',
                    days_until_expiry: 15,
                    needs_manual_review: true
                }]
            })
            // UPDATE clear flag
            .mockResolvedValueOnce({ rows: [] })
            // INSERT audit log
            .mockResolvedValueOnce({ rows: [] });

        const result = await discountService.resolveFlaggedVariation({
            merchantId: MERCHANT_ID,
            variationId: 'var1',
            action: 'keep_current',
            note: 'Expiry date was updated'
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('kept');
    });

    it('applies new tier when action=apply_new', async () => {
        const future60 = new Date();
        future60.setDate(future60.getDate() + 60);

        db.query
            // Get current state
            .mockResolvedValueOnce({
                rows: [{
                    current_tier_id: 90,
                    current_tier_code: 'AUTO50',
                    days_until_expiry: 15,
                    needs_manual_review: true
                }]
            })
            // getActiveTiers
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            // getSetting (timezone)
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] })
            // Get expiration date
            .mockResolvedValueOnce({
                rows: [{ expiration_date: future60.toISOString().slice(0, 10) }]
            })
            // UPDATE tier
            .mockResolvedValueOnce({ rows: [] })
            // INSERT audit log
            .mockResolvedValueOnce({ rows: [] });

        const result = await discountService.resolveFlaggedVariation({
            merchantId: MERCHANT_ID,
            variationId: 'var1',
            action: 'apply_new',
            note: 'Confirmed new date is correct'
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('applied');
        expect(result.newTier).toBe('AUTO25'); // 60 days → AUTO25
    });

    it('returns error for invalid action', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ current_tier_id: 90, current_tier_code: 'AUTO50' }]
        });

        const result = await discountService.resolveFlaggedVariation({
            merchantId: MERCHANT_ID,
            variationId: 'var1',
            action: 'invalid_action',
            note: 'test'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid action');
    });
});

// ----------------------------------------------------------------------------
// runExpiryDiscountAutomation (integration)
// ----------------------------------------------------------------------------

describe('runExpiryDiscountAutomation', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.runExpiryDiscountAutomation({}))
            .rejects.toThrow('merchantId is required');
    });

    it('runs full automation in dry run mode', async () => {
        const future15 = new Date();
        future15.setDate(future15.getDate() + 15);

        db.query
            // evaluateAllVariations → getActiveTiers
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            // evaluateAllVariations → variations query
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    item_id: 'item1',
                    variation_name: 'Size A',
                    sku: 'SKU001',
                    current_price_cents: 1000,
                    item_name: 'Dog Food',
                    expiration_date: future15.toISOString().slice(0, 10),
                    does_not_expire: false,
                    current_tier_id: null,
                    original_price_cents: null,
                    discounted_price_cents: null
                }]
            })
            // evaluateAllVariations → getSetting (timezone)
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] });

        const results = await discountService.runExpiryDiscountAutomation({
            merchantId: MERCHANT_ID,
            dryRun: true
        });

        expect(results.success).toBe(true);
        expect(results.evaluation).not.toBeNull();
        expect(results.evaluation.newAssignments).toHaveLength(1);
        // Dry run: no discountInit or discountApplication
        expect(results.discountInit).toBeNull();
        expect(results.discountApplication).toBeNull();
    });

    it('captures errors in sub-steps without failing entirely', async () => {
        // initializeSquareDiscounts fails
        db.query
            // initializeSquareDiscounts → get auto-apply tiers
            .mockRejectedValueOnce(new Error('DB down'))
            // evaluateAllVariations → getActiveTiers
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            // evaluateAllVariations → variations query
            .mockResolvedValueOnce({ rows: [] })
            // getSetting (timezone)
            .mockResolvedValueOnce({ rows: [] })
            // applyDiscounts → get auto-apply tiers
            .mockResolvedValueOnce({ rows: [] })
            // applyDiscounts → removed items query
            .mockResolvedValueOnce({ rows: [] })
            // updateSetting (last_run_at)
            .mockResolvedValueOnce({ rows: [] });

        const results = await discountService.runExpiryDiscountAutomation({
            merchantId: MERCHANT_ID,
            dryRun: false
        });

        expect(results.success).toBe(false);
        expect(results.errors.length).toBeGreaterThan(0);
        expect(results.errors[0].step).toBe('discountInit');
        expect(results.duration).toBeGreaterThanOrEqual(0);
    });
});

// ----------------------------------------------------------------------------
// validateExpiryDiscounts
// ----------------------------------------------------------------------------

describe('validateExpiryDiscounts', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.validateExpiryDiscounts({}))
            .rejects.toThrow('merchantId is required');
    });

    it('detects percentage mismatch', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                ...MOCK_TIERS[1],
                square_discount_id: 'SQ_DISC_50'
            }]
        });

        // Square returns wrong percentage
        mockSquareApi.makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    id: 'SQ_DISC_50',
                    discount_data: { percentage: '30' }, // Should be 50
                    is_deleted: false
                }
            });

        // Pricing rule search
        mockSquareApi.makeSquareRequest.mockResolvedValueOnce({ objects: [] });
        // Variations in tier
        db.query.mockResolvedValueOnce({ rows: [] });

        const results = await discountService.validateExpiryDiscounts({
            merchantId: MERCHANT_ID,
            fix: false
        });

        expect(results.issues).toHaveLength(1);
        expect(results.issues[0].issue).toBe('PERCENTAGE_MISMATCH');
        expect(results.issues[0].squarePercent).toBe(30);
        expect(results.issues[0].expectedPercent).toBe(50);
    });
});

// ----------------------------------------------------------------------------
// getDiscountStatusSummary
// ----------------------------------------------------------------------------

describe('getDiscountStatusSummary', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.getDiscountStatusSummary(null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns summary with tier counts', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [
                    { tier_code: 'AUTO50', is_auto_apply: true, variation_count: '3', needs_pull_count: '0' },
                    { tier_code: 'AUTO25', is_auto_apply: true, variation_count: '5', needs_pull_count: '0' },
                    { tier_code: 'OK', is_auto_apply: false, variation_count: '20', needs_pull_count: '0' }
                ]
            })
            // getSetting (last_run_at)
            .mockResolvedValueOnce({ rows: [{ setting_value: '2026-03-15T06:00:00Z' }] });

        const summary = await discountService.getDiscountStatusSummary(MERCHANT_ID);

        expect(summary.tiers).toHaveLength(3);
        expect(summary.totalWithDiscounts).toBe(8); // 3 + 5
        expect(summary.lastRunAt).toBe('2026-03-15T06:00:00Z');
    });
});

// ----------------------------------------------------------------------------
// getVariationsInTier / getAuditLog / getFlaggedVariations
// ----------------------------------------------------------------------------

describe('getVariationsInTier', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.getVariationsInTier('AUTO50', null))
            .rejects.toThrow('merchantId is required');
    });

    it('returns variations with pagination', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ variation_id: 'var1', sku: 'SKU001', days_until_expiry: 10 }]
        });

        const result = await discountService.getVariationsInTier('AUTO50', MERCHANT_ID, { limit: 50, offset: 0 });

        expect(result).toHaveLength(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('LIMIT'),
            [MERCHANT_ID, 'AUTO50', 50, 0]
        );
    });
});

describe('getAuditLog', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.getAuditLog(null))
            .rejects.toThrow('merchantId is required');
    });

    it('filters by variationId', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, action: 'TIER_CHANGED' }] });

        await discountService.getAuditLog(MERCHANT_ID, { variationId: 'var1' });

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('al.variation_id = $2'),
            expect.arrayContaining([MERCHANT_ID, 'var1'])
        );
    });
});

describe('getFlaggedVariations', () => {
    it('throws without merchantId', async () => {
        await expect(discountService.getFlaggedVariations(null))
            .rejects.toThrow('merchantId is required');
    });

    it('includes calculated tier info', async () => {
        const future60 = new Date();
        future60.setDate(future60.getDate() + 60);

        db.query
            // Main query
            .mockResolvedValueOnce({
                rows: [{
                    variation_id: 'var1',
                    days_until_expiry: 60,
                    current_tier_code: 'AUTO50',
                    needs_manual_review: true,
                    expiration_date: future60.toISOString().slice(0, 10)
                }]
            })
            // getActiveTiers
            .mockResolvedValueOnce({ rows: MOCK_TIERS })
            // getSetting (timezone)
            .mockResolvedValueOnce({ rows: [{ setting_value: 'America/Toronto' }] });

        const flagged = await discountService.getFlaggedVariations(MERCHANT_ID);

        expect(flagged).toHaveLength(1);
        expect(flagged[0].calculated_tier_code).toBe('AUTO25'); // 60 days
    });
});

// ----------------------------------------------------------------------------
// trackExpiryDiscountSale (BACKLOG-94)
// ----------------------------------------------------------------------------

describe('trackExpiryDiscountSale', () => {
    it('increments units_sold_at_discount and returns tracked=true', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ units_sold_at_discount: 3, expiring_quantity: 10, needs_manual_review: false }]
        });

        const result = await discountService.trackExpiryDiscountSale('VAR-1', 2, MERCHANT_ID);

        expect(result).toEqual({ tracked: true, flagged: false });
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('units_sold_at_discount'),
            [2, 'VAR-1', MERCHANT_ID]
        );
    });

    it('flags for manual review when threshold reached', async () => {
        // First query: UPDATE RETURNING — units_sold now equals expiring_quantity
        db.query.mockResolvedValueOnce({
            rows: [{ units_sold_at_discount: 10, expiring_quantity: 10, needs_manual_review: false }]
        });
        // Second query: SET needs_manual_review = TRUE
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // Third query: logAuditEvent INSERT
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const result = await discountService.trackExpiryDiscountSale('VAR-1', 2, MERCHANT_ID);

        expect(result).toEqual({ tracked: true, flagged: true });
        expect(db.query).toHaveBeenCalledTimes(3);
        // Verify the flag update query
        expect(db.query).toHaveBeenNthCalledWith(2,
            expect.stringContaining('needs_manual_review = TRUE'),
            ['VAR-1', MERCHANT_ID]
        );
    });

    it('returns tracked=false when no matching discount status (null expiring_quantity)', async () => {
        // UPDATE returns no rows — variation has no expiring_quantity set
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await discountService.trackExpiryDiscountSale('VAR-1', 1, MERCHANT_ID);

        expect(result).toEqual({ tracked: false, flagged: false });
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('returns tracked=false for invalid inputs', async () => {
        expect(await discountService.trackExpiryDiscountSale(null, 1, MERCHANT_ID))
            .toEqual({ tracked: false, flagged: false });
        expect(await discountService.trackExpiryDiscountSale('VAR-1', 0, MERCHANT_ID))
            .toEqual({ tracked: false, flagged: false });
        expect(await discountService.trackExpiryDiscountSale('VAR-1', 1, null))
            .toEqual({ tracked: false, flagged: false });
        // No DB calls for invalid inputs
        expect(db.query).not.toHaveBeenCalled();
    });

    it('does not re-flag if already flagged for manual review', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ units_sold_at_discount: 15, expiring_quantity: 10, needs_manual_review: true }]
        });

        const result = await discountService.trackExpiryDiscountSale('VAR-1', 1, MERCHANT_ID);

        expect(result).toEqual({ tracked: true, flagged: false });
        // Only the initial UPDATE, no flag update or audit log
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});
