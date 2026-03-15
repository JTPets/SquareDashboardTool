/**
 * Tests for OAuthHandler webhook handler
 *
 * @module __tests__/services/webhook-handlers/oauth-handler
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => logger);
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));

const db = require('../../../utils/database');
const OAuthHandler = require('../../../services/webhook-handlers/oauth-handler');

describe('OAuthHandler', () => {
    let handler;

    beforeEach(() => {
        jest.clearAllMocks();
        handler = new OAuthHandler();
        db.query.mockResolvedValue({ rowCount: 1 });
    });

    describe('handleAuthorizationRevoked', () => {
        const context = {
            event: {
                merchant_id: 'SQ_MERCHANT_ABC',
                created_at: '2026-03-15T12:00:00Z',
                type: 'oauth.authorization.revoked'
            }
        };

        it('sets merchant is_active=FALSE, square_access_token=REVOKED, refresh_token=NULL', async () => {
            await handler.handleAuthorizationRevoked(context);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('is_active = FALSE'),
                ['SQ_MERCHANT_ABC']
            );
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("square_access_token = 'REVOKED'"),
                expect.any(Array)
            );
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('square_refresh_token = NULL'),
                expect.any(Array)
            );
        });

        it('uses event.merchant_id for the WHERE clause', async () => {
            await handler.handleAuthorizationRevoked(context);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE square_merchant_id = $1'),
                ['SQ_MERCHANT_ABC']
            );
        });

        it('returns { handled: true, revoked: true, merchantId }', async () => {
            const result = await handler.handleAuthorizationRevoked(context);

            expect(result).toEqual({
                handled: true,
                revoked: true,
                merchantId: 'SQ_MERCHANT_ABC'
            });
        });

        it('logs warning and error about revocation', async () => {
            await handler.handleAuthorizationRevoked(context);

            expect(logger.warn).toHaveBeenCalledWith(
                'OAuth authorization revoked via webhook',
                expect.objectContaining({ merchantId: 'SQ_MERCHANT_ABC' })
            );
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('OAUTH REVOKED'),
                expect.objectContaining({ merchantId: 'SQ_MERCHANT_ABC' })
            );
        });
    });
});
