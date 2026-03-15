/**
 * Tests for order-cart module (cart activity tracking)
 *
 * @module __tests__/services/webhook-handlers/order-handler/order-cart
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../../utils/logger', () => logger);
jest.mock('../../../../services/cart/cart-activity-service', () => ({
    createFromDraftOrder: jest.fn(),
    markConverted: jest.fn(),
    markCanceled: jest.fn()
}));

const cartActivityService = require('../../../../services/cart/cart-activity-service');
const { processCartActivity, checkCartConversion, markCartCanceled } = require('../../../../services/webhook-handlers/order-handler/order-cart');

describe('order-cart', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('processCartActivity', () => {
        const order = { id: 'ORDER_1', source: { name: 'Square Online' } };
        const merchantId = 1;

        it('creates cart activity from draft order and populates result', async () => {
            const cart = { id: 42, item_count: 3, status: 'ACTIVE' };
            cartActivityService.createFromDraftOrder.mockResolvedValue(cart);

            const result = {};
            await processCartActivity(order, merchantId, result);

            expect(cartActivityService.createFromDraftOrder).toHaveBeenCalledWith(order, merchantId);
            expect(result.cartActivity).toEqual({
                id: 42,
                itemCount: 3,
                status: 'ACTIVE'
            });
            expect(logger.info).toHaveBeenCalledWith(
                'DRAFT order routed to cart_activity',
                expect.objectContaining({ merchantId, squareOrderId: 'ORDER_1' })
            );
        });

        it('does not set result.cartActivity when createFromDraftOrder returns null', async () => {
            cartActivityService.createFromDraftOrder.mockResolvedValue(null);

            const result = {};
            await processCartActivity(order, merchantId, result);

            expect(result.cartActivity).toBeUndefined();
        });

        it('catches and logs errors without throwing', async () => {
            cartActivityService.createFromDraftOrder.mockRejectedValue(new Error('DB error'));

            const result = {};
            await expect(processCartActivity(order, merchantId, result)).resolves.toBeUndefined();

            expect(logger.error).toHaveBeenCalledWith(
                'Failed to process cart activity',
                expect.objectContaining({ error: 'DB error' })
            );
        });
    });

    describe('checkCartConversion', () => {
        it('logs conversion when markConverted returns a cart', async () => {
            const cart = { id: 10 };
            cartActivityService.markConverted.mockResolvedValue(cart);

            await checkCartConversion('ORDER_2', 1);

            expect(cartActivityService.markConverted).toHaveBeenCalledWith('ORDER_2', 1);
            expect(logger.info).toHaveBeenCalledWith(
                'Cart conversion detected',
                expect.objectContaining({ squareOrderId: 'ORDER_2', cartActivityId: 10 })
            );
        });

        it('does nothing when markConverted returns null', async () => {
            cartActivityService.markConverted.mockResolvedValue(null);

            await checkCartConversion('ORDER_2', 1);

            expect(logger.info).not.toHaveBeenCalled();
        });

        it('catches and logs errors without throwing', async () => {
            cartActivityService.markConverted.mockRejectedValue(new Error('timeout'));

            await expect(checkCartConversion('ORDER_2', 1)).resolves.toBeUndefined();

            expect(logger.warn).toHaveBeenCalledWith(
                'Failed to check cart conversion',
                expect.objectContaining({ error: 'timeout' })
            );
        });
    });

    describe('markCartCanceled', () => {
        it('calls cartActivityService.markCanceled', async () => {
            cartActivityService.markCanceled.mockResolvedValue();

            await markCartCanceled('ORDER_3', 1);

            expect(cartActivityService.markCanceled).toHaveBeenCalledWith('ORDER_3', 1);
        });

        it('catches and logs errors without throwing', async () => {
            cartActivityService.markCanceled.mockRejectedValue(new Error('connection reset'));

            await expect(markCartCanceled('ORDER_3', 1)).resolves.toBeUndefined();

            expect(logger.warn).toHaveBeenCalledWith(
                'Failed to mark cart canceled',
                expect.objectContaining({ error: 'connection reset' })
            );
        });
    });
});
