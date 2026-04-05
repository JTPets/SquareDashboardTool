/**
 * Tests for utils/subscription-handler — plan lookup failure fix (B5)
 *
 * Verifies that createSubscriber fails loudly when the plan cannot be
 * found in the database, rather than silently charging a wrong amount.
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(undefined)
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const emailNotifier = require('../../utils/email-notifier');
const { createSubscriber } = require('../../utils/subscription-handler');

const BASE_PARAMS = {
    email: 'owner@example.com',
    businessName: 'Paws & Claws',
    plan: 'monthly',
    squareCustomerId: 'sq_cust_abc',
    cardBrand: 'VISA',
    cardLastFour: '1234',
    cardId: 'sq_card_abc',
    merchantId: 7
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createSubscriber — plan lookup failure', () => {
    test('throws when plan not found in DB — does not insert subscriber', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // plan lookup returns nothing

        await expect(createSubscriber(BASE_PARAMS)).rejects.toThrow(
            /plan "monthly" not found for merchant 7/i
        );

        // Only one DB call should have happened (the plan SELECT), no INSERT
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][0]).toMatch(/SELECT.*price_cents.*subscription_plans/is);
    });

    test('logs error with merchantId and plan when plan lookup fails', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(createSubscriber(BASE_PARAMS)).rejects.toThrow();

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringMatching(/plan lookup failed/i),
            expect.objectContaining({ plan: 'monthly', merchantId: 7 })
        );
    });

    test('sends alert email when plan lookup fails', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(createSubscriber(BASE_PARAMS)).rejects.toThrow();

        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            expect.stringMatching(/plan lookup failed/i),
            expect.stringContaining('monthly')
        );
    });

    test('throws when plan row exists but price_cents is null/zero', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: null }] });

        await expect(createSubscriber(BASE_PARAMS)).rejects.toThrow(
            /cannot determine price/i
        );
    });
});

describe('createSubscriber — plan lookup success', () => {
    test('uses DB price when plan found — annual plan', async () => {
        const annualParams = { ...BASE_PARAMS, plan: 'annual' };
        db.query
            .mockResolvedValueOnce({ rows: [{ price_cents: 29999 }] })  // plan lookup
            .mockResolvedValueOnce({ rows: [{ id: 1, price_cents: 29999, subscription_plan: 'annual' }] }); // INSERT

        const result = await createSubscriber(annualParams);

        expect(result.price_cents).toBe(29999);
        // Second query (INSERT) should have 29999 in params
        const insertCall = db.query.mock.calls[1];
        expect(insertCall[1]).toContain(29999);
    });

    test('uses DB price when plan found — monthly plan', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] })   // plan lookup
            .mockResolvedValueOnce({ rows: [{ id: 2, price_cents: 2999, subscription_plan: 'monthly' }] }); // INSERT

        const result = await createSubscriber(BASE_PARAMS);

        expect(result.price_cents).toBe(2999);
        const insertCall = db.query.mock.calls[1];
        expect(insertCall[1]).toContain(2999);
    });

    test('does not call emailNotifier when plan found', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] })
            .mockResolvedValueOnce({ rows: [{ id: 3, price_cents: 2999, subscription_plan: 'monthly' }] });

        await createSubscriber(BASE_PARAMS);

        expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
    });
});
