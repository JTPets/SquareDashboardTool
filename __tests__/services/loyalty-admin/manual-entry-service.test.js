/**
 * Tests for services/loyalty-admin/manual-entry-service.js
 *
 * Validates manual loyalty purchase entry: quantity parsing,
 * delegation to processQualifyingPurchase, response mapping.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/purchase-service', () => ({
    processQualifyingPurchase: jest.fn(),
}));

const { processManualEntry } = require('../../../services/loyalty-admin/manual-entry-service');
const { processQualifyingPurchase } = require('../../../services/loyalty-admin/purchase-service');

const MERCHANT_ID = 1;

describe('manual-entry-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws on missing merchantId', async () => {
        await expect(processManualEntry({ squareOrderId: 'ORD_1' }))
            .rejects.toThrow('merchantId is required');
    });

    test('delegates to processQualifyingPurchase with correct params', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: true,
            purchaseEvent: { id: 1 },
            reward: { currentQuantity: 3, requiredQuantity: 10 }
        });

        await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: '2',
            purchasedAt: '2026-01-15T12:00:00Z'
        });

        expect(processQualifyingPurchase).toHaveBeenCalledWith({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 2,
            unitPriceCents: 0,
            purchasedAt: '2026-01-15T12:00:00Z',
            squareLocationId: null,
            customerSource: 'manual'
        });
    });

    test('defaults quantity to 1 when invalid', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: true,
            purchaseEvent: { id: 1 },
            reward: { currentQuantity: 1, requiredQuantity: 10 }
        });

        await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 'invalid'
        });

        expect(processQualifyingPurchase).toHaveBeenCalledWith(
            expect.objectContaining({ quantity: 1 })
        );
    });

    test('defaults purchasedAt to current date when not provided', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: true,
            purchaseEvent: { id: 1 },
            reward: { currentQuantity: 1, requiredQuantity: 10 }
        });

        const before = new Date();
        await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 1
        });

        const callArgs = processQualifyingPurchase.mock.calls[0][0];
        expect(callArgs.purchasedAt).toBeInstanceOf(Date);
        expect(callArgs.purchasedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    test('returns success with message on processed purchase', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: true,
            purchaseEvent: { id: 42 },
            reward: { currentQuantity: 5, requiredQuantity: 10 }
        });

        const result = await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 3
        });

        expect(result.success).toBe(true);
        expect(result.purchaseEvent.id).toBe(42);
        expect(result.message).toBe('Recorded 3 purchase(s). Progress: 5/10');
    });

    test('returns error for variation_not_qualifying', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: false,
            reason: 'variation_not_qualifying'
        });

        const result = await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 1
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('variation_not_qualifying');
        expect(result.message).toContain('not configured as a qualifying item');
    });

    test('returns error for already_processed', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: false,
            reason: 'already_processed'
        });

        const result = await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 1
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('already_processed');
        expect(result.message).toContain('already been recorded');
    });

    test('returns generic error for unknown rejection reason', async () => {
        processQualifyingPurchase.mockResolvedValue({
            processed: false,
            reason: 'some_other_reason'
        });

        const result = await processManualEntry({
            merchantId: MERCHANT_ID,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            variationId: 'VAR_1',
            quantity: 1
        });

        expect(result.success).toBe(false);
        expect(result.message).toBe('Could not process this purchase');
    });
});
