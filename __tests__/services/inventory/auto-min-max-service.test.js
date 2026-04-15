/**
 * Auto Min/Max Stock Recommendation Service Tests
 *
 * Tests for all business rules, eligibility checks, and new v2 operations.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../services/square/square-inventory', () => ({
    pushMinStockThresholdsToSquare: jest.fn().mockResolvedValue({ pushed: 1, failed: 0 }),
}));

const db = require('../../../utils/database');
const emailNotifier = require('../../../utils/email-notifier');
const squareInventory = require('../../../services/square/square-inventory');
const service = require('../../../services/inventory/auto-min-max-service');

const MERCHANT_ID = 1;

// Helper: build a data row matching the query output
function makeRow(overrides = {}) {
    return {
        variation_id: 'var1',
        location_id: 'loc1',
        variation_name: 'Test Variation',
        item_name: 'Test Item',
        sku: 'SKU001',
        velocity_91d: '0',
        quantity: '0',
        days_of_stock: '999999',
        current_min: '0',
        current_max: null,
        min_stock_pinned: false,
        expiry_tier: null,
        item_created_at: oldItemDate(),  // old enough by default
        total_quantity_sold_91d: null,
        last_received_at: null,
        last_auto_increase_at: null,
        ...overrides,
    };
}

// Helper: ISO timestamp N days ago
function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: item created > 91 days ago (eligible)
function oldItemDate() {
    return new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: item created < 91 days ago (too new)
function newItemDate() {
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: velocity last_sync fresh (1 day ago)
function freshSyncDate() {
    return new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: velocity last_sync stale (8 days ago)
function staleSyncDate() {
    return new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== generateRecommendations ====================

describe('generateRecommendations', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.generateRecommendations(null))
            .rejects.toThrow('merchantId is required');
    });

    // --- Eligibility: pinned item ---

    test('Pinned item: skipped with skipped=pinned and recommendedMin=null', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ min_stock_pinned: true, days_of_stock: '95', current_min: '2' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBe('pinned');
        expect(recs[0].recommendedMin).toBeNull();
    });

    // --- Eligibility: item too new ---

    test('New item (< 91 days): skipped with skipped=tooNew', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ item_created_at: newItemDate(), days_of_stock: '95', current_min: '2' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBe('tooNew');
        expect(recs[0].recommendedMin).toBeNull();
    });

    test('New item with no created_at: skipped with skipped=tooNew', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ item_created_at: null, days_of_stock: '95', current_min: '2' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBe('tooNew');
    });

    // --- Eligibility order: new item check runs before pin check ---

    test('New item > 91 days → proceeds to rule evaluation (not skipped)', async () => {
        // qty=9, min=2, vel=0.5 → (9-2)=7 <= 0.5*14=7 → proximity check passes → OVERSTOCKED fires
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ item_created_at: oldItemDate(), days_of_stock: '95',
                current_min: '2', velocity_91d: '0.5', quantity: '9' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBeUndefined();
        expect(recs[0].rule).toBe('OVERSTOCKED');
    });

    test('min_stock_pinned = FALSE → proceeds to rule evaluation (not skipped)', async () => {
        // qty=9, min=2, vel=0.5 → proximity check passes → rule evaluates (not skipped due to pin)
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ min_stock_pinned: false, days_of_stock: '95',
                current_min: '2', velocity_91d: '0.5', quantity: '9' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBeUndefined();
    });

    // --- Rule 1: Overstocked slow mover (with proximity check) ---

    test('Rule 1: overstocked, stock near min → recommend min - 1', async () => {
        // qty=9, min=2, vel=0.5 → (9-2)=7 <= 0.5*14=7 → fires
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '9' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('OVERSTOCKED');
    });

    test('Rule 1: overstocked, stock far above min → no recommendation (proximity check fails)', async () => {
        // qty=50, min=2, vel=0.5 → (50-2)=48 > 0.5*14=7 → skip (min won't trigger reorder for months)
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '50' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 1: days_of_stock 80, stock near min → no recommendation (not overstocked)', async () => {
        // dos < 90 → Rule 1 does not fire regardless of proximity
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '80', current_min: '2', velocity_91d: '0.5', quantity: '9' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 1: days_of_stock 95, min 0 → no recommendation (already 0)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '0', velocity_91d: '0.01', quantity: '1' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 1: REORDER_PROXIMITY_DAYS env var is respected', async () => {
        // With proximityDays=7: threshold = 0.5*7 = 3.5
        // qty=6, min=2 → (6-2)=4 > 3.5 → no rec; qty=5, min=2 → (5-2)=3 <= 3.5 → fires
        const saved = process.env.REORDER_PROXIMITY_DAYS;
        process.env.REORDER_PROXIMITY_DAYS = '7';
        try {
            db.query.mockResolvedValueOnce({ rows: [
                makeRow({ days_of_stock: '100', current_min: '2', velocity_91d: '0.5', quantity: '6' })
            ]});
            const recsNoFire = await service.generateRecommendations(MERCHANT_ID);
            expect(recsNoFire).toHaveLength(0);

            db.query.mockResolvedValueOnce({ rows: [
                makeRow({ days_of_stock: '100', current_min: '2', velocity_91d: '0.5', quantity: '5' })
            ]});
            const recsFire = await service.generateRecommendations(MERCHANT_ID);
            expect(recsFire).toHaveLength(1);
            expect(recsFire[0].rule).toBe('OVERSTOCKED');
            expect(recsFire[0].reason).toMatch(/7 days/);
        } finally {
            if (saved === undefined) delete process.env.REORDER_PROXIMITY_DAYS;
            else process.env.REORDER_PROXIMITY_DAYS = saved;
        }
    });

    // --- Rule 2: Sold out fast mover ---

    test('Rule 2: quantity 0, velocity 0.2, min 0, recently sold → recommend 1', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('SOLDOUT_FAST_MOVER');
    });

    test('Rule 2: quantity 0, velocity 0.2, total_quantity_sold_91d = 0 → included as warning (null min)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 0 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
        expect(recs[0].reason).toMatch(/possible supplier issue/);
    });

    test('Rule 2: quantity 0, velocity 0.019 → no recommendation (under 0.02)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.019', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 2: quantity 0, velocity 0.02 → recommend 1 (at threshold)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.02', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('SOLDOUT_FAST_MOVER');
    });

    test('Rule 2: quantity 0, velocity 0.022 (Cod Fillet case) → recommend 1', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.022', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('SOLDOUT_FAST_MOVER');
    });

    test('Rule 2: quantity 0, total_quantity_sold_91d is null → treated as no recent sales (warning)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: null })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
    });

    test('Rule 2: safety cap — never recommends above ceil(velocity * 30)', async () => {
        // velocity=0.5, cap=ceil(0.5*30)=15, min=15 → min >= cap → no rec
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '15',
                days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 2: recommended value never exceeds cap (ceil * 30)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        const cap = Math.ceil(0.5 * 30); // 15
        expect(recs[0].recommendedMin).toBeLessThanOrEqual(cap);
    });

    // --- Rule 2: Restock gate (prevents infinite min ratchet on supply-constrained items) ---

    test('Rule 2 restock gate: no previous auto-increase (first bump ever) → allowed', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5,
                last_auto_increase_at: null, last_received_at: null })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('SOLDOUT_FAST_MOVER');
    });

    test('Rule 2 restock gate: last_received_at after last auto-increase → allowed', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5,
                last_auto_increase_at: daysAgo(10),  // increased 10 days ago
                last_received_at: daysAgo(3) })       // restocked 3 days ago (after increase)
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('SOLDOUT_FAST_MOVER');
    });

    test('Rule 2 restock gate: last_received_at before last auto-increase → skipped', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5,
                last_auto_increase_at: daysAgo(3),   // increased 3 days ago
                last_received_at: daysAgo(10) })      // last restock was 10 days ago (before increase)
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
        expect(recs[0].skipped).toBe('no_restock_since_last_increase');
    });

    test('Rule 2 restock gate: last_received_at IS NULL with prior increase → skipped', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', total_quantity_sold_91d: 5,
                last_auto_increase_at: daysAgo(5),
                last_received_at: null })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
        expect(recs[0].skipped).toBe('no_restock_since_last_increase');
        expect(recs[0].reason).toMatch(/no restock since last auto-increase/i);
    });

    test('Rule 1 (OVERSTOCKED) unaffected by restock gate', async () => {
        // qty=9, min=2, vel=0.5 → OVERSTOCKED; gate fields set to block Rule 2 but Rule 1 must still fire
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '9',
                last_auto_increase_at: daysAgo(3), last_received_at: null })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].rule).toBe('OVERSTOCKED');
        expect(recs[0].recommendedMin).toBe(1);
    });

    // --- Rule 3: Expiring product ---

    test('Rule 3: expiry tier AUTO25 → recommend 0', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ expiry_tier: 'AUTO25', current_min: '2' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(0);
        expect(recs[0].rule).toBe('EXPIRING');
    });

    test('Rule 3: expiry tier AUTO50 → recommend 0', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ expiry_tier: 'AUTO50', current_min: '3' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs[0].recommendedMin).toBe(0);
        expect(recs[0].rule).toBe('EXPIRING');
    });

    test('Rule 3: expiry tier EXPIRED → recommend 0', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ expiry_tier: 'EXPIRED', current_min: '5' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs[0].recommendedMin).toBe(0);
        expect(recs[0].rule).toBe('EXPIRING');
    });

    test('Rule 3: expiry tier, min already 0 → no recommendation', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ expiry_tier: 'AUTO25', current_min: '0' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    // --- Rule 3 overrides Rule 2 ---

    test('Rule 3 overrides Rule 2: sold out + expiry → recommend 0 (not increase)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.3', current_min: '1',
                days_of_stock: '0', total_quantity_sold_91d: 5, expiry_tier: 'AUTO25' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(0);
        expect(recs[0].rule).toBe('EXPIRING');
    });

    test('Rule 3 overrides Rule 1: overstocked + expiry → recommend 0', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '120', current_min: '3',
                velocity_91d: '0.1', quantity: '12', expiry_tier: 'AUTO50' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs[0].recommendedMin).toBe(0);
        expect(recs[0].rule).toBe('EXPIRING');
    });

    test('returns empty array when no rows match any rule', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ velocity_91d: '0.5', quantity: '10', days_of_stock: '20',
                current_min: '0', expiry_tier: null })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('response includes all required fields', async () => {
        // qty=9, min=2, vel=0.5 → proximity check passes (7 <= 7) → OVERSTOCKED fires
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '9' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        const r = recs[0];
        expect(r).toMatchObject({
            variationId: expect.any(String),
            locationId: expect.any(String),
            variationName: expect.any(String),
            itemName: expect.any(String),
            currentMin: expect.any(Number),
            recommendedMin: expect.any(Number),
            rule: expect.any(String),
            reason: expect.any(String),
            velocity91d: expect.any(Number),
            quantity: expect.any(Number),
        });
    });

    // --- Guardrail 3: Null / zero velocity ---

    test('Guardrail 3: null velocity item → not included in recommendations', async () => {
        // Without this guard, dos=999999 would wrongly fire Rule 1 and reduce min
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ velocity_91d: null, current_min: '2', days_of_stock: '999999' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Guardrail 3: zero velocity item → not included in recommendations', async () => {
        // Without this guard, dos=999999 would wrongly fire Rule 1 and reduce min
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ velocity_91d: '0', current_min: '2', days_of_stock: '999999' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    // --- Min/Max conflict guard (Rule 2 increases) ---

    test('Conflict guard: new_min < current_max → increase allowed', async () => {
        // min=0, vel=0.5, recommended=1; current_max=5 → 1 < 5 → allowed
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '0',
                current_max: '5', days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].skipped).toBeUndefined();
        expect(recs[0].warning).toBeUndefined();
    });

    test('Conflict guard: new_min === current_max → skipped with min_would_meet_or_exceed_max', async () => {
        // min=0, vel=0.5, recommended=1; current_max=1 → 1 >= 1 → skip
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '0',
                current_max: '1', days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
        expect(recs[0].skipped).toBe('min_would_meet_or_exceed_max');
        expect(recs[0].conflict_detail).toEqual({ new_min: 1, current_max: 1 });
    });

    test('Conflict guard: new_min > current_max → skipped with min_would_meet_or_exceed_max', async () => {
        // min=3, vel=0.5, recommended=4 (capped at ceil(0.5*30)=15); current_max=2 → 4 > 2 → skip
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '3',
                current_max: '2', days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBe('min_would_meet_or_exceed_max');
        expect(recs[0].conflict_detail).toEqual({ new_min: 4, current_max: 2 });
        expect(recs[0].reason).toMatch(/would meet or exceed/i);
    });

    test('Conflict guard: current_max IS NULL → increase allowed with no_max_set warning', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '0',
                current_max: null, days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].skipped).toBeUndefined();
        expect(recs[0].warning).toBe('no_max_set');
    });

    test('Conflict guard: current_max = 0 → increase allowed with no_max_set warning', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '0',
                current_max: '0', days_of_stock: '0', total_quantity_sold_91d: 5 })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].skipped).toBeUndefined();
        expect(recs[0].warning).toBe('no_max_set');
    });

    test('Conflict guard: does not affect Rule 1 (decreases)', async () => {
        // Rule 1 reduces min; conflict guard only applies to increases.
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', current_max: '1',
                velocity_91d: '0.5', quantity: '9' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].rule).toBe('OVERSTOCKED');
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].skipped).toBeUndefined();
    });

    test('Guardrail 3: zero velocity item with expiry tier still gets Rule 3 (min → 0)', async () => {
        // Rule 3 is checked before the velocity guard — expiry overrides everything
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ velocity_91d: '0', current_min: '2', expiry_tier: 'AUTO25' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].rule).toBe('EXPIRING');
        expect(recs[0].recommendedMin).toBe(0);
    });
});

// ==================== applyWeeklyAdjustments ====================

describe('applyWeeklyAdjustments', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.applyWeeklyAdjustments(null))
            .rejects.toThrow('merchantId is required');
    });

    test('returns zero counts when nothing is applicable', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [] }); // DATA_QUERY
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result).toMatchObject({ reduced: 0, increased: 0 });
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('counts pinned items separately', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                makeRow({ min_stock_pinned: true, days_of_stock: '95', current_min: '2' })
            ]}); // DATA_QUERY
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.pinned).toBe(1);
        expect(result.reduced).toBe(0);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('counts tooNew items separately', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                makeRow({ item_created_at: newItemDate(), days_of_stock: '95', current_min: '2' })
            ]}); // DATA_QUERY
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.tooNew).toBe(1);
        expect(result.reduced).toBe(0);
    });

    test('applies all applicable recs in one transaction and returns correct counts', async () => {
        // var1: qty=9, min=2, vel=0.5 → (9-2)=7 <= 7 → OVERSTOCKED reduction
        // var2: qty=0, vel=0.5, min=0 → SOLDOUT_FAST_MOVER increase
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                makeRow({ variation_id: 'var1', days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '9' }),
                makeRow({ variation_id: 'var2', quantity: '0', velocity_91d: '0.5', current_min: '0', days_of_stock: '0', total_quantity_sold_91d: 5 }),
            ]}) // DATA_QUERY
            .mockResolvedValueOnce({ rows: [{ total: '100' }] }); // circuit breaker: 1/100 = 1% < 20%

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 2 }] }),
            };
            return fn(mockClient);
        });

        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(db.transaction).toHaveBeenCalledTimes(1);
        expect(result.reduced).toBe(1);
        expect(result.increased).toBe(1);
    });

    // --- Guardrail 1: Stale velocity ---

    test('Guardrail 1: stale velocity (8 days old) → aborted with reason', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ last_sync: staleSyncDate() }] });
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.aborted).toBe(true);
        expect(result.reason).toMatch(/stale/i);
        expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('Guardrail 1: no velocity data at all (null last_sync) → aborted', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ last_sync: null }] });
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.aborted).toBe(true);
        expect(result.reason).toMatch(/never/i);
        expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
    });

    test('Guardrail 1: fresh velocity (1 day old) → not aborted', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [] }); // DATA_QUERY — no recs
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.aborted).toBeUndefined();
        expect(result.reduced).toBe(0);
    });

    // --- Guardrail 2: Circuit breaker ---

    test('Guardrail 2: 25% reductions → aborted', async () => {
        // 4 reductions out of 16 total = 25% > 20%
        // qty=9, min=2, vel=0.5 → (9-2)=7 <= 7 → proximity check passes → OVERSTOCKED fires
        const overstockedRow = (id) => makeRow({
            variation_id: id, days_of_stock: '120', current_min: '2', velocity_91d: '0.5', quantity: '9'
        });
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                overstockedRow('v1'), overstockedRow('v2'),
                overstockedRow('v3'), overstockedRow('v4'),
            ]}) // DATA_QUERY — 4 overstocked reductions
            .mockResolvedValueOnce({ rows: [{ total: '16' }] }); // circuit breaker: 4/16 = 25%

        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.aborted).toBe(true);
        expect(result.reason).toMatch(/circuit breaker/i);
        expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('Guardrail 2: 15% reductions → not aborted (proceeds)', async () => {
        // 3 reductions out of 20 total = 15% < 20%
        // qty=9, min=2, vel=0.5 → (9-2)=7 <= 7 → proximity check passes → OVERSTOCKED fires
        const overstockedRow = (id) => makeRow({
            variation_id: id, days_of_stock: '120', current_min: '2', velocity_91d: '0.5', quantity: '9'
        });
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                overstockedRow('v1'), overstockedRow('v2'), overstockedRow('v3'),
            ]}) // DATA_QUERY — 3 overstocked reductions
            .mockResolvedValueOnce({ rows: [{ total: '20' }] }); // circuit breaker: 3/20 = 15%

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 2 }] }) };
            return fn(mockClient);
        });

        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.aborted).toBeUndefined();
        expect(result.reduced).toBe(3);
    });

    // --- adjustments array ---

    test('returns adjustments array with variationId, locationId, newMin, previousMin', async () => {
        // var1: OVERSTOCKED reduction current_min=2 → 1; var2: SOLDOUT_FAST_MOVER current_min=0 → 1
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                makeRow({ variation_id: 'var1', location_id: 'loc1',
                    days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '9' }),
                makeRow({ variation_id: 'var2', location_id: 'loc1',
                    quantity: '0', velocity_91d: '0.5', current_min: '0',
                    days_of_stock: '0', total_quantity_sold_91d: 5 }),
            ]}) // DATA_QUERY
            .mockResolvedValueOnce({ rows: [{ total: '100' }] }); // circuit breaker: 1/100 = 1%

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 2 }] }) };
            return fn(mockClient);
        });

        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.adjustments).toHaveLength(2);
        expect(result.adjustments).toEqual(expect.arrayContaining([
            { variationId: 'var1', locationId: 'loc1', newMin: 1, previousMin: 2 },
            { variationId: 'var2', locationId: 'loc1', newMin: 1, previousMin: 0 },
        ]));
    });

    test('returns empty adjustments array when nothing is applicable', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [] }); // DATA_QUERY — no rows
        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.adjustments).toEqual([]);
    });

    test('conflict skips: returned in result.conflicts and logged to both audit tables', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                makeRow({ variation_id: 'var-conflict', location_id: 'loc1',
                    item_name: 'Cat Food 5kg', variation_name: 'Chicken',
                    quantity: '0', velocity_91d: '0.5', current_min: '3',
                    current_max: '2', days_of_stock: '0', total_quantity_sold_91d: 5 }),
            ]}); // DATA_QUERY — only a conflict rec, no applicable

        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);

        // No adjustments applied — all skipped
        expect(result.reduced).toBe(0);
        expect(result.increased).toBe(0);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]).toMatchObject({
            variationId: 'var-conflict',
            locationId: 'loc1',
            itemName: 'Cat Food 5kg',
            conflictDetail: { new_min: 4, current_max: 2 }
        });

        // Both audit tables received a row — find them by SQL fragment
        const auditLogInserts = db.query.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO min_max_audit_log'));
        const conflictAuditInsert = auditLogInserts.find(c => c[1].includes('min_would_meet_or_exceed_max'));
        expect(conflictAuditInsert).toBeDefined();

        const stockAuditInserts = db.query.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO min_stock_audit')
            && c[0].includes('SKIPPED_CONFLICT'));
        expect(stockAuditInserts).toHaveLength(1);
        expect(stockAuditInserts[0][1]).toContain('var-conflict');
    });

    test('conflict skips: present even when applicable recs also exist', async () => {
        // var-ok: sold-out fast mover → recommend 1 (no conflict: max=null)
        // var-conflict: min=3, max=2 → conflict skip
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] })
            .mockResolvedValueOnce({ rows: [
                makeRow({ variation_id: 'var-ok', location_id: 'loc1',
                    quantity: '0', velocity_91d: '0.5', current_min: '0',
                    current_max: null, days_of_stock: '0', total_quantity_sold_91d: 5 }),
                makeRow({ variation_id: 'var-conflict', location_id: 'loc1',
                    quantity: '0', velocity_91d: '0.5', current_min: '3',
                    current_max: '2', days_of_stock: '0', total_quantity_sold_91d: 5 }),
            ]})
            .mockResolvedValueOnce({ rows: [{ total: '100' }] });

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 0 }] }) };
            return fn(mockClient);
        });

        const result = await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(result.increased).toBe(1);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].variationId).toBe('var-conflict');
    });

    test('does not call pushMinStockThresholdsToSquare (job owns sync)', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] })
            .mockResolvedValueOnce({ rows: [
                makeRow({ variation_id: 'var1', days_of_stock: '95',
                    current_min: '2', velocity_91d: '0.5', quantity: '9' }),
            ]})
            .mockResolvedValueOnce({ rows: [{ total: '100' }] });

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 2 }] }) };
            return fn(mockClient);
        });

        await service.applyWeeklyAdjustments(MERCHANT_ID);
        expect(squareInventory.pushMinStockThresholdsToSquare).not.toHaveBeenCalled();
    });
});

// ==================== applyRecommendation ====================

describe('applyRecommendation', () => {
    beforeEach(() => {
        db.transaction.mockImplementation(async (fn) => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [{ stock_alert_min: 2 }] }) // get current
                    .mockResolvedValueOnce({ rows: [] })                        // upsert
                    .mockResolvedValueOnce({ rows: [] }),                       // audit log
            };
            return fn(mockClient);
        });
    });

    test('throws if merchantId is missing', async () => {
        await expect(service.applyRecommendation(null, 'var1', 'loc1', 1))
            .rejects.toThrow();
    });

    test('throws if newMin is negative', async () => {
        await expect(service.applyRecommendation(MERCHANT_ID, 'var1', 'loc1', -1))
            .rejects.toThrow('newMin must be a non-negative integer');
    });

    test('throws if newMin is not an integer', async () => {
        await expect(service.applyRecommendation(MERCHANT_ID, 'var1', 'loc1', 1.5))
            .rejects.toThrow('newMin must be a non-negative integer');
    });

    test('updates DB and logs audit entry', async () => {
        const result = await service.applyRecommendation(MERCHANT_ID, 'var1', 'loc1', 1);

        expect(db.transaction).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            variationId: 'var1',
            locationId: 'loc1',
            previousMin: 2,
            newMin: 1,
        });
    });

    test('sets previousMin to 0 when row does not exist', async () => {
        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [] })     // no existing row
                    .mockResolvedValueOnce({ rows: [] })     // upsert
                    .mockResolvedValueOnce({ rows: [] }),    // audit
            };
            return fn(mockClient);
        });
        const result = await service.applyRecommendation(MERCHANT_ID, 'var2', 'loc1', 0);
        expect(result.previousMin).toBe(0);
    });
});

// ==================== applyAllRecommendations ====================

describe('applyAllRecommendations', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.applyAllRecommendations(null, []))
            .rejects.toThrow('merchantId is required');
    });

    test('returns zero counts for empty recommendations array', async () => {
        const result = await service.applyAllRecommendations(MERCHANT_ID, []);
        expect(result).toEqual({ applied: 0, failed: 0, errors: [] });
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('uses a single transaction for all recommendations', async () => {
        const recs = [
            { variationId: 'var1', locationId: 'loc1', newMin: 1,
              rule: 'OVERSTOCKED', reason: 'test' },
            { variationId: 'var2', locationId: 'loc1', newMin: 0,
              rule: 'EXPIRING', reason: 'test' },
        ];

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 2 }] }),
            };
            return fn(mockClient);
        });

        const result = await service.applyAllRecommendations(MERCHANT_ID, recs);

        expect(db.transaction).toHaveBeenCalledTimes(1); // one transaction for all
        expect(result.applied).toBe(2);
        expect(result.failed).toBe(0);
    });

    test('transaction client.query called 4 times per recommendation (read, upsert, min_stock_audit, min_max_audit_log)', async () => {
        const recs = [
            { variationId: 'var1', locationId: 'loc1', newMin: 1,
              rule: 'OVERSTOCKED', reason: 'test' },
        ];

        let clientQueryCount = 0;
        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = {
                query: jest.fn().mockImplementation(() => {
                    clientQueryCount++;
                    return Promise.resolve({ rows: [{ stock_alert_min: 3 }] });
                }),
            };
            return fn(mockClient);
        });

        await service.applyAllRecommendations(MERCHANT_ID, recs);
        expect(clientQueryCount).toBe(4); // read + upsert + min_stock_audit + min_max_audit_log
    });
});

// ==================== pinVariation ====================

describe('pinVariation', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.pinVariation(null, 'var1', 'loc1', true))
            .rejects.toThrow('merchantId, variationId, and locationId are required');
    });

    test('throws if pinned is not a boolean', async () => {
        await expect(service.pinVariation(MERCHANT_ID, 'var1', 'loc1', 'true'))
            .rejects.toThrow('pinned must be a boolean');
    });

    test('upserts min_stock_pinned = true', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const result = await service.pinVariation(MERCHANT_ID, 'var1', 'loc1', true);
        expect(db.query).toHaveBeenCalledTimes(1);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('min_stock_pinned');
        expect(db.query.mock.calls[0][1]).toContain(true);
        expect(result).toMatchObject({ variationId: 'var1', locationId: 'loc1', pinned: true });
    });

    test('upserts min_stock_pinned = false (unpin)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const result = await service.pinVariation(MERCHANT_ID, 'var1', 'loc1', false);
        expect(result.pinned).toBe(false);
    });
});

// ==================== toggleMinStockPin ====================

describe('toggleMinStockPin', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.toggleMinStockPin('var1', 'loc1', null, true))
            .rejects.toThrow('variationId, locationId, and merchantId are required');
    });

    test('throws if pinned is not a boolean', async () => {
        await expect(service.toggleMinStockPin('var1', 'loc1', MERCHANT_ID, 'yes'))
            .rejects.toThrow('pinned must be a boolean');
    });

    test('wrong merchant_id — variation not found → throws cross-tenant error', async () => {
        // Ownership check returns no rows → variation belongs to different merchant
        db.query.mockResolvedValueOnce({ rows: [] }); // variations ownership check
        await expect(service.toggleMinStockPin('var-other', 'loc1', MERCHANT_ID, true))
            .rejects.toThrow('Variation not found for this merchant');
    });

    test('correct merchant_id — updates pin flag and logs audit entry', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'var1' }] })           // ownership check
            .mockResolvedValueOnce({ rows: [{ stock_alert_min: 3 }] })   // read current min
            .mockResolvedValueOnce({ rows: [] })                          // upsert pin
            .mockResolvedValueOnce({ rows: [] });                         // audit log insert

        const result = await service.toggleMinStockPin('var1', 'loc1', MERCHANT_ID, true);

        expect(db.query).toHaveBeenCalledTimes(4);
        // ownership check includes merchant_id
        expect(db.query.mock.calls[0][1]).toEqual(['var1', MERCHANT_ID]);
        // upsert sets min_stock_pinned
        const upsertSql = db.query.mock.calls[2][0];
        expect(upsertSql).toContain('min_stock_pinned');
        expect(db.query.mock.calls[2][1]).toContain(true);
        // audit log written to min_max_audit_log
        const auditSql = db.query.mock.calls[3][0];
        expect(auditSql).toContain('min_max_audit_log');
        expect(result).toMatchObject({ variationId: 'var1', locationId: 'loc1', pinned: true });
    });

    test('unpin — sets pinned=false and logs unpin reason in audit', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'var1' }] })
            .mockResolvedValueOnce({ rows: [{ stock_alert_min: 2 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await service.toggleMinStockPin('var1', 'loc1', MERCHANT_ID, false);

        expect(db.query.mock.calls[2][1]).toContain(false);
        const auditParams = db.query.mock.calls[3][1];
        expect(auditParams.some(p => typeof p === 'string' && p.includes('Pin removed'))).toBe(true);
        expect(result.pinned).toBe(false);
    });
});

// ==================== getSuppressedItems ====================

describe('getSuppressedItems', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.getSuppressedItems(null))
            .rejects.toThrow('merchantId is required');
    });

    test('returns rows from last run with skipped=TRUE', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { variation_id: 'var1', location_id: 'loc1', old_min: 2,
              skip_reason: 'Manually pinned', created_at: new Date().toISOString(),
              variation_name: 'V1', item_name: 'Item1', sku: 'SKU1', min_stock_pinned: true }
        ]});
        const items = await service.getSuppressedItems(MERCHANT_ID);
        expect(items).toHaveLength(1);
        expect(items[0].skip_reason).toBe('Manually pinned');
        // Query must filter by merchant_id
        expect(db.query.mock.calls[0][1]).toContain(MERCHANT_ID);
    });
});

// ==================== getAuditLog ====================

describe('getAuditLog', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.getAuditLog(null))
            .rejects.toThrow('merchantId is required');
    });

    test('returns rows with skipped=FALSE', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { variation_id: 'var1', location_id: 'loc1', old_min: 2, new_min: 1,
              reason: 'Overstocked', created_at: new Date().toISOString(),
              variation_name: 'V1', item_name: 'Item1', sku: 'SKU1' }
        ]});
        const items = await service.getAuditLog(MERCHANT_ID);
        expect(items).toHaveLength(1);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('skipped = FALSE');
        expect(db.query.mock.calls[0][1]).toContain(MERCHANT_ID);
    });

    test('clamps limit to 200 max', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await service.getAuditLog(MERCHANT_ID, 9999);
        const limitParam = db.query.mock.calls[0][1][1]; // second param is limit
        expect(limitParam).toBe(200);
    });

    test('default limit is 50', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await service.getAuditLog(MERCHANT_ID);
        const limitParam = db.query.mock.calls[0][1][1];
        expect(limitParam).toBe(50);
    });
});

// ==================== getHistory ====================

describe('getHistory', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.getHistory(null))
            .rejects.toThrow('merchantId is required');
    });

    test('returns paginated results without filters', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, rule: 'OVERSTOCKED' }] })
            .mockResolvedValueOnce({ rows: [{ total: '5' }] });

        const result = await service.getHistory(MERCHANT_ID);
        expect(result.items).toHaveLength(1);
        expect(result.total).toBe(5);
        expect(result.limit).toBe(50);
        expect(result.offset).toBe(0);
    });

    test('applies startDate filter to query params', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: '0' }] });

        await service.getHistory(MERCHANT_ID, { startDate: '2026-01-01' });
        const params = db.query.mock.calls[0][1];
        expect(params).toContain('2026-01-01');
    });

    test('applies rule filter to query params', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: '0' }] });

        await service.getHistory(MERCHANT_ID, { rule: 'OVERSTOCKED' });
        const params = db.query.mock.calls[0][1];
        expect(params).toContain('OVERSTOCKED');
    });

    test('respects custom limit and offset', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: '0' }] });

        const result = await service.getHistory(MERCHANT_ID, { limit: 10, offset: 20 });
        expect(result.limit).toBe(10);
        expect(result.offset).toBe(20);
    });
});

// ==================== Square push (pushMinStockThresholdsToSquare) ====================
// applyWeeklyAdjustments does NOT call pushMinStockThresholdsToSquare — the job owns sync.
// applyRecommendation and applyAllRecommendations still call it directly (fire-and-forget).

describe('Square push after apply', () => {
    beforeEach(() => {
        squareInventory.pushMinStockThresholdsToSquare.mockClear();
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValue({ pushed: 1, failed: 0 });
    });

    test('applyRecommendation: pushMinStockThresholdsToSquare called with correct args', async () => {
        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [{ stock_alert_min: 3 }] })
                    .mockResolvedValue({ rows: [] }),
            };
            return fn(mockClient);
        });

        await service.applyRecommendation(MERCHANT_ID, 'var1', 'loc1', 2);

        expect(squareInventory.pushMinStockThresholdsToSquare).toHaveBeenCalledWith(
            MERCHANT_ID,
            [{ variationId: 'var1', locationId: 'loc1', newMin: 2 }]
        );
    });

    test('applyAllRecommendations: pushMinStockThresholdsToSquare called with all changes', async () => {
        const recs = [
            { variationId: 'var1', locationId: 'loc1', newMin: 1, rule: 'OVERSTOCKED', reason: 'r' },
            { variationId: 'var2', locationId: 'loc1', newMin: 0, rule: 'EXPIRING', reason: 'r' },
        ];

        db.transaction.mockImplementationOnce(async (fn) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ stock_alert_min: 2 }] }) };
            return fn(mockClient);
        });

        await service.applyAllRecommendations(MERCHANT_ID, recs);

        expect(squareInventory.pushMinStockThresholdsToSquare).toHaveBeenCalledWith(
            MERCHANT_ID,
            [
                { variationId: 'var1', locationId: 'loc1', newMin: 1 },
                { variationId: 'var2', locationId: 'loc1', newMin: 0 },
            ]
        );
    });

    test('applyAllRecommendations: Square push not called for empty array', async () => {
        await service.applyAllRecommendations(MERCHANT_ID, []);
        expect(squareInventory.pushMinStockThresholdsToSquare).not.toHaveBeenCalled();
    });
});
