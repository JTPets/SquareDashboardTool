/**
 * Tests for updateCustomerRewardNote in square-discount-service.js
 *
 * Verifies add/remove operations on customer note reward lines,
 * idempotency, error handling, and multi-reward coexistence.
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        squareApi: jest.fn(),
        purchase: jest.fn(),
        reward: jest.fn(),
        redemption: jest.fn(),
        customer: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }
}));

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    getSquareAccessToken: jest.fn(),
    fetchWithTimeout: jest.fn(),
    getSquareApi: jest.fn(() => ({
        getMerchantToken: jest.fn(),
        makeSquareRequest: jest.fn(),
    })),
}));

jest.mock('../../../services/loyalty-admin/customer-admin-service', () => ({
    getCustomerDetails: jest.fn(),
}));

jest.mock('../../../utils/square-catalog-cleanup', () => ({
    deleteCatalogObjects: jest.fn(),
    deleteCustomerGroupWithMembers: jest.fn(),
}));

const { updateCustomerRewardNote } = require('../../../services/loyalty-admin/square-discount-service');
const { getSquareAccessToken, fetchWithTimeout } = require('../../../services/loyalty-admin/shared-utils');
const logger = require('../../../utils/logger');

// --- Test Data ---

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'CUST_ABC123';
const OFFER_NAME = 'Caravan 1lb';
const REWARD_LINE = '🎁 REWARD: Free Caravan 1lb';

function mockGetCustomer(note, version = 1) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            customer: { id: CUSTOMER_ID, note: note || '', version }
        }),
        text: async () => '',
    };
}

function mockPutCustomer(ok = true) {
    return {
        ok,
        status: ok ? 200 : 500,
        json: async () => ({}),
        text: async () => ok ? '' : 'Internal Server Error',
    };
}

// --- Tests ---

describe('updateCustomerRewardNote', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getSquareAccessToken.mockResolvedValue('test-token');
    });

    describe('add operation', () => {
        test('appends reward line to empty note', async () => {
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(''))
                .mockResolvedValueOnce(mockPutCustomer());

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);

            // Verify PUT body has the reward line
            const putCall = fetchWithTimeout.mock.calls[1];
            const putBody = JSON.parse(putCall[1].body);
            expect(putBody.note).toBe(REWARD_LINE);
            expect(putBody.version).toBe(1);
        });

        test('appends reward line preserving existing note content', async () => {
            const existingNote = 'Delivery: Leave at back door';
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(existingNote))
                .mockResolvedValueOnce(mockPutCustomer());

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);

            const putBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
            expect(putBody.note).toBe(`${existingNote}\n${REWARD_LINE}`);
        });

        test('is idempotent — does not duplicate if line already exists', async () => {
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(REWARD_LINE));

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);
            // Should NOT have made a PUT call
            expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        });

        test('multiple reward lines can coexist for different offers', async () => {
            const existingNote = '🎁 REWARD: Free Orijen 2lb';
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(existingNote))
                .mockResolvedValueOnce(mockPutCustomer());

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);

            const putBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
            expect(putBody.note).toBe(`${existingNote}\n${REWARD_LINE}`);
            expect(putBody.note).toContain('🎁 REWARD: Free Orijen 2lb');
            expect(putBody.note).toContain('🎁 REWARD: Free Caravan 1lb');
        });
    });

    describe('remove operation', () => {
        test('strips reward line, preserves other content', async () => {
            const note = `Delivery: Leave at back door\n${REWARD_LINE}\nVIP customer`;
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(note))
                .mockResolvedValueOnce(mockPutCustomer());

            const result = await updateCustomerRewardNote({
                operation: 'remove',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);

            const putBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
            expect(putBody.note).toBe('Delivery: Leave at back door\nVIP customer');
            expect(putBody.note).not.toContain(REWARD_LINE);
        });

        test('is idempotent — no-op if line not present', async () => {
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer('Some other note'));

            const result = await updateCustomerRewardNote({
                operation: 'remove',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);
            // Should NOT have made a PUT call
            expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        });

        test('cleans up blank lines after removal', async () => {
            const note = `Delivery note\n\n${REWARD_LINE}\n\n\nOther info`;
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(note))
                .mockResolvedValueOnce(mockPutCustomer());

            const result = await updateCustomerRewardNote({
                operation: 'remove',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);

            const putBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
            // Should not have 3+ consecutive newlines
            expect(putBody.note).not.toMatch(/\n{3,}/);
            expect(putBody.note).toContain('Delivery note');
            expect(putBody.note).toContain('Other info');
        });

        test('only removes the exact matching offer line', async () => {
            const note = '🎁 REWARD: Free Orijen 2lb\n🎁 REWARD: Free Caravan 1lb\n🎁 REWARD: Free Caravan 5lb';
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(note))
                .mockResolvedValueOnce(mockPutCustomer());

            const result = await updateCustomerRewardNote({
                operation: 'remove',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(true);

            const putBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
            expect(putBody.note).toContain('🎁 REWARD: Free Orijen 2lb');
            expect(putBody.note).not.toContain('🎁 REWARD: Free Caravan 1lb');
            expect(putBody.note).toContain('🎁 REWARD: Free Caravan 5lb');
        });
    });

    describe('error handling', () => {
        test('API failure on GET does not throw — returns { success: false }', async () => {
            fetchWithTimeout.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error',
            });

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('500');
        });

        test('API failure on PUT does not throw — returns { success: false }', async () => {
            fetchWithTimeout
                .mockResolvedValueOnce(mockGetCustomer(''))
                .mockResolvedValueOnce(mockPutCustomer(false));

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('500');
        });

        test('network error does not throw — returns { success: false }', async () => {
            fetchWithTimeout.mockRejectedValueOnce(new Error('Network timeout'));

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Network timeout');
            expect(logger.error).toHaveBeenCalled();
        });

        test('no access token returns { success: false }', async () => {
            getSquareAccessToken.mockResolvedValueOnce(null);

            const result = await updateCustomerRewardNote({
                operation: 'add',
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                offerName: OFFER_NAME
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('No access token available');
        });
    });
});
