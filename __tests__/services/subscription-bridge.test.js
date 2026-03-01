/**
 * Tests for subscription-bridge service
 *
 * Verifies that System B (subscribers/billing) correctly updates
 * System A (merchants/access) when payment events occur.
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const {
    activateMerchantSubscription,
    suspendMerchantSubscription,
    cancelMerchantSubscription,
    resolveMerchantId
} = require('../../services/subscription-bridge');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('activateMerchantSubscription', () => {
    it('should update merchant subscription_status to active', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, subscription_status: 'active', business_name: 'Test Shop' }]
        });

        const result = await activateMerchantSubscription(1, 5);

        expect(result).toEqual({ id: 5, subscription_status: 'active', business_name: 'Test Shop' });
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("SET subscription_status = 'active'"),
            [5]
        );
    });

    it('should return null when merchantId is null', async () => {
        const result = await activateMerchantSubscription(1, null);

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('no merchant_id'),
            expect.any(Object)
        );
    });

    it('should return null when merchant not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await activateMerchantSubscription(1, 999);

        expect(result).toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Merchant not found'),
            expect.any(Object)
        );
    });
});

describe('suspendMerchantSubscription', () => {
    it('should update merchant subscription_status to suspended', async () => {
        // First query: check if platform_owner
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, subscription_status: 'active' }]
        });
        // Second query: update
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, subscription_status: 'suspended', business_name: 'Test Shop' }]
        });

        const result = await suspendMerchantSubscription(1, 5);

        expect(result).toEqual({ id: 5, subscription_status: 'suspended', business_name: 'Test Shop' });
    });

    it('should NOT suspend platform owners', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 3, subscription_status: 'platform_owner' }]
        });

        const result = await suspendMerchantSubscription(1, 3);

        expect(result).toEqual({ id: 3, subscription_status: 'platform_owner' });
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('platform owner'),
            expect.any(Object)
        );
        // Should only have the SELECT query, not the UPDATE
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should return null when merchantId is null', async () => {
        const result = await suspendMerchantSubscription(1, null);
        expect(result).toBeNull();
    });
});

describe('cancelMerchantSubscription', () => {
    it('should update merchant subscription_status to cancelled', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, subscription_status: 'active' }]
        });
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, subscription_status: 'cancelled', business_name: 'Test Shop' }]
        });

        const result = await cancelMerchantSubscription(1, 5);

        expect(result).toEqual({ id: 5, subscription_status: 'cancelled', business_name: 'Test Shop' });
    });

    it('should NOT cancel platform owners', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 3, subscription_status: 'platform_owner' }]
        });

        const result = await cancelMerchantSubscription(1, 3);

        expect(result).toEqual({ id: 3, subscription_status: 'platform_owner' });
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should return null when merchantId is null', async () => {
        const result = await cancelMerchantSubscription(1, null);
        expect(result).toBeNull();
    });
});

describe('resolveMerchantId', () => {
    it('should return merchant_id directly when set on subscriber', async () => {
        const subscriber = { id: 1, email: 'test@test.com', merchant_id: 5 };

        const result = await resolveMerchantId(subscriber);

        expect(result).toBe(5);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('should fall back to email-based lookup via users/user_merchants', async () => {
        const subscriber = { id: 1, email: 'test@test.com', merchant_id: null };

        // Email lookup returns merchant_id
        db.query.mockResolvedValueOnce({
            rows: [{ merchant_id: 7 }]
        });
        // Backfill update
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await resolveMerchantId(subscriber);

        expect(result).toBe(7);
        // Should backfill merchant_id on subscriber
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE subscribers SET merchant_id'),
            [7, 1]
        );
    });

    it('should return null when no match found', async () => {
        const subscriber = { id: 1, email: 'nobody@test.com', merchant_id: null };

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await resolveMerchantId(subscriber);

        expect(result).toBeNull();
    });
});

describe('payment success updates merchant to active', () => {
    it('full flow: subscriber pays → merchant becomes active', async () => {
        // Simulate: subscriber with merchant_id pays, merchant status should update
        db.query.mockResolvedValueOnce({
            rows: [{ id: 10, subscription_status: 'active', business_name: 'Pet Store' }]
        });

        const result = await activateMerchantSubscription(42, 10);

        expect(result.subscription_status).toBe('active');
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("subscription_status = 'active'"),
            [10]
        );
    });
});

describe('payment failure does NOT change subscription for platform owner', () => {
    it('platform owner merchant_id=3 stays platform_owner after payment failure', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 3, subscription_status: 'platform_owner' }]
        });

        const result = await suspendMerchantSubscription(42, 3);

        expect(result.subscription_status).toBe('platform_owner');
        // Only the SELECT, no UPDATE
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});

describe('merchant_id flows through session to payment', () => {
    it('resolveMerchantId returns direct merchant_id from subscriber', async () => {
        const subscriber = { id: 1, merchant_id: 99 };
        const merchantId = await resolveMerchantId(subscriber);
        expect(merchantId).toBe(99);
    });
});
