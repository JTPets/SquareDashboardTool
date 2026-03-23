/**
 * Square Token Management Tests
 *
 * Tests utils/square-token.js:
 * - AUDIT-5.2.1: Per-merchant mutex prevents concurrent refresh races
 * - Two concurrent refreshes for same merchant only call Square API once
 * - Different merchants can refresh concurrently
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const mockDbQuery = jest.fn();
jest.mock('../../utils/database', () => ({
    query: mockDbQuery,
}));

jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn(t => `enc_${t}`),
    decryptToken: jest.fn(t => t ? `dec_${t}` : null),
}));

const mockObtainToken = jest.fn();
jest.mock('square', () => ({
    SquareClient: jest.fn().mockImplementation(() => ({
        oAuth: { obtainToken: mockObtainToken },
    })),
    SquareEnvironment: { Sandbox: 'sandbox', Production: 'production' },
}));

const { refreshMerchantToken } = require('../../utils/square-token');

function setupMocks(merchantId) {
    mockDbQuery.mockImplementation(async (sql, params) => {
        if (sql.includes('SELECT')) {
            const id = params ? params[0] : merchantId;
            return { rows: [{ id, square_refresh_token: `refresh_${id}` }] };
        }
        return { rows: [] };
    });
}

describe('square-token', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('AUDIT-5.2.1: token refresh mutex', () => {
        it('two concurrent refreshes for same merchant only call Square API once', async () => {
            setupMocks(1);

            // Use a delayed resolution to ensure both calls start before it resolves
            let callCount = 0;
            mockObtainToken.mockImplementation(() => {
                callCount++;
                return Promise.resolve({
                    accessToken: 'new_token',
                    refreshToken: 'new_refresh',
                    expiresAt: '2026-12-31T00:00:00Z',
                });
            });

            // Start two concurrent refreshes for the same merchant
            const [r1, r2] = await Promise.all([
                refreshMerchantToken(1),
                refreshMerchantToken(1),
            ]);

            // Both return the same result
            expect(r1.accessToken).toBe('new_token');
            expect(r2.accessToken).toBe('new_token');

            // Square API was called only once — the mutex deduped the second call
            expect(callCount).toBe(1);
            expect(mockObtainToken).toHaveBeenCalledTimes(1);
        });

        it('different merchants can refresh concurrently', async () => {
            setupMocks();

            mockObtainToken.mockResolvedValue({
                accessToken: 'token',
                refreshToken: 'refresh',
                expiresAt: '2026-12-31T00:00:00Z',
            });

            await Promise.all([
                refreshMerchantToken(1),
                refreshMerchantToken(2),
            ]);

            // Each merchant gets their own API call
            expect(mockObtainToken).toHaveBeenCalledTimes(2);
        });

        it('clears mutex after refresh completes so next call refreshes again', async () => {
            setupMocks(1);

            mockObtainToken.mockResolvedValueOnce({
                accessToken: 'token_1',
                refreshToken: 'refresh_1',
                expiresAt: '2026-12-31T00:00:00Z',
            });

            await refreshMerchantToken(1);

            mockObtainToken.mockResolvedValueOnce({
                accessToken: 'token_2',
                refreshToken: 'refresh_2',
                expiresAt: '2027-01-01T00:00:00Z',
            });

            const result = await refreshMerchantToken(1);
            expect(result.accessToken).toBe('token_2');
            expect(mockObtainToken).toHaveBeenCalledTimes(2);
        });

        it('clears mutex even when refresh fails', async () => {
            setupMocks(1);

            mockObtainToken.mockRejectedValueOnce(new Error('API error'));

            await expect(refreshMerchantToken(1)).rejects.toThrow('API error');

            // Mutex should be cleared, next call should work
            mockObtainToken.mockResolvedValueOnce({
                accessToken: 'recovered_token',
                refreshToken: 'refresh',
                expiresAt: '2026-12-31T00:00:00Z',
            });

            const result = await refreshMerchantToken(1);
            expect(result.accessToken).toBe('recovered_token');
        });
    });
});
