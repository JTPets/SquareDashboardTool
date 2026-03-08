/**
 * Tests for MT-3: ORS API key encryption in delivery-service.js
 */

process.env.NODE_ENV = 'test';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret-for-jest-tests';

const { encryptToken, decryptToken } = require('../../utils/token-encryption');

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// We need to mock the database for delivery-service
const db = require('../../utils/database');
jest.mock('../../utils/database', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn().mockImplementation(async (fn) => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        return fn(mockClient);
    }),
    getClient: jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
    }),
    pool: { end: jest.fn().mockResolvedValue() }
}));

// Mock email-notifier
jest.mock('../../utils/email-notifier', () => ({
    sendCritical: jest.fn().mockResolvedValue(),
    sendAlert: jest.fn().mockResolvedValue(),
    _resolveRecipient: jest.fn().mockResolvedValue('test@example.com'),
    enabled: false,
}));

// Mock the customer identification service
jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: {
        getCustomerBySquareId: jest.fn().mockResolvedValue(null)
    }
}));

const deliveryService = require('../../services/delivery/delivery-service');

describe('Delivery ORS key encryption', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getSettings - decryption', () => {
        test('returns decrypted ORS key from ors_api_key_encrypted column', async () => {
            const testKey = 'my-secret-ors-key-12345';
            const encrypted = encryptToken(testKey);

            db.query.mockResolvedValueOnce({
                rows: [{
                    merchant_id: 1,
                    ors_api_key_encrypted: encrypted,
                    openrouteservice_api_key: null,
                    start_address: '123 Main St'
                }]
            });

            const settings = await deliveryService.getSettings(1);

            expect(settings.openrouteservice_api_key).toBe(testKey);
        });

        test('migrates plaintext key to encrypted on read', async () => {
            const plaintextKey = 'plaintext-ors-key-abc';

            db.query.mockResolvedValueOnce({
                rows: [{
                    merchant_id: 1,
                    ors_api_key_encrypted: null,
                    openrouteservice_api_key: plaintextKey,
                    start_address: '123 Main St'
                }]
            });

            // Mock the fire-and-forget migration update
            db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const settings = await deliveryService.getSettings(1);

            // Should return the plaintext key
            expect(settings.openrouteservice_api_key).toBe(plaintextKey);

            // Should have attempted to encrypt and store
            expect(db.query).toHaveBeenCalledTimes(2);
            const migrationCall = db.query.mock.calls[1];
            expect(migrationCall[0]).toContain('ors_api_key_encrypted');
            expect(migrationCall[0]).toContain('openrouteservice_api_key = NULL');
            // Verify the encrypted value can be decrypted back
            expect(decryptToken(migrationCall[1][0])).toBe(plaintextKey);
        });

        test('returns null when no ORS key configured', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    merchant_id: 1,
                    ors_api_key_encrypted: null,
                    openrouteservice_api_key: null,
                    start_address: '123 Main St'
                }]
            });

            const settings = await deliveryService.getSettings(1);

            expect(settings.openrouteservice_api_key).toBeNull();
        });

        test('returns null when no settings exist', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const settings = await deliveryService.getSettings(1);

            expect(settings).toBeNull();
        });
    });

    describe('updateSettings - encryption', () => {
        test('encrypts ORS key before storing', async () => {
            const testKey = 'new-ors-api-key-xyz';

            db.query.mockResolvedValueOnce({
                rows: [{
                    merchant_id: 1,
                    ors_api_key_encrypted: encryptToken(testKey),
                    openrouteservice_api_key: null,
                    start_address: null
                }]
            });

            await deliveryService.updateSettings(1, {
                openrouteserviceApiKey: testKey
            });

            const insertCall = db.query.mock.calls[0];
            // The 11th parameter ($11) should be the encrypted key
            const encryptedParam = insertCall[1][10]; // 0-indexed, position 10
            expect(encryptedParam).not.toBe(testKey);
            expect(encryptedParam).toBeTruthy();
            expect(decryptToken(encryptedParam)).toBe(testKey);
        });

        test('passes null for encrypted key when no key provided', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    merchant_id: 1,
                    ors_api_key_encrypted: null,
                    openrouteservice_api_key: null,
                    start_address: '123 Main St'
                }]
            });

            await deliveryService.updateSettings(1, {
                startAddress: '456 Oak Ave'
            });

            const insertCall = db.query.mock.calls[0];
            const encryptedParam = insertCall[1][10];
            expect(encryptedParam).toBeNull();
        });
    });
});
