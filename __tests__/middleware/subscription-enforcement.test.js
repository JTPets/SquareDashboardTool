/**
 * Subscription Enforcement Middleware Tests (System A — merchant-level)
 *
 * Tests that requireValidSubscription blocks expired trials,
 * allows active trials, grandfathers NULL trial_ends_at,
 * and skips excluded routes.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const { requireValidSubscription } = require('../../middleware/merchant');

describe('Subscription Enforcement Middleware (System A)', () => {
    let req, res, next;

    beforeEach(() => {
        next = jest.fn();
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    describe('requireValidSubscription', () => {
        it('should block with 402 when subscription is expired', () => {
            req = {
                merchantContext: {
                    id: 2,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'expired',
                }
            };

            requireValidSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false,
                    code: 'SUBSCRIPTION_EXPIRED',
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('should block with 402 when subscription is suspended', () => {
            req = {
                merchantContext: {
                    id: 2,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'suspended',
                }
            };

            requireValidSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(next).not.toHaveBeenCalled();
        });

        it('should allow active trial (trial_ends_at in the future)', () => {
            req = {
                merchantContext: {
                    id: 2,
                    isSubscriptionValid: true,
                    subscriptionStatus: 'trial',
                    trialEndsAt: new Date(Date.now() + 86400000).toISOString(), // tomorrow
                }
            };

            requireValidSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('should allow active subscription', () => {
            req = {
                merchantContext: {
                    id: 1,
                    isSubscriptionValid: true,
                    subscriptionStatus: 'active',
                }
            };

            requireValidSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        it('should grandfather merchants with NULL trial_ends_at (isSubscriptionValid=true)', () => {
            // When subscription_status='trial' and trial_ends_at is NULL,
            // loadMerchantContext sets isSubscriptionValid=true (the else branch)
            req = {
                merchantContext: {
                    id: 1,
                    isSubscriptionValid: true,
                    subscriptionStatus: 'trial',
                    trialEndsAt: null,
                }
            };

            requireValidSubscription(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        it('should block with 403 when no merchant context', () => {
            req = {
                merchantContext: null,
            };

            requireValidSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    code: 'NO_MERCHANT',
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('should block cancelled subscription with 402 (B2 fix)', () => {
            // loadMerchantContext now sets isSubscriptionValid=false for 'cancelled'
            req = {
                merchantContext: {
                    id: 2,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'cancelled',
                }
            };

            requireValidSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false,
                    code: 'SUBSCRIPTION_EXPIRED',
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('should block trial that has expired (trial_ends_at in the past)', () => {
            req = {
                merchantContext: {
                    id: 2,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'trial',
                    trialEndsAt: new Date(Date.now() - 86400000).toISOString(), // yesterday
                }
            };

            requireValidSubscription(req, res, next);

            expect(res.status).toHaveBeenCalledWith(402);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('Subscription enforcement path exclusions', () => {
        // Test the path-matching logic used in server.js
        const subscriptionExcludedPaths = [
            '/health',
            '/auth/',
            '/square/oauth/',
            '/webhooks/',
            '/subscriptions/',
            '/driver/',
            '/admin/',
            '/config',
            '/merchants',
            '/gmc/feed.tsv',
            '/gmc/local-inventory-feed.tsv'
        ];

        function isExcluded(apiPath) {
            for (const excluded of subscriptionExcludedPaths) {
                if (apiPath === excluded || apiPath.startsWith(excluded)) {
                    return true;
                }
            }
            return false;
        }

        it('should skip health check', () => {
            expect(isExcluded('/health')).toBe(true);
        });

        it('should skip OAuth routes', () => {
            expect(isExcluded('/square/oauth/connect')).toBe(true);
            expect(isExcluded('/square/oauth/callback')).toBe(true);
        });

        it('should skip webhook routes', () => {
            expect(isExcluded('/webhooks/square')).toBe(true);
        });

        it('should skip auth routes', () => {
            expect(isExcluded('/auth/login')).toBe(true);
            expect(isExcluded('/auth/forgot-password')).toBe(true);
        });

        it('should skip subscription management routes', () => {
            expect(isExcluded('/subscriptions/plans')).toBe(true);
            expect(isExcluded('/subscriptions/create')).toBe(true);
        });

        it('should skip admin routes', () => {
            expect(isExcluded('/admin/merchants')).toBe(true);
            expect(isExcluded('/admin/settings')).toBe(true);
        });

        it('should skip driver routes', () => {
            expect(isExcluded('/driver/orders')).toBe(true);
        });

        it('should skip merchants and config routes', () => {
            expect(isExcluded('/merchants')).toBe(true);
            expect(isExcluded('/config')).toBe(true);
        });

        it('should NOT skip regular API routes', () => {
            expect(isExcluded('/catalog/items')).toBe(false);
            expect(isExcluded('/inventory/counts')).toBe(false);
            expect(isExcluded('/analytics/reorder')).toBe(false);
            expect(isExcluded('/loyalty/offers')).toBe(false);
            expect(isExcluded('/delivery/orders')).toBe(false);
        });
    });

    describe('loadMerchantContext — cancelled status (B2 fix)', () => {
        const db = require('../../utils/database');
        let loadMerchantContext;

        beforeEach(() => {
            jest.clearAllMocks();
            loadMerchantContext = require('../../middleware/merchant').loadMerchantContext;
        });

        it('sets isSubscriptionValid=false for cancelled merchants', async () => {
            const merchantRow = {
                id: 7,
                square_merchant_id: 'sq_cancelled',
                business_name: 'Cancelled Shop',
                business_email: 'cancelled@test.com',
                subscription_status: 'cancelled',
                trial_ends_at: null,
                subscription_ends_at: null,
                timezone: 'America/Toronto',
                currency: 'CAD',
                locale: 'en-CA',
                settings: {},
                last_sync_at: null,
                square_token_expires_at: null,
                user_role: 'owner'
            };

            db.query
                .mockResolvedValueOnce({ rows: [{ merchant_id: 7 }] })
                .mockResolvedValueOnce({ rows: [merchantRow] })
                .mockResolvedValueOnce({ rows: [] }); // features query

            const req = { session: { user: { id: 1 } }, merchantContext: null };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const nextFn = jest.fn();

            await loadMerchantContext(req, res, nextFn);

            expect(nextFn).toHaveBeenCalled();
            expect(req.merchantContext.subscriptionStatus).toBe('cancelled');
            expect(req.merchantContext.isSubscriptionValid).toBe(false);
        });
    });
});
