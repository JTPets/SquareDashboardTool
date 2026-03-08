/**
 * Tests for S-12: POD image serve path traversal protection
 *
 * Verifies that getPodPhoto rejects photo_path values containing
 * directory traversal sequences (e.g., ../../etc/passwd).
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn(v => `enc:${v}`),
    decryptToken: jest.fn(v => v.replace('enc:', '')),
    isEncryptedToken: jest.fn(() => false)
}));

jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn()
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getPodPhoto } = require('../../services/delivery/delivery-service');

describe('getPodPhoto — path traversal protection (S-12)', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should return pod with full_path for valid photo_path', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: '550e8400-e29b-41d4-a716-446655440000',
                photo_path: '1/order123/photo.jpg',
                merchant_id: 1
            }]
        });

        const pod = await getPodPhoto(1, '550e8400-e29b-41d4-a716-446655440000');

        expect(pod).not.toBeNull();
        expect(pod.full_path).toContain('storage/pod');
        expect(pod.full_path).toContain('1/order123/photo.jpg');
    });

    it('should return null for path traversal in photo_path', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: '550e8400-e29b-41d4-a716-446655440000',
                photo_path: '../../../etc/passwd',
                merchant_id: 1
            }]
        });

        const pod = await getPodPhoto(1, '550e8400-e29b-41d4-a716-446655440000');

        expect(pod).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Path traversal attempt detected in POD photo_path',
            expect.objectContaining({
                merchantId: 1,
                photoPath: '../../../etc/passwd'
            })
        );
    });

    it('should return null for absolute path in photo_path', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: '550e8400-e29b-41d4-a716-446655440000',
                photo_path: '/etc/passwd',
                merchant_id: 1
            }]
        });

        const pod = await getPodPhoto(1, '550e8400-e29b-41d4-a716-446655440000');

        expect(pod).toBeNull();
    });

    it('should return null when no POD found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const pod = await getPodPhoto(1, '550e8400-e29b-41d4-a716-446655440000');
        expect(pod).toBeNull();
    });
});
