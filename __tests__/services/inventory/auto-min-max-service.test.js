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

const db = require('../../../utils/database');
const emailNotifier = require('../../../utils/email-notifier');
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
        min_stock_pinned: false,
        expiry_tier: null,
        item_created_at: oldItemDate(),  // old enough by default
        last_sold_at: null,
        ...overrides,
    };
}

// Helper: date within last 30 days
function recentDate() {
    return new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: date older than 30 days
function oldDate() {
    return new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
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
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ item_created_at: oldItemDate(), days_of_stock: '95',
                current_min: '2', velocity_91d: '0.5', quantity: '48' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBeUndefined();
        expect(recs[0].rule).toBe('OVERSTOCKED');
    });

    test('min_stock_pinned = FALSE → proceeds to rule evaluation (not skipped)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ min_stock_pinned: false, days_of_stock: '95',
                current_min: '2', velocity_91d: '0.5', quantity: '48' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].skipped).toBeUndefined();
    });

    // --- Rule 1: Overstocked slow mover ---

    test('Rule 1: days_of_stock 95, min 2 → recommend min - 1 (1)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '48' })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('OVERSTOCKED');
    });

    test('Rule 1: days_of_stock 80, min 2 → no recommendation (under 90)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '80', current_min: '2', velocity_91d: '0.5', quantity: '40' })
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

    // --- Rule 2: Sold out fast mover ---

    test('Rule 2: quantity 0, velocity 0.2, min 0, recently sold → recommend 1', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', last_sold_at: recentDate() })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBe(1);
        expect(recs[0].rule).toBe('SOLDOUT_FAST_MOVER');
    });

    test('Rule 2: quantity 0, velocity 0.2, no sales in 30 days → included as warning (null min)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', last_sold_at: oldDate() })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
        expect(recs[0].reason).toMatch(/possible supplier issue/);
    });

    test('Rule 2: quantity 0, velocity 0.1 → no recommendation (under 0.15)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.1', current_min: '0',
                days_of_stock: '0', last_sold_at: recentDate() })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 2: quantity 0, no last_sold_at → treated as no recent sales (warning)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.2', current_min: '0',
                days_of_stock: '0', last_sold_at: null })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(1);
        expect(recs[0].recommendedMin).toBeNull();
    });

    test('Rule 2: safety cap — never recommends above ceil(velocity * 30)', async () => {
        // velocity=0.5, cap=ceil(0.5*30)=15, min=15 → min >= cap → no rec
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '15',
                days_of_stock: '0', last_sold_at: recentDate() })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0);
    });

    test('Rule 2: recommended value never exceeds cap (ceil * 30)', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '0',
                days_of_stock: '0', last_sold_at: recentDate() })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        const cap = Math.ceil(0.5 * 30); // 15
        expect(recs[0].recommendedMin).toBeLessThanOrEqual(cap);
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
                days_of_stock: '0', last_sold_at: recentDate(), expiry_tier: 'AUTO25' })
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
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '48' })
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
        db.query
            .mockResolvedValueOnce({ rows: [{ last_sync: freshSyncDate() }] }) // stale check
            .mockResolvedValueOnce({ rows: [
                makeRow({ variation_id: 'var1', days_of_stock: '95', current_min: '2', velocity_91d: '0.5', quantity: '48' }),
                makeRow({ variation_id: 'var2', quantity: '0', velocity_91d: '0.5', current_min: '0', days_of_stock: '0', last_sold_at: recentDate() }),
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
        const overstockedRow = (id) => makeRow({
            variation_id: id, days_of_stock: '120', current_min: '2', velocity_91d: '0.5', quantity: '60'
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
        const overstockedRow = (id) => makeRow({
            variation_id: id, days_of_stock: '120', current_min: '2', velocity_91d: '0.5', quantity: '60'
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
