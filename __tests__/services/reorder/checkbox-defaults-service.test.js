/**
 * Checkbox Defaults Service — Unit Tests
 *
 * Tests for services/reorder/checkbox-defaults-service.js
 * Pure computation: no DB, no mocks needed.
 */

'use strict';

const { calculateCheckboxDefaults } = require('../../../services/reorder/checkbox-defaults-service');

// Minimal item that satisfies the happy path (primary vendor, no expiry risk, no discount)
function makeItem(overrides = {}) {
    return {
        variation_id: 'var_1',
        item_name: 'Dog Food',
        active_discount_tier: null,
        is_primary_vendor: true,
        does_not_expire: false,
        days_until_expiry: 90,
        daily_avg_quantity: 2,
        current_stock: 10,
        final_suggested_qty: 80,  // totalStock = 90, daysToClear = 45 < 90 → safe
        ...overrides
    };
}

describe('calculateCheckboxDefaults', () => {

    // ==================== Rule 1: active_discount_tier ====================

    test('active_discount_tier set → unchecked, reason expiry_discount_active', () => {
        const items = [makeItem({ active_discount_tier: 'AUTO50' })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_discount_active');
    });

    test('active_discount_tier set to any non-null value → unchecked', () => {
        const items = [makeItem({ active_discount_tier: 'REVIEW' })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_discount_active');
    });

    // ==================== Rule 2: is_primary_vendor ====================

    test('is_primary_vendor false → unchecked, reason cheaper_vendor_available', () => {
        const items = [makeItem({ is_primary_vendor: false })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('cheaper_vendor_available');
    });

    // ==================== Rule 3: expiry_risk ====================

    test('expiry risk: totalStock/daily_avg > days_until_expiry → unchecked, reason expiry_risk', () => {
        // totalStock = 10 + 200 = 210, daysToClear = 105 > days_until_expiry (90)
        const items = [makeItem({ current_stock: 10, final_suggested_qty: 200, days_until_expiry: 90, daily_avg_quantity: 2 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_risk');
    });

    test('expiry safe: totalStock/daily_avg < days_until_expiry → checked', () => {
        // totalStock = 10 + 80 = 90, daysToClear = 45 < 90
        const items = [makeItem({ current_stock: 10, final_suggested_qty: 80, days_until_expiry: 90, daily_avg_quantity: 2 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    test('daily_avg_quantity === 0 → checked (no expiry calc)', () => {
        // Would divide by zero; should skip expiry risk and default to checked
        const items = [makeItem({ daily_avg_quantity: 0, days_until_expiry: 5 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    test('does_not_expire true → checked regardless of expiry fields', () => {
        const items = [makeItem({ does_not_expire: true, days_until_expiry: 1, daily_avg_quantity: 10, current_stock: 1000, final_suggested_qty: 1000 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    test('days_until_expiry null → checked', () => {
        const items = [makeItem({ days_until_expiry: null })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    // ==================== Rule 4: default ====================

    test('default: primary vendor, no discount, no expiry risk → checked', () => {
        const items = [makeItem()];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    // ==================== Priority ordering ====================

    test('discount beats vendor: both discount and not primary vendor → expiry_discount_active wins', () => {
        const items = [makeItem({ active_discount_tier: 'AUTO25', is_primary_vendor: false })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_reason).toBe('expiry_discount_active');
    });

    test('vendor beats expiry: not primary vendor and expiry risk → cheaper_vendor_available wins', () => {
        // totalStock = 10 + 500 = 510, daysToClear = 255 > days_until_expiry (90)
        const items = [makeItem({ is_primary_vendor: false, current_stock: 10, final_suggested_qty: 500, days_until_expiry: 90, daily_avg_quantity: 2 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_reason).toBe('cheaper_vendor_available');
    });

    // ==================== merchantConfig.expiryRiskBufferDays ====================

    test('expiryRiskBufferDays applied: clears within (days_until_expiry - buffer) → unchecked', () => {
        // totalStock = 10 + 80 = 90, daysToClear = 45, days_until_expiry = 90, buffer = 60
        // effective threshold = 90 - 60 = 30; 45 > 30 → expiry risk
        const items = [makeItem({ current_stock: 10, final_suggested_qty: 80, days_until_expiry: 90, daily_avg_quantity: 2 })];
        const result = calculateCheckboxDefaults(items, { expiryRiskBufferDays: 60 });
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_risk');
    });

    test('expiryRiskBufferDays applied: clears within (days_until_expiry - buffer) → checked when safe', () => {
        // totalStock = 10 + 20 = 30, daysToClear = 15, days_until_expiry = 90, buffer = 60
        // effective threshold = 30; 15 < 30 → safe
        const items = [makeItem({ current_stock: 10, final_suggested_qty: 20, days_until_expiry: 90, daily_avg_quantity: 2 })];
        const result = calculateCheckboxDefaults(items, { expiryRiskBufferDays: 60 });
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    // ==================== Array handling ====================

    test('empty array returns empty array', () => {
        expect(calculateCheckboxDefaults([])).toEqual([]);
    });

    test('spreads all original item fields onto result', () => {
        const items = [makeItem({ sku: 'TEST-SKU', unit_cost_cents: 1234 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].sku).toBe('TEST-SKU');
        expect(result[0].unit_cost_cents).toBe(1234);
        expect(result[0].default_checked).toBeDefined();
        expect(result[0].default_reason).toBeDefined();
    });

    test('processes multiple items independently', () => {
        const items = [
            makeItem({ variation_id: 'v1', active_discount_tier: 'AUTO50' }),
            makeItem({ variation_id: 'v2' }),
            makeItem({ variation_id: 'v3', is_primary_vendor: false })
        ];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_discount_active');
        expect(result[1].default_checked).toBe(true);
        expect(result[1].default_reason).toBe('default');
        expect(result[2].default_checked).toBe(false);
        expect(result[2].default_reason).toBe('cheaper_vendor_available');
    });
});
