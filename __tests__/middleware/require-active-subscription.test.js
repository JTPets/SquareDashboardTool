/**
 * Tests for require-active-subscription middleware.
 *
 * Verifies that expired-trial merchants retain GET (read-only) access
 * while write methods are blocked with 402. Platform owners and active
 * subscribers always pass.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const { requireActiveSubscription } = require('../../middleware/require-active-subscription');

describe('requireActiveSubscription middleware', () => {
    let res, next;

    beforeEach(() => {
        next = jest.fn();
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    describe('GET requests — read-only access preserved', () => {
        it('allows expired-trial merchant GET /api/catalog (read access preserved)', () => {
            const req = {
                method: 'GET',
                path: '/catalog/items',
                merchantContext: {
                    id: 2,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'expired',
                },
            };

            requireActiveSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('allows expired-trial merchant GET on any base route', () => {
            const req = {
                method: 'GET',
                merchantContext: { id: 2, isSubscriptionValid: false, subscriptionStatus: 'expired' },
            };

            requireActiveSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        it('allows expired-trial merchant GET even without merchantContext', () => {
            const req = { method: 'GET', merchantContext: null };

            requireActiveSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });

    describe('Write methods — blocked for expired subscriptions', () => {
        const expiredCtx = { id: 2, isSubscriptionValid: false, subscriptionStatus: 'expired' };

        it('blocks expired-trial merchant POST /api/catalog with 402', () => {
            const req = { method: 'POST', merchantContext: expiredCtx };

            requireActiveSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false,
                    code: 'SUBSCRIPTION_EXPIRED',
                    redirectTo: '/subscription-expired.html',
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('blocks expired-trial merchant PUT with 402', () => {
            const req = { method: 'PUT', merchantContext: expiredCtx };

            requireActiveSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(next).not.toHaveBeenCalled();
        });

        it('blocks expired-trial merchant PATCH with 402', () => {
            const req = { method: 'PATCH', merchantContext: expiredCtx };

            requireActiveSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(next).not.toHaveBeenCalled();
        });

        it('blocks expired-trial merchant DELETE with 402', () => {
            const req = { method: 'DELETE', merchantContext: expiredCtx };

            requireActiveSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(next).not.toHaveBeenCalled();
        });

        it('returns 403 when write attempted with no merchantContext', () => {
            const req = { method: 'POST', merchantContext: null };

            requireActiveSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ code: 'NO_MERCHANT' })
            );
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('Platform owner — always passes', () => {
        it('allows platform owner POST (isSubscriptionValid=true set by loadMerchantContext)', () => {
            const req = {
                method: 'POST',
                merchantContext: {
                    id: 1,
                    isSubscriptionValid: true,
                    subscriptionStatus: 'platform_owner',
                },
            };

            requireActiveSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });
    });

    describe('Active subscriber — always passes', () => {
        it('allows active subscriber POST', () => {
            const req = {
                method: 'POST',
                merchantContext: { id: 3, isSubscriptionValid: true, subscriptionStatus: 'active' },
            };

            requireActiveSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        it('allows active trial subscriber POST', () => {
            const req = {
                method: 'POST',
                merchantContext: {
                    id: 4,
                    isSubscriptionValid: true,
                    subscriptionStatus: 'trial',
                    trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
                },
            };

            requireActiveSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });

    describe('402 response shape', () => {
        it('includes redirectTo subscription-expired.html in 402 body', () => {
            const req = {
                method: 'POST',
                merchantContext: { id: 2, isSubscriptionValid: false, subscriptionStatus: 'expired' },
            };

            requireActiveSubscription(req, res, next);

            const body = res.json.mock.calls[0][0];
            expect(body.redirectTo).toBe('/subscription-expired.html');
            expect(body.subscriptionStatus).toBe('expired');
        });
    });
});
