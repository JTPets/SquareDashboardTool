/**
 * Tests for middleware/validators/catalog.js — validateMinMaxConsistency.
 *
 * Covers the cross-field check that prevents writing stock_alert_min >=
 * stock_alert_max (Layer 1 of the min/max safety defense-in-depth).
 */

const { validateMinMaxConsistency } = require('../../../middleware/validators/catalog');

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
