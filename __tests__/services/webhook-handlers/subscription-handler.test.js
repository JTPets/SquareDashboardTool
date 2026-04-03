/**
 * Tests for SubscriptionHandler
 *
 * @module __tests__/services/webhook-handlers/subscription-handler
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => logger);

const mockSubscriptionHandler = {
    getSubscriberBySquareSubscriptionId: jest.fn(),
    getSubscriberBySquareCustomerId: jest.fn(),
    updateSubscriberStatus: jest.fn(),
    activateSubscription: jest.fn(),
    recordPayment: jest.fn()
};
jest.mock('../../../utils/subscription-handler', () => mockSubscriptionHandler);

const mockSubscriptionBridge = {
    resolveMerchantId: jest.fn(),
    activateMerchantSubscription: jest.fn(),
    cancelMerchantSubscription: jest.fn(),
    suspendMerchantSubscription: jest.fn()
};
jest.mock('../../../services/subscriptions/subscription-bridge', () => mockSubscriptionBridge);

const SubscriptionHandler = require('../../../services/webhook-handlers/subscription-handler');

describe('SubscriptionHandler', () => {
    let handler;

    beforeEach(() => {
        jest.clearAllMocks();
        handler = new SubscriptionHandler();
    });

    // ---------------------------------------------------------------
    // handleCreated
    // ---------------------------------------------------------------
    describe('handleCreated', () => {
        it('returns early when no subscription data', async () => {
            const result = await handler.handleCreated({ data: {} });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareSubscriptionId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'subscription.created event missing subscription data'
            );
        });

        it('returns early when subscriber not found', async () => {
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(null);

            const result = await handler.handleCreated({
                data: { subscription: { id: 'sub_123', status: 'ACTIVE' } }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.updateSubscriberStatus).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'No subscriber found for subscription',
                { squareSubscriptionId: 'sub_123' }
            );
        });

        it('activates subscriber and bridges to merchant System A', async () => {
            const subscriber = { id: 42 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(7);

            const result = await handler.handleCreated({
                data: { subscription: { id: 'sub_123', status: 'ACTIVE' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 42, merchantId: 7 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(42, 'active');
            expect(mockSubscriptionBridge.resolveMerchantId).toHaveBeenCalledWith(subscriber);
            expect(mockSubscriptionBridge.activateMerchantSubscription).toHaveBeenCalledWith(42, 7);
            expect(logger.info).toHaveBeenCalledWith(
                'Subscription activated via webhook',
                { subscriberId: 42, merchantId: 7 }
            );
        });

        it('works when resolveMerchantId returns null (no bridge call)', async () => {
            const subscriber = { id: 42 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(null);

            const result = await handler.handleCreated({
                data: { subscription: { id: 'sub_123', status: 'ACTIVE' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 42 });
            expect(result.merchantId).toBeUndefined();
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(42, 'active');
            expect(mockSubscriptionBridge.activateMerchantSubscription).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------
    // handleUpdated
    // ---------------------------------------------------------------
    describe('handleUpdated', () => {
        it('returns early when no subscription data', async () => {
            const result = await handler.handleUpdated({ data: {} });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareSubscriptionId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'subscription.updated event missing subscription data'
            );
        });

        it('returns early when subscriber not found', async () => {
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(null);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'ACTIVE' } }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.updateSubscriberStatus).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'No subscriber found for subscription',
                { squareSubscriptionId: 'sub_456' }
            );
        });

        it('maps ACTIVE status and calls activateMerchantSubscription', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(3);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'ACTIVE' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 10, newStatus: 'active', merchantId: 3 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(10, 'active');
            expect(mockSubscriptionBridge.activateMerchantSubscription).toHaveBeenCalledWith(10, 3);
        });

        it('maps CANCELED status and calls cancelMerchantSubscription', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(3);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'CANCELED' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 10, newStatus: 'canceled', merchantId: 3 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(10, 'canceled');
            expect(mockSubscriptionBridge.cancelMerchantSubscription).toHaveBeenCalledWith(10, 3);
        });

        it('maps DEACTIVATED status and calls cancelMerchantSubscription as expired', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(3);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'DEACTIVATED' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 10, newStatus: 'expired', merchantId: 3 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(10, 'expired');
            expect(mockSubscriptionBridge.cancelMerchantSubscription).toHaveBeenCalledWith(10, 3);
        });

        it('maps PAUSED status and calls suspendMerchantSubscription as past_due', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(3);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'PAUSED' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 10, newStatus: 'past_due', merchantId: 3 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(10, 'past_due');
            expect(mockSubscriptionBridge.suspendMerchantSubscription).toHaveBeenCalledWith(10, 3);
        });

        it('maps PENDING status to trial', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(3);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'PENDING' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 10, newStatus: 'trial', merchantId: 3 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(10, 'trial');
            // trial status doesn't match any bridge condition, so no bridge call
            expect(mockSubscriptionBridge.activateMerchantSubscription).not.toHaveBeenCalled();
            expect(mockSubscriptionBridge.cancelMerchantSubscription).not.toHaveBeenCalled();
            expect(mockSubscriptionBridge.suspendMerchantSubscription).not.toHaveBeenCalled();
        });

        it('defaults unknown status to active', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(3);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'SOME_UNKNOWN_STATUS' } }
            });

            expect(result.newStatus).toBe('active');
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(10, 'active');
            expect(mockSubscriptionBridge.activateMerchantSubscription).toHaveBeenCalledWith(10, 3);
        });

        it('does not bridge when resolveMerchantId returns null', async () => {
            const subscriber = { id: 10 };
            mockSubscriptionHandler.getSubscriberBySquareSubscriptionId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(null);

            const result = await handler.handleUpdated({
                data: { subscription: { id: 'sub_456', status: 'ACTIVE' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 10, newStatus: 'active' });
            expect(result.merchantId).toBeUndefined();
            expect(mockSubscriptionBridge.activateMerchantSubscription).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------
    // handleInvoicePaymentMade
    // ---------------------------------------------------------------
    describe('handleInvoicePaymentMade', () => {
        it('returns early when no invoice data', async () => {
            const result = await handler.handleInvoicePaymentMade({ data: {} });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareCustomerId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'invoice.payment_made event missing invoice data'
            );
        });

        it('returns early when no customer_id', async () => {
            const result = await handler.handleInvoicePaymentMade({
                data: { invoice: { id: 'inv_1', primary_recipient: {} } }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareCustomerId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'invoice.payment_made event missing customer_id'
            );
        });

        it('returns early when subscriber not found', async () => {
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(null);

            const result = await handler.handleInvoicePaymentMade({
                data: {
                    invoice: {
                        id: 'inv_1',
                        primary_recipient: { customer_id: 'cust_99' }
                    }
                }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.activateSubscription).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'No subscriber found for customer',
                { squareCustomerId: 'cust_99' }
            );
        });

        it('activates subscription, records payment with correct fields', async () => {
            const subscriber = { id: 55 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(8);

            const result = await handler.handleInvoicePaymentMade({
                data: {
                    invoice: {
                        id: 'inv_1',
                        primary_recipient: { customer_id: 'cust_99' },
                        payment_requests: [
                            { computed_amount_money: { amount: 2999 } }
                        ]
                    }
                }
            });

            expect(result).toEqual({ handled: true, subscriberId: 55, merchantId: 8 });
            expect(mockSubscriptionHandler.activateSubscription).toHaveBeenCalledWith(55);
            expect(mockSubscriptionHandler.recordPayment).toHaveBeenCalledWith({
                subscriberId: 55,
                squarePaymentId: null,
                squareInvoiceId: 'inv_1',
                amountCents: 2999,
                status: 'completed',
                paymentType: 'subscription'
            });
            expect(mockSubscriptionBridge.activateMerchantSubscription).toHaveBeenCalledWith(55, 8);
        });

        it('bridges to System A when merchant resolved', async () => {
            const subscriber = { id: 55 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(8);

            await handler.handleInvoicePaymentMade({
                data: {
                    invoice: {
                        id: 'inv_1',
                        primary_recipient: { customer_id: 'cust_99' },
                        payment_requests: []
                    }
                }
            });

            expect(mockSubscriptionBridge.activateMerchantSubscription).toHaveBeenCalledWith(55, 8);
            expect(logger.info).toHaveBeenCalledWith(
                'Payment recorded via webhook',
                { subscriberId: 55, merchantId: 8 }
            );
        });

        it('handles invoice with no payment_requests gracefully', async () => {
            const subscriber = { id: 55 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(null);

            await handler.handleInvoicePaymentMade({
                data: {
                    invoice: {
                        id: 'inv_1',
                        primary_recipient: { customer_id: 'cust_99' }
                    }
                }
            });

            expect(mockSubscriptionHandler.recordPayment).toHaveBeenCalledWith(
                expect.objectContaining({
                    amountCents: 0,
                    squarePaymentId: 'inv_1'
                })
            );
        });

        it('sets squarePaymentId to invoice id when no computed_amount_money', async () => {
            const subscriber = { id: 55 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(null);

            await handler.handleInvoicePaymentMade({
                data: {
                    invoice: {
                        id: 'inv_fallback',
                        primary_recipient: { customer_id: 'cust_99' },
                        payment_requests: [{ some_field: true }]
                    }
                }
            });

            // When computed_amount_money is falsy, the ternary resolves to invoice.id
            expect(mockSubscriptionHandler.recordPayment).toHaveBeenCalledWith(
                expect.objectContaining({
                    squarePaymentId: 'inv_fallback',
                    amountCents: 0
                })
            );
        });
    });

    // ---------------------------------------------------------------
    // handleInvoicePaymentFailed
    // ---------------------------------------------------------------
    describe('handleInvoicePaymentFailed', () => {
        it('returns early when no invoice data', async () => {
            const result = await handler.handleInvoicePaymentFailed({ data: {} });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareCustomerId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'invoice.payment_failed event missing invoice data'
            );
        });

        it('returns early when no customer_id', async () => {
            const result = await handler.handleInvoicePaymentFailed({
                data: { invoice: { id: 'inv_2', primary_recipient: {} } }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareCustomerId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'invoice.payment_failed event missing customer_id'
            );
        });

        it('returns early when subscriber not found', async () => {
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(null);

            const result = await handler.handleInvoicePaymentFailed({
                data: {
                    invoice: {
                        id: 'inv_2',
                        primary_recipient: { customer_id: 'cust_88' }
                    }
                }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.updateSubscriberStatus).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'No subscriber found for customer',
                { squareCustomerId: 'cust_88' }
            );
        });

        it('updates status to past_due and records failed payment', async () => {
            const subscriber = { id: 60 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(9);

            const result = await handler.handleInvoicePaymentFailed({
                data: {
                    invoice: {
                        id: 'inv_2',
                        primary_recipient: { customer_id: 'cust_88' },
                        payment_requests: [
                            { computed_amount_money: { amount: 4999 } }
                        ]
                    }
                }
            });

            expect(result).toEqual({ handled: true, subscriberId: 60, merchantId: 9 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(60, 'past_due');
            expect(mockSubscriptionHandler.recordPayment).toHaveBeenCalledWith({
                subscriberId: 60,
                squareInvoiceId: 'inv_2',
                amountCents: 4999,
                status: 'failed',
                paymentType: 'subscription',
                failureReason: 'Payment failed'
            });
        });

        it('suspends merchant in System A', async () => {
            const subscriber = { id: 60 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(9);

            await handler.handleInvoicePaymentFailed({
                data: {
                    invoice: {
                        id: 'inv_2',
                        primary_recipient: { customer_id: 'cust_88' },
                        payment_requests: []
                    }
                }
            });

            expect(mockSubscriptionBridge.suspendMerchantSubscription).toHaveBeenCalledWith(60, 9);
            expect(logger.warn).toHaveBeenCalledWith(
                'Payment failed via webhook',
                { subscriberId: 60, merchantId: 9 }
            );
        });
    });

    // ---------------------------------------------------------------
    // handleCustomerDeleted
    // ---------------------------------------------------------------
    describe('handleCustomerDeleted', () => {
        it('returns early when no customer data', async () => {
            const result = await handler.handleCustomerDeleted({ data: {} });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.getSubscriberBySquareCustomerId).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'customer.deleted event missing customer data'
            );
        });

        it('returns early when subscriber not found', async () => {
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(null);

            const result = await handler.handleCustomerDeleted({
                data: { customer: { id: 'cust_del_1' } }
            });

            expect(result).toEqual({ handled: true });
            expect(mockSubscriptionHandler.updateSubscriberStatus).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'No subscriber found for deleted customer',
                { squareCustomerId: 'cust_del_1' }
            );
        });

        it('cancels subscription and bridges to System A', async () => {
            const subscriber = { id: 77 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(12);

            const result = await handler.handleCustomerDeleted({
                data: { customer: { id: 'cust_del_1' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 77, merchantId: 12 });
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(77, 'canceled');
            expect(mockSubscriptionBridge.cancelMerchantSubscription).toHaveBeenCalledWith(77, 12);
            expect(logger.info).toHaveBeenCalledWith(
                'Customer deleted via webhook',
                { subscriberId: 77, merchantId: 12 }
            );
        });

        it('does not bridge when resolveMerchantId returns null', async () => {
            const subscriber = { id: 77 };
            mockSubscriptionHandler.getSubscriberBySquareCustomerId.mockResolvedValue(subscriber);
            mockSubscriptionBridge.resolveMerchantId.mockResolvedValue(null);

            const result = await handler.handleCustomerDeleted({
                data: { customer: { id: 'cust_del_1' } }
            });

            expect(result).toEqual({ handled: true, subscriberId: 77 });
            expect(result.merchantId).toBeUndefined();
            expect(mockSubscriptionHandler.updateSubscriberStatus).toHaveBeenCalledWith(77, 'canceled');
            expect(mockSubscriptionBridge.cancelMerchantSubscription).not.toHaveBeenCalled();
        });
    });
});
