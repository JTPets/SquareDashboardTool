/**
 * Tests for saveExpirations reviewed_at tier-change guard
 *
 * Bug: reviewed_at was cleared unconditionally whenever an item was in AUTO25/AUTO50,
 * even when the tier hadn't changed. This caused already-stickered items to reappear
 * in the expiry audit queue after any re-save of the same date.
 *
 * Fix: Only clear reviewed_at when the tier actually changes (or item is new).
 */

const db = require('../../../utils/database');

const mockUpdateCustomAttributeValues = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../../services/square', () => ({
    updateCustomAttributeValues: mockUpdateCustomAttributeValues,
}));

// Mock tiers: OK (121+), AUTO25 (61-120), AUTO50 (1-60), EXPIRED (≤0)
const TIERS = [
    { id: 5, tier_code: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null, discount_percent: 0, is_auto_apply: false },
    { id: 4, tier_code: 'REVIEW', min_days_to_expiry: 91, max_days_to_expiry: 120, discount_percent: 0, is_auto_apply: false },
    { id: 3, tier_code: 'AUTO25', min_days_to_expiry: 61, max_days_to_expiry: 90, discount_percent: 25, is_auto_apply: true },
    { id: 2, tier_code: 'AUTO50', min_days_to_expiry: 1, max_days_to_expiry: 60, discount_percent: 50, is_auto_apply: true },
    { id: 1, tier_code: 'EXPIRED', min_days_to_expiry: null, max_days_to_expiry: 0, discount_percent: 100, is_auto_apply: true },
];

jest.mock('../../../services/expiry', () => ({
    calculateDaysUntilExpiry: jest.fn(),
    getActiveTiers: jest.fn().mockResolvedValue(TIERS),
    determineTier: jest.fn(),
}));

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));

const expiryDiscount = require('../../../services/expiry');
const { saveExpirations } = require('../../../services/catalog/inventory-service');

const MERCHANT_ID = 1;
const VARIATION_ID = 'VAR_TEST_001';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('saveExpirations — reviewed_at tier-change guard', () => {
    it('does NOT clear reviewed_at when re-saving same date in same tier', async () => {
        // Item is already in AUTO25 tier, re-saving same date should not reset sticker verification
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(75);
        expiryDiscount.determineTier.mockReturnValue(TIERS[2]); // AUTO25

        // 1. Variation ownership check
        db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
        // 2. Upsert variation_expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // 3. Existing status query — item already in AUTO25
        db.query.mockResolvedValueOnce({ rows: [{ current_tier_id: 3, tier_code: 'AUTO25' }] });
        // 4. Upsert variation_discount_status
        db.query.mockResolvedValueOnce({ rows: [] });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-06-01',
            does_not_expire: false,
        }]);

        // Verify reviewed_at was NOT cleared (no UPDATE with reviewed_at = NULL)
        const allCalls = db.query.mock.calls;
        const reviewedAtClears = allCalls.filter(call =>
            typeof call[0] === 'string' && call[0].includes('reviewed_at = NULL')
        );
        expect(reviewedAtClears).toHaveLength(0);
    });

    it('DOES clear reviewed_at when tier changes (OK → AUTO25)', async () => {
        // Item was OK, date changed to put it in AUTO25 — needs new sticker
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(75);
        expiryDiscount.determineTier.mockReturnValue(TIERS[2]); // AUTO25

        // 1. Variation ownership check
        db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
        // 2. Upsert variation_expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // 3. Existing status — item was in OK tier
        db.query.mockResolvedValueOnce({ rows: [{ current_tier_id: 5, tier_code: 'OK' }] });
        // 4. Clear reviewed_at
        db.query.mockResolvedValueOnce({ rows: [] });
        // 5. Upsert variation_discount_status
        db.query.mockResolvedValueOnce({ rows: [] });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-06-01',
            does_not_expire: false,
        }]);

        // Verify reviewed_at WAS cleared
        const allCalls = db.query.mock.calls;
        const reviewedAtClears = allCalls.filter(call =>
            typeof call[0] === 'string' && call[0].includes('reviewed_at = NULL')
        );
        expect(reviewedAtClears).toHaveLength(1);
    });

    it('DOES clear reviewed_at when tier escalates (AUTO25 → AUTO50)', async () => {
        // Item was AUTO25, date moved closer so now AUTO50 — needs new 50% sticker
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(30);
        expiryDiscount.determineTier.mockReturnValue(TIERS[3]); // AUTO50

        // 1. Variation ownership check
        db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
        // 2. Upsert variation_expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // 3. Existing status — item was in AUTO25
        db.query.mockResolvedValueOnce({ rows: [{ current_tier_id: 3, tier_code: 'AUTO25' }] });
        // 4. Clear reviewed_at
        db.query.mockResolvedValueOnce({ rows: [] });
        // 5. Mark manually overridden (was non-OK)
        db.query.mockResolvedValueOnce({ rows: [] });
        // 6. Upsert variation_discount_status
        db.query.mockResolvedValueOnce({ rows: [] });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-04-10',
            does_not_expire: false,
        }]);

        const allCalls = db.query.mock.calls;
        const reviewedAtClears = allCalls.filter(call =>
            typeof call[0] === 'string' && call[0].includes('reviewed_at = NULL')
        );
        expect(reviewedAtClears).toHaveLength(1);
    });

    it('DOES clear reviewed_at for new item with no existing status', async () => {
        // Brand new item, no variation_discount_status row yet
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(45);
        expiryDiscount.determineTier.mockReturnValue(TIERS[3]); // AUTO50

        // 1. Variation ownership check
        db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
        // 2. Upsert variation_expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // 3. Existing status — no row (new item)
        db.query.mockResolvedValueOnce({ rows: [] });
        // 4. Clear reviewed_at (null !== 'AUTO50')
        db.query.mockResolvedValueOnce({ rows: [] });
        // 5. Upsert variation_discount_status
        db.query.mockResolvedValueOnce({ rows: [] });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-04-25',
            does_not_expire: false,
        }]);

        const allCalls = db.query.mock.calls;
        const reviewedAtClears = allCalls.filter(call =>
            typeof call[0] === 'string' && call[0].includes('reviewed_at = NULL')
        );
        expect(reviewedAtClears).toHaveLength(1);
    });

    it('does NOT clear reviewed_at when tier is not AUTO25/AUTO50', async () => {
        // Item in OK tier — no sticker needed, reviewed_at should not be touched
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(200);
        expiryDiscount.determineTier.mockReturnValue(TIERS[0]); // OK

        // 1. Variation ownership check
        db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
        // 2. Upsert variation_expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // 3. Existing status
        db.query.mockResolvedValueOnce({ rows: [] });
        // 4. Upsert variation_discount_status
        db.query.mockResolvedValueOnce({ rows: [] });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-12-01',
            does_not_expire: false,
        }]);

        const allCalls = db.query.mock.calls;
        const reviewedAtClears = allCalls.filter(call =>
            typeof call[0] === 'string' && call[0].includes('reviewed_at = NULL')
        );
        expect(reviewedAtClears).toHaveLength(0);
    });
});
