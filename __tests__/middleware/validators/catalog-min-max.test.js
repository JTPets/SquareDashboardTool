/**
 * Tests for middleware/validators/catalog.js — validateMinMaxConsistency.
 *
 * Covers the cross-field check that prevents writing stock_alert_min >=
 * stock_alert_max (Layer 1 of the min/max safety defense-in-depth).
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

const db = require('../../../utils/database');
const {
    validateMinMaxConsistency,
    validateMinStockAgainstStoredMax,
    assertMinLessThanMax
} = require('../../../middleware/validators/catalog');

describe('validateMinMaxConsistency', () => {
    const call = (body) => validateMinMaxConsistency({ body });

    test('passes when only stock_alert_min is provided', () => {
        expect(call({ stock_alert_min: 5 })).toBe(true);
    });

    test('passes when only stock_alert_max is provided', () => {
        expect(call({ stock_alert_max: 20 })).toBe(true);
    });

    test('passes when neither is provided', () => {
        expect(call({ shelf_location: 'A1' })).toBe(true);
    });

    test('accepts min < max', () => {
        expect(call({ stock_alert_min: 5, stock_alert_max: 20 })).toBe(true);
    });

    test('rejects min == max', () => {
        expect(() => call({ stock_alert_min: 10, stock_alert_max: 10 }))
            .toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('rejects min > max', () => {
        expect(() => call({ stock_alert_min: 20, stock_alert_max: 5 }))
            .toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('normalizes max=0 to NULL — accepts any min', () => {
        expect(call({ stock_alert_min: 50, stock_alert_max: 0 })).toBe(true);
    });

    test('accepts max=null (unlimited) with any min', () => {
        expect(call({ stock_alert_min: 50, stock_alert_max: null })).toBe(true);
    });

    test('accepts min=null with any max', () => {
        expect(call({ stock_alert_min: null, stock_alert_max: 10 })).toBe(true);
    });

    test('handles string inputs (from JSON)', () => {
        expect(call({ stock_alert_min: '5', stock_alert_max: '20' })).toBe(true);
        expect(() => call({ stock_alert_min: '20', stock_alert_max: '5' }))
            .toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('handles missing req.body gracefully', () => {
        expect(validateMinMaxConsistency({})).toBe(true);
    });
});

describe('assertMinLessThanMax', () => {
    test('passes when max is null (unlimited)', () => {
        expect(assertMinLessThanMax(50, null)).toBe(true);
    });

    test('normalizes max=0 to null (unlimited)', () => {
        expect(assertMinLessThanMax(50, 0)).toBe(true);
    });

    test('passes when min is null', () => {
        expect(assertMinLessThanMax(null, 10)).toBe(true);
    });

    test('passes when min < max', () => {
        expect(assertMinLessThanMax(5, 20)).toBe(true);
    });

    test('throws when min == max', () => {
        expect(() => assertMinLessThanMax(10, 10))
            .toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('throws when min > max', () => {
        expect(() => assertMinLessThanMax(20, 5))
            .toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('accepts string inputs', () => {
        expect(assertMinLessThanMax('5', '20')).toBe(true);
        expect(() => assertMinLessThanMax('20', '5'))
            .toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });
});

describe('validateMinStockAgainstStoredMax', () => {
    const buildReq = (overrides = {}) => ({
        body: { min_stock: 10, ...(overrides.body || {}) },
        params: { id: 'VAR1', ...(overrides.params || {}) },
        merchantContext: { id: 1, ...(overrides.merchantContext || {}) }
    });

    beforeEach(() => {
        db.query.mockReset();
    });

    test('rejects when new min >= stored max', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 10 }] });
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 10 } })))
            .rejects.toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('rejects when new min > stored max', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 5 }] });
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 50 } })))
            .rejects.toThrow(/stock_alert_max must be greater than stock_alert_min/);
    });

    test('accepts when new min < stored max', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 100 }] });
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 10 } })))
            .resolves.toBe(true);
    });

    test('accepts when stored max is NULL (unlimited)', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: null }] });
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 999 } })))
            .resolves.toBe(true);
    });

    test('accepts when stored max is 0 (normalized to unlimited)', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 0 }] });
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 999 } })))
            .resolves.toBe(true);
    });

    test('skips DB lookup when min_stock is null (clearing)', async () => {
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: null } })))
            .resolves.toBe(true);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('skips DB lookup when min_stock is 0 (no conflict possible)', async () => {
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 0 } })))
            .resolves.toBe(true);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('skips DB lookup when min_stock is undefined', async () => {
        await expect(validateMinStockAgainstStoredMax({ body: {}, params: { id: 'V1' }, merchantContext: { id: 1 } }))
            .resolves.toBe(true);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('passes when variation row is not found (service returns 404)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(validateMinStockAgainstStoredMax(buildReq({ body: { min_stock: 10 } })))
            .resolves.toBe(true);
    });

    test('filters by merchant_id and variation id', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 100 }] });
        await validateMinStockAgainstStoredMax(buildReq({
            body: { min_stock: 5 },
            params: { id: 'VAR_ABC' },
            merchantContext: { id: 42 }
        }));
        expect(db.query).toHaveBeenCalledWith(
            expect.stringMatching(/FROM variations WHERE id = \$1 AND merchant_id = \$2/),
            ['VAR_ABC', 42]
        );
    });
});
