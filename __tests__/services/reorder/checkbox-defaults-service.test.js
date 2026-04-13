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
        pending_po_quantity: 0,
        final_suggested_qty: 80,  // totalStock = 90, daysToClear = 45 < 90 → safe
        ...overrides
    };
}

describe('calculateCheckboxDefaults', () => {

    // ==================== Rule 0: zero_qty (first check) ====================

    test('final_suggested_qty 0 → unchecked, reason zero_qty', () => {
        const items = [makeItem({ final_suggested_qty: 0 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('zero_qty');
    });

    test('final_suggested_qty 0 beats active discount: both zero_qty and discount → zero_qty wins', () => {
        const items = [makeItem({ final_suggested_qty: 0, active_discount_tier: 3 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('zero_qty');
    });

    test('final_suggested_qty 0 beats cheaper vendor: both zero_qty and not primary vendor → zero_qty wins', () => {
        const items = [makeItem({ final_suggested_qty: 0, is_primary_vendor: false, current_stock: 5 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('zero_qty');
    });

    test('final_suggested_qty undefined treated as 0 → unchecked, reason zero_qty', () => {
        const items = [makeItem({ final_suggested_qty: undefined })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('zero_qty');
    });

    test('final_suggested_qty 1 → proceeds to other rules, not zero_qty', () => {
        const items = [makeItem({ final_suggested_qty: 1 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_reason).not.toBe('zero_qty');
        expect(result[0].default_checked).toBe(true);
    });

    // ==================== Rule 1: active_discount_tier ====================
    // Invariant: active_discount_tier is non-null ONLY when edt.is_auto_apply = TRUE.
    // The SQL CASE expression filters out OK/tracking-only rows — they arrive as null.

    test('active_discount_tier set → unchecked, reason expiry_discount_active', () => {
        // Simulates a real auto-apply tier ID returned from DB (is_auto_apply = TRUE)
        const items = [makeItem({ active_discount_tier: 3 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_discount_active');
    });

    test('active_discount_tier set to any non-null value → unchecked', () => {
        // Another auto-apply tier ID
        const items = [makeItem({ active_discount_tier: 5 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_discount_active');
    });

    test('active_discount_tier null (OK/non-discount tier) → checked, not flagged as discount', () => {
        // Regression test for the bug: DB rows with a non-auto-apply tier (e.g. OK tier id=4)
        // arrive as null from the SQL CASE expression — must NOT trigger rule 1.
        const items = [makeItem({ active_discount_tier: null })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('default');
    });

    // ==================== Rule 2: is_primary_vendor ====================

    test('is_primary_vendor false → unchecked, reason cheaper_vendor_available', () => {
        // current_stock: 10 so zero_stock_no_order override does NOT apply
        const items = [makeItem({ is_primary_vendor: false, current_stock: 10 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('cheaper_vendor_available');
    });

    // ==================== Rule 3: zero_stock_no_order (override cheaper-elsewhere) ====================

    test('not primary vendor + zero stock + nothing on order → checked, reason zero_stock_no_order', () => {
        const items = [makeItem({ is_primary_vendor: false, current_stock: 0, pending_po_quantity: 0 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(true);
        expect(result[0].default_reason).toBe('zero_stock_no_order');
    });

    test('not primary vendor + zero stock + has PO on order → unchecked, cheaper_vendor_available (not overridden)', () => {
        const items = [makeItem({ is_primary_vendor: false, current_stock: 0, pending_po_quantity: 5 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('cheaper_vendor_available');
    });

    test('not primary vendor + has stock + no PO → unchecked, cheaper_vendor_available (stock present, no override)', () => {
        const items = [makeItem({ is_primary_vendor: false, current_stock: 3, pending_po_quantity: 0 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('cheaper_vendor_available');
    });

    test('zero_stock_no_order does not fire when active discount present', () => {
        // Discount check (rule 2) fires before zero_stock_no_order (rule 3)
        const items = [makeItem({ is_primary_vendor: false, current_stock: 0, pending_po_quantity: 0, active_discount_tier: 2 })];
        const result = calculateCheckboxDefaults(items);
        expect(result[0].default_checked).toBe(false);
        expect(result[0].default_reason).toBe('expiry_discount_active');
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
