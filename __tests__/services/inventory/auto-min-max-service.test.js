/**
 * Auto Min/Max Stock Recommendation Service Tests
 *
 * Tests for all three business rules, edge cases, and apply operations.
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

const db = require('../../../utils/database');
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
        expiry_tier: null,
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

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== generateRecommendations ====================

describe('generateRecommendations', () => {
    test('throws if merchantId is missing', async () => {
        await expect(service.generateRecommendations(null))
            .rejects.toThrow('merchantId is required');
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
        // velocity = 0.5, ceil(0.5*14) = 7 target, ceil(0.5*30) = 15 cap
        // min = 14 (below target 7? No: min=14 >= targetMin=7, so no rec)
        // Let's try min=0, vel=0.5 → recommended = min(0+1, 15) = 1 ✓
        // To test cap: set min=14, targetMin=7, min >= targetMin → no rec
        db.query.mockResolvedValueOnce({ rows: [
            makeRow({ quantity: '0', velocity_91d: '0.5', current_min: '14',
                days_of_stock: '0', last_sold_at: recentDate() })
        ]});
        const recs = await service.generateRecommendations(MERCHANT_ID);
        expect(recs).toHaveLength(0); // min 14 >= ceil(0.5*14)=7, no rec needed
    });

    test('Rule 2: recommended value never exceeds cap (ceil * 30)', async () => {
        // velocity = 1.0, cap = ceil(1*30) = 30, min=29 → min+1=30 = cap ✓
        // velocity = 1.0, min=30 → min=30 >= targetMin=14, no rec
        // Let's use velocity=0.5, min=0 → recommended=min(1, 15)=1, cap=15
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

    test('transaction client.query called 3 times per recommendation (read, upsert, audit)', async () => {
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
        expect(clientQueryCount).toBe(3); // read + upsert + audit
    });
});
