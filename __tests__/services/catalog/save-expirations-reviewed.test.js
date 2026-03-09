/**
 * Tests for saveExpirations reviewed_at guards
 *
 * Bug 1: reviewed_at was cleared unconditionally whenever an item was in AUTO25/AUTO50,
 * even when the tier hadn't changed. Fixed: only clear on actual tier change.
 *
 * Bug 2: reviewed_at was cleared before the Square push. If Square rejected the push
 * (e.g. 400 location mismatch), reviewed_at was already gone — item reappeared in
 * audit queue despite nothing changing in Square. Fixed: defer clear until after
 * successful Square push.
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

/** Helper: count how many db.query calls contain "reviewed_at = NULL" */
function countReviewedAtClears() {
    return db.query.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('reviewed_at = NULL')
    ).length;
}

/**
 * Set up db mocks for the standard saveExpirations flow.
 *
 * Query sequence:
 *   1. Variation ownership check
 *   2. Upsert variation_expiration
 *   3. Existing status query (existingStatus)
 *   4. (conditional) Mark manually overridden — if existing tier is non-OK
 *   5. Upsert variation_discount_status
 *   -- Square push happens here (mocked separately) --
 *   6. (conditional) Clear reviewed_at — only on tier change + successful push
 */
function setupDbMocks({ existingTier = null, isNonOkTier = false } = {}) {
    // 1. Variation ownership check
    db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
    // 2. Upsert variation_expiration
    db.query.mockResolvedValueOnce({ rows: [] });
    // 3. Existing status
    if (existingTier) {
        db.query.mockResolvedValueOnce({ rows: [existingTier] });
    } else {
        db.query.mockResolvedValueOnce({ rows: [] });
    }
    // 4. Mark manually overridden (only if existing tier is non-OK)
    if (isNonOkTier) {
        db.query.mockResolvedValueOnce({ rows: [] });
    }
    // 5. Upsert variation_discount_status
    db.query.mockResolvedValueOnce({ rows: [] });
    // 6. Clear reviewed_at (conditional — may or may not be called)
    db.query.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
    // Full reset — restoreMocks in jest config may leave mocks in an inconsistent state.
    // mockReset clears calls, instances, results, AND implementation/once-queue.
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
    mockUpdateCustomAttributeValues.mockReset();
    mockUpdateCustomAttributeValues.mockResolvedValue({ success: true });
    // Re-apply expiry mocks (restoreMocks clears these too)
    expiryDiscount.calculateDaysUntilExpiry.mockReset();
    expiryDiscount.getActiveTiers.mockReset();
    expiryDiscount.getActiveTiers.mockResolvedValue(TIERS);
    expiryDiscount.determineTier.mockReset();
});

describe('saveExpirations — reviewed_at tier-change guard', () => {
    it('does NOT clear reviewed_at when re-saving same date in same tier', async () => {
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(75);
        expiryDiscount.determineTier.mockReturnValue(TIERS[2]); // AUTO25

        setupDbMocks({ existingTier: { current_tier_id: 3, tier_code: 'AUTO25' } });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-06-01',
            does_not_expire: false,
        }]);

        expect(countReviewedAtClears()).toBe(0);
    });

    it('DOES clear reviewed_at when tier changes (OK → AUTO25)', async () => {
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(75);
        expiryDiscount.determineTier.mockReturnValue(TIERS[2]); // AUTO25

        setupDbMocks({ existingTier: { current_tier_id: 5, tier_code: 'OK' } });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-06-01',
            does_not_expire: false,
        }]);

        expect(countReviewedAtClears()).toBe(1);
    });

    it('DOES clear reviewed_at when tier escalates (AUTO25 → AUTO50)', async () => {
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(30);
        expiryDiscount.determineTier.mockReturnValue(TIERS[3]); // AUTO50

        setupDbMocks({
            existingTier: { current_tier_id: 3, tier_code: 'AUTO25' },
            isNonOkTier: true,
        });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-04-10',
            does_not_expire: false,
        }]);

        expect(countReviewedAtClears()).toBe(1);
    });

    it('DOES clear reviewed_at for new item with no existing status', async () => {
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(45);
        expiryDiscount.determineTier.mockReturnValue(TIERS[3]); // AUTO50

        setupDbMocks({ existingTier: null });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-04-25',
            does_not_expire: false,
        }]);

        expect(countReviewedAtClears()).toBe(1);
    });

    it('does NOT clear reviewed_at when tier is not AUTO25/AUTO50', async () => {
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(200);
        expiryDiscount.determineTier.mockReturnValue(TIERS[0]); // OK

        setupDbMocks({ existingTier: null });

        await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-12-01',
            does_not_expire: false,
        }]);

        expect(countReviewedAtClears()).toBe(0);
    });
});

describe('saveExpirations — reviewed_at deferred until Square push succeeds', () => {
    it('does NOT clear reviewed_at when Square push fails', async () => {
        // Tier changes OK → AUTO25, but Square rejects with 400
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(75);
        expiryDiscount.determineTier.mockReturnValue(TIERS[2]); // AUTO25
        mockUpdateCustomAttributeValues.mockReset();
        mockUpdateCustomAttributeValues.mockRejectedValue(new Error('400 location mismatch'));

        setupDbMocks({ existingTier: { current_tier_id: 5, tier_code: 'OK' } });

        const result = await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-06-01',
            does_not_expire: false,
        }]);

        // Local save should still succeed
        expect(result.success).toBe(true);
        expect(result.squarePush.failed).toBe(1);

        // reviewed_at must NOT be cleared since Square rejected the push
        expect(countReviewedAtClears()).toBe(0);
    });

    it('DOES clear reviewed_at when Square push succeeds on tier change', async () => {
        // Tier changes OK → AUTO50 and Square push succeeds
        expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(30);
        expiryDiscount.determineTier.mockReturnValue(TIERS[3]); // AUTO50
        mockUpdateCustomAttributeValues.mockReset();
        mockUpdateCustomAttributeValues.mockResolvedValue({ success: true });

        setupDbMocks({ existingTier: { current_tier_id: 5, tier_code: 'OK' } });

        const result = await saveExpirations(MERCHANT_ID, [{
            variation_id: VARIATION_ID,
            expiration_date: '2026-04-10',
            does_not_expire: false,
        }]);

        expect(result.success).toBe(true);
        expect(result.squarePush.success).toBe(1);

        // reviewed_at should be cleared — push succeeded and tier changed
        expect(countReviewedAtClears()).toBe(1);
    });
});
