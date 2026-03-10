/**
 * Tests for error classification in order-loyalty.js (HIGH-2 fix)
 *
 * Verifies that:
 * - Transient DB errors (deadlocks, connection failures) are re-thrown
 *   so Square retries the webhook
 * - Known permanent business logic errors are swallowed (logged at WARN)
 * - Unexpected permanent errors are logged at ERROR level for human review
 * - Correct structured fields are present on each error type
 */

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};
jest.mock('../../../utils/logger', () => logger);

jest.mock('../../../services/loyalty-admin', () => ({
    detectRewardRedemptionFromOrder: jest.fn().mockResolvedValue({ detected: false }),
    matchEarnedRewardByFreeItem: jest.fn().mockResolvedValue(null),
    matchEarnedRewardByDiscountAmount: jest.fn().mockResolvedValue(null),
    processOrderRefundsForLoyalty: jest.fn().mockResolvedValue({ processed: false })
}));

jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn()
}));

jest.mock('../../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(),
        identifyCustomerFromOrder: jest.fn().mockResolvedValue({ customerId: 'cust_1', method: 'order.customer_id' })
    }))
}));

jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue({
        orders: {
            get: jest.fn().mockResolvedValue({
                order: {
                    id: 'order_1',
                    state: 'COMPLETED',
                    customer_id: 'cust_1',
                    line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 1000 } }],
                    location_id: 'loc_1'
                }
            })
        }
    })
}));

jest.mock('../../../utils/ttl-cache', () => {
    return jest.fn().mockImplementation(() => ({
        get: jest.fn().mockReturnValue(null),
        set: jest.fn(),
        delete: jest.fn()
    }));
});

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

const { processLoyaltyOrder } = require('../../../services/loyalty-admin/order-intake');
const {
    processLoyalty,
    processPaymentForLoyalty,
    _isTransientError: isTransientError,
    _isKnownPermanentError: isKnownPermanentError
} = require('../../../services/webhook-handlers/order-handler/order-loyalty');

// --- Unit tests for isTransientError ---

describe('isTransientError', () => {
    test('detects PostgreSQL serialization failure (40001)', () => {
        const err = new Error('could not serialize access');
        err.code = '40001';
        expect(isTransientError(err)).toBe(true);
    });

    test('detects PostgreSQL deadlock (40P01)', () => {
        const err = new Error('deadlock detected');
        err.code = '40P01';
        expect(isTransientError(err)).toBe(true);
    });

    test('detects PostgreSQL cannot connect (57P03)', () => {
        const err = new Error('the database system is starting up');
        err.code = '57P03';
        expect(isTransientError(err)).toBe(true);
    });

    test('detects PostgreSQL connection exception class (08*)', () => {
        const err = new Error('connection lost');
        err.code = '08006';
        expect(isTransientError(err)).toBe(true);
    });

    test('detects ECONNREFUSED in message', () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
        expect(isTransientError(err)).toBe(true);
    });

    test('detects ETIMEDOUT in message', () => {
        const err = new Error('connect ETIMEDOUT');
        expect(isTransientError(err)).toBe(true);
    });

    test('detects connection error in message', () => {
        const err = new Error('Connection terminated unexpectedly');
        expect(isTransientError(err)).toBe(true);
    });

    test('detects timeout in message', () => {
        const err = new Error('Query read timeout');
        expect(isTransientError(err)).toBe(true);
    });

    test('detects error.retryable === true (MED-7 partial intake failure)', () => {
        const err = new Error('Order intake failed for 1 variation(s): VAR_001');
        err.retryable = true;
        expect(isTransientError(err)).toBe(true);
    });

    test('does not treat error.retryable === false as transient', () => {
        const err = new Error('some error');
        err.retryable = false;
        expect(isTransientError(err)).toBe(false);
    });

    test('returns false for business logic errors', () => {
        const err = new Error('customer not found');
        expect(isTransientError(err)).toBe(false);
    });

    test('returns false for generic errors without code', () => {
        const err = new Error('something went wrong');
        expect(isTransientError(err)).toBe(false);
    });
});

// --- Unit tests for isKnownPermanentError ---

describe('isKnownPermanentError', () => {
    test('recognizes customer not found', () => {
        expect(isKnownPermanentError(new Error('customer not found in Square'))).toBe(true);
    });

    test('recognizes offer inactive', () => {
        expect(isKnownPermanentError(new Error('offer inactive'))).toBe(true);
    });

    test('recognizes already processed', () => {
        expect(isKnownPermanentError(new Error('Order already processed for loyalty'))).toBe(true);
    });

    test('returns false for unknown errors', () => {
        expect(isKnownPermanentError(new Error('Unexpected null reference'))).toBe(false);
    });
});

// --- Integration tests for processLoyalty error handling ---

describe('processLoyalty error classification', () => {
    const order = {
        id: 'order_test_1',
        state: 'COMPLETED',
        customer_id: 'cust_1',
        line_items: [{ catalog_object_id: 'var_1', quantity: '1', base_price_money: { amount: 1000 } }],
        location_id: 'loc_1'
    };
    const merchantId = 42;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('transient DB error is re-thrown (Square will retry)', async () => {
        const dbError = new Error('Connection terminated unexpectedly');
        dbError.code = '08006';
        processLoyaltyOrder.mockRejectedValueOnce(dbError);

        const result = {};
        await expect(processLoyalty(order, merchantId, result)).rejects.toThrow('Connection terminated unexpectedly');

        // Verify structured log fields
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('transient'),
            expect.objectContaining({
                event: 'loyalty_transient_error',
                orderId: 'order_test_1',
                merchantId: 42,
                error: 'Connection terminated unexpectedly',
                code: '08006',
                willRetry: true
            })
        );
    });

    test('permanent business logic error is swallowed', async () => {
        processLoyaltyOrder.mockRejectedValueOnce(new Error('customer not found'));

        const result = {};
        // Should NOT throw
        await processLoyalty(order, merchantId, result);

        expect(result.loyaltyError).toBe('customer not found');

        // Logged at WARN level with correct structured fields
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('permanent'),
            expect.objectContaining({
                event: 'loyalty_permanent_error',
                orderId: 'order_test_1',
                merchantId: 42,
                error: 'customer not found',
                willRetry: false
            })
        );

        // Should NOT be logged at ERROR level
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('unexpected permanent error logs at ERROR level', async () => {
        processLoyaltyOrder.mockRejectedValueOnce(new Error('Unexpected null reference in fooBar'));

        const result = {};
        // Should NOT throw (still swallowed)
        await processLoyalty(order, merchantId, result);

        expect(result.loyaltyError).toBe('Unexpected null reference in fooBar');

        // Logged at ERROR level with 'unexpected' event
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('unexpected'),
            expect.objectContaining({
                event: 'loyalty_unexpected_error',
                orderId: 'order_test_1',
                merchantId: 42,
                error: 'Unexpected null reference in fooBar',
                willRetry: false
            })
        );
    });

    test('MED-7: retryable partial intake failure is re-thrown (not swallowed)', async () => {
        const intakeError = new Error('Order intake failed for 1 variation(s): VAR_001');
        intakeError.retryable = true;
        processLoyaltyOrder.mockRejectedValueOnce(intakeError);

        const result = {};
        await expect(processLoyalty(order, merchantId, result)).rejects.toThrow('Order intake failed');

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('transient'),
            expect.objectContaining({
                event: 'loyalty_transient_error',
                orderId: 'order_test_1',
                merchantId: 42,
                willRetry: true
            })
        );
    });

    test('deadlock error re-throws for webhook retry', async () => {
        const deadlockError = new Error('deadlock detected');
        deadlockError.code = '40P01';
        processLoyaltyOrder.mockRejectedValueOnce(deadlockError);

        const result = {};
        await expect(processLoyalty(order, merchantId, result)).rejects.toThrow('deadlock detected');

        expect(logger.error).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                event: 'loyalty_transient_error',
                willRetry: true,
                code: '40P01'
            })
        );
    });
});

// --- Integration tests for processPaymentForLoyalty error handling ---

describe('processPaymentForLoyalty error classification', () => {
    const payment = {
        id: 'payment_1',
        order_id: 'order_pay_1',
        status: 'COMPLETED'
    };
    const merchantId = 42;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('transient error on payment path is re-thrown', async () => {
        const timeoutError = new Error('Query read timeout');
        processLoyaltyOrder.mockRejectedValueOnce(timeoutError);

        const result = {};
        await expect(
            processPaymentForLoyalty(payment, merchantId, result, 'payment.updated')
        ).rejects.toThrow('Query read timeout');

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('transient'),
            expect.objectContaining({
                event: 'loyalty_transient_error',
                orderId: 'order_pay_1',
                merchantId: 42,
                willRetry: true
            })
        );
    });

    test('permanent error on payment path is swallowed', async () => {
        processLoyaltyOrder.mockRejectedValueOnce(new Error('offer inactive'));

        const result = {};
        await processPaymentForLoyalty(payment, merchantId, result, 'payment.updated');

        // Should NOT throw — error is swallowed
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('permanent'),
            expect.objectContaining({
                event: 'loyalty_permanent_error',
                orderId: 'order_pay_1',
                willRetry: false
            })
        );
    });
});
