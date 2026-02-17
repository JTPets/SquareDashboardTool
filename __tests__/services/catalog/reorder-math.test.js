/**
 * Reorder Math — Unit Tests
 *
 * Tests for the shared reorder quantity and days-of-stock calculations.
 * This module is the single source of truth for reorder formulas (BACKLOG-14).
 */

const { calculateReorderQuantity, calculateDaysOfStock } = require('../../../services/catalog/reorder-math');

describe('reorder-math', () => {

    // ==================== calculateReorderQuantity ====================

    describe('calculateReorderQuantity', () => {

        // --- Normal case (supplyDays only, other params defaulting to 0) ---

        test('normal case: supplyDays only, others default', () => {
            // velocity=2/day, supplyDays=45 → target=90, stock=20 → need 70
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                currentStock: 20
            });
            expect(result).toBe(70);
        });

        test('normal case: rounds up fractional velocity × threshold', () => {
            // velocity=1.5/day, supplyDays=30 → target=ceil(45)=45, stock=10 → need 35
            const result = calculateReorderQuantity({
                velocity: 1.5,
                supplyDays: 30,
                currentStock: 10
            });
            expect(result).toBe(35);
        });

        // --- With leadTimeDays and safetyDays (proving the math works when wired) ---

        test('with leadTimeDays and safetyDays: full threshold used', () => {
            // velocity=2, supply=30, lead=5, safety=7 → threshold=42
            // target=ceil(2*42)=84, stock=10 → need 74
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 30,
                leadTimeDays: 5,
                safetyDays: 7,
                currentStock: 10
            });
            expect(result).toBe(74);
        });

        test('leadTimeDays defaults to 0, safetyDays defaults to 0', () => {
            // Same as without lead/safety
            const withDefaults = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                currentStock: 20
            });
            const withExplicitZeros = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                leadTimeDays: 0,
                safetyDays: 0,
                currentStock: 20
            });
            expect(withDefaults).toBe(withExplicitZeros);
        });

        // --- Zero velocity ---

        test('zero velocity with casePack > 1: suggests casePack', () => {
            const result = calculateReorderQuantity({
                velocity: 0,
                supplyDays: 45,
                casePack: 6,
                currentStock: 0
            });
            expect(result).toBe(6);
        });

        test('zero velocity with reorderMultiple > 1: suggests reorderMultiple', () => {
            const result = calculateReorderQuantity({
                velocity: 0,
                supplyDays: 45,
                reorderMultiple: 12,
                currentStock: 0
            });
            expect(result).toBe(12);
        });

        test('zero velocity with no casePack or multiple: suggests 1', () => {
            const result = calculateReorderQuantity({
                velocity: 0,
                supplyDays: 45,
                currentStock: 0
            });
            expect(result).toBe(1);
        });

        test('zero velocity, casePack takes priority over reorderMultiple', () => {
            const result = calculateReorderQuantity({
                velocity: 0,
                supplyDays: 45,
                casePack: 6,
                reorderMultiple: 12,
                currentStock: 0
            });
            // casePack=6 checked first, so targetQty=6
            // Then reorderMultiple=12 rounds up: ceil(6/12)*12=12
            expect(result).toBe(12);
        });

        test('zero velocity with existing stock: no order needed if stock exceeds minimum', () => {
            const result = calculateReorderQuantity({
                velocity: 0,
                supplyDays: 45,
                currentStock: 10
            });
            // target=1, stock=10, suggested=max(0, 1-10)=0
            expect(result).toBe(0);
        });

        // --- Reorder multiple rounding ---

        test('reorder multiple rounds up to nearest multiple', () => {
            // velocity=1, supply=45 → target=45, stock=10 → need 35
            // reorderMultiple=12 → ceil(35/12)*12 = 36
            const result = calculateReorderQuantity({
                velocity: 1,
                supplyDays: 45,
                reorderMultiple: 12,
                currentStock: 10
            });
            expect(result).toBe(36);
        });

        test('reorder multiple of 1 has no effect', () => {
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                reorderMultiple: 1,
                currentStock: 20
            });
            expect(result).toBe(70);
        });

        // --- stock_alert_min floor enforcement ---

        test('stock_alert_min enforces minimum target', () => {
            // velocity=0.1, supply=30 → target=ceil(3)=3
            // stockAlertMin=10 → target = max(11, 3) = 11
            // stock=5 → need 6
            const result = calculateReorderQuantity({
                velocity: 0.1,
                supplyDays: 30,
                stockAlertMin: 10,
                currentStock: 5
            });
            expect(result).toBe(6);
        });

        test('stock_alert_min=0 has no effect', () => {
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                stockAlertMin: 0,
                currentStock: 20
            });
            expect(result).toBe(70);
        });

        // --- casePack rounding ---

        test('casePack rounds up to full cases', () => {
            // velocity=1, supply=45 → target=45, stock=10 → need 35
            // casePack=6 → ceil(35/6)*6 = 36
            const result = calculateReorderQuantity({
                velocity: 1,
                supplyDays: 45,
                casePack: 6,
                currentStock: 10
            });
            expect(result).toBe(36);
        });

        test('casePack of 1 has no effect', () => {
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                casePack: 1,
                currentStock: 20
            });
            expect(result).toBe(70);
        });

        test('casePack and reorderMultiple applied in order', () => {
            // velocity=1, supply=45 → target=45, stock=10 → need 35
            // casePack=6 → ceil(35/6)*6 = 36
            // reorderMultiple=12 → ceil(36/12)*12 = 36 (already a multiple)
            const result = calculateReorderQuantity({
                velocity: 1,
                supplyDays: 45,
                casePack: 6,
                reorderMultiple: 12,
                currentStock: 10
            });
            expect(result).toBe(36);
        });

        test('casePack and reorderMultiple where multiple rounds further', () => {
            // velocity=1, supply=20 → target=20, stock=5 → need 15
            // casePack=4 → ceil(15/4)*4 = 16
            // reorderMultiple=12 → ceil(16/12)*12 = 24
            const result = calculateReorderQuantity({
                velocity: 1,
                supplyDays: 20,
                casePack: 4,
                reorderMultiple: 12,
                currentStock: 5
            });
            expect(result).toBe(24);
        });

        // --- stockAlertMax cap ---

        test('stockAlertMax caps suggested quantity', () => {
            // velocity=2, supply=45 → target=90, stock=20 → need 70
            // stockAlertMax=50 → min(70, 50-20) = 30
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                stockAlertMax: 50,
                currentStock: 20
            });
            expect(result).toBe(30);
        });

        test('stockAlertMax null means unlimited', () => {
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                stockAlertMax: null,
                currentStock: 20
            });
            expect(result).toBe(70);
        });

        test('stockAlertMax already exceeded returns 0', () => {
            // stock=60, max=50 → min(anything, 50-60) = -10 → max(0, -10) = 0
            const result = calculateReorderQuantity({
                velocity: 2,
                supplyDays: 45,
                stockAlertMax: 50,
                currentStock: 60
            });
            expect(result).toBe(0);
        });

        // --- Edge cases ---

        test('returns 0 when stock exceeds target', () => {
            const result = calculateReorderQuantity({
                velocity: 1,
                supplyDays: 10,
                currentStock: 100
            });
            expect(result).toBe(0);
        });

        test('negative currentStock treated as needing more', () => {
            // velocity=1, supply=10 → target=10, stock=-5 → need 15
            const result = calculateReorderQuantity({
                velocity: 1,
                supplyDays: 10,
                currentStock: -5
            });
            expect(result).toBe(15);
        });

        test('never returns negative', () => {
            const result = calculateReorderQuantity({
                velocity: 0.01,
                supplyDays: 1,
                stockAlertMax: 5,
                currentStock: 100
            });
            expect(result).toBeGreaterThanOrEqual(0);
        });
    });

    // ==================== calculateDaysOfStock ====================

    describe('calculateDaysOfStock', () => {

        test('normal case: stock / velocity', () => {
            const result = calculateDaysOfStock({ currentStock: 100, velocity: 5 });
            expect(result).toBe(20);
        });

        test('rounds to 1 decimal place', () => {
            const result = calculateDaysOfStock({ currentStock: 10, velocity: 3 });
            expect(result).toBe(3.3);
        });

        test('zero stock returns 0', () => {
            const result = calculateDaysOfStock({ currentStock: 0, velocity: 5 });
            expect(result).toBe(0);
        });

        test('negative stock returns 0', () => {
            const result = calculateDaysOfStock({ currentStock: -10, velocity: 5 });
            expect(result).toBe(0);
        });

        test('zero velocity returns 999', () => {
            const result = calculateDaysOfStock({ currentStock: 100, velocity: 0 });
            expect(result).toBe(999);
        });

        test('negative velocity returns 999', () => {
            const result = calculateDaysOfStock({ currentStock: 100, velocity: -1 });
            expect(result).toBe(999);
        });

        test('both zero returns 0 (stock takes priority)', () => {
            const result = calculateDaysOfStock({ currentStock: 0, velocity: 0 });
            expect(result).toBe(0);
        });

        test('fractional velocity', () => {
            const result = calculateDaysOfStock({ currentStock: 10, velocity: 0.5 });
            expect(result).toBe(20);
        });
    });
});
