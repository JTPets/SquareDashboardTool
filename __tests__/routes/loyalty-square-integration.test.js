/**
 * Tests for routes/loyalty/square-integration.js
 *
 * Square Loyalty program integration routes:
 * - GET /square-program
 * - PUT /offers/:id/square-tier
 * - POST /rewards/:id/create-square-reward
 * - POST /rewards/sync-to-pos
 * - GET /rewards/pending-sync
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const mockLoyaltyService = {
    getSquareLoyaltyProgram: jest.fn(),
    linkOfferToSquareTier: jest.fn(),
    createSquareReward: jest.fn(),
    syncRewardsToPOS: jest.fn(),
    getPendingSyncCounts: jest.fn(),
};

jest.mock('../../services/loyalty-admin', () => mockLoyaltyService);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
    requireWriteAccess: (req, res, next) => {
        if (req.session?.user?.role === 'viewer') {
            return res.status(403).json({ error: 'Write access required' });
        }
        next();
    },
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(400).json({ error: 'Merchant context required' });
        }
        next();
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');

const OFFER_UUID = '54de3dd3-0870-469a-9063-677c39b52917';
const REWARD_UUID = '616f80d8-5bb9-4882-8165-ec32b6d395d7';

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true, role = 'admin' } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, email: 'test@test.com', role };
        if (hasMerchant) req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    const squareIntegrationRoutes = require('../../routes/loyalty/square-integration');
    app.use('/api/loyalty', squareIntegrationRoutes);
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

describe('Loyalty Square Integration Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    // ========================================================================
    // GET /api/loyalty/square-program
    // ========================================================================

    describe('GET /api/loyalty/square-program', () => {
        it('should return program with reward tiers when program exists', async () => {
            mockLoyaltyService.getSquareLoyaltyProgram.mockResolvedValueOnce({
                id: 'prog_1',
                terminology: { one: 'Point' },
                reward_tiers: [
                    { id: 'tier_1', name: 'Free Item', points: 100, definition: { scope: 'ORDER' } }
                ]
            });

            const res = await request(app).get('/api/loyalty/square-program');

            expect(res.status).toBe(200);
            expect(res.body.hasProgram).toBe(true);
            expect(res.body.programId).toBe('prog_1');
            expect(res.body.programName).toBe('Point');
            expect(res.body.rewardTiers).toHaveLength(1);
            expect(res.body.rewardTiers[0]).toEqual({
                id: 'tier_1',
                name: 'Free Item',
                points: 100,
                definition: { scope: 'ORDER' }
            });
        });

        it('should return hasProgram: false when no program exists', async () => {
            mockLoyaltyService.getSquareLoyaltyProgram.mockResolvedValueOnce(null);

            const res = await request(app).get('/api/loyalty/square-program');

            expect(res.status).toBe(200);
            expect(res.body.hasProgram).toBe(false);
            expect(res.body.setupUrl).toContain('squareup.com');
        });

        it('should default programName to Loyalty when no terminology', async () => {
            mockLoyaltyService.getSquareLoyaltyProgram.mockResolvedValueOnce({
                id: 'prog_1',
                reward_tiers: []
            });

            const res = await request(app).get('/api/loyalty/square-program');

            expect(res.body.programName).toBe('Loyalty');
        });

        it('should handle empty reward_tiers', async () => {
            mockLoyaltyService.getSquareLoyaltyProgram.mockResolvedValueOnce({
                id: 'prog_1',
                terminology: { one: 'Star' },
                reward_tiers: []
            });

            const res = await request(app).get('/api/loyalty/square-program');

            expect(res.body.rewardTiers).toEqual([]);
        });

        it('should handle missing reward_tiers property', async () => {
            mockLoyaltyService.getSquareLoyaltyProgram.mockResolvedValueOnce({
                id: 'prog_1',
                terminology: { one: 'Star' }
            });

            const res = await request(app).get('/api/loyalty/square-program');

            expect(res.body.rewardTiers).toEqual([]);
        });

        it('should require authentication', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/loyalty/square-program');
            expect(res.status).toBe(401);
        });
    });

    // ========================================================================
    // PUT /api/loyalty/offers/:id/square-tier
    // ========================================================================

    describe('PUT /api/loyalty/offers/:id/square-tier', () => {
        it('should link offer to Square tier', async () => {
            mockLoyaltyService.linkOfferToSquareTier.mockResolvedValueOnce({
                id: OFFER_UUID,
                offer_name: 'Buy 12 Free',
                square_reward_tier_id: 'tier_1'
            });

            const res = await request(app)
                .put(`/api/loyalty/offers/${OFFER_UUID}/square-tier`)
                .send({ squareRewardTierId: 'tier_1' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.offer.square_reward_tier_id).toBe('tier_1');
            expect(mockLoyaltyService.linkOfferToSquareTier).toHaveBeenCalledWith({
                merchantId: 1,
                offerId: OFFER_UUID,
                squareRewardTierId: 'tier_1'
            });
        });

        it('should return 404 when offer not found', async () => {
            mockLoyaltyService.linkOfferToSquareTier.mockResolvedValueOnce(null);

            const res = await request(app)
                .put(`/api/loyalty/offers/${OFFER_UUID}/square-tier`)
                .send({ squareRewardTierId: 'tier_1' });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Offer not found');
        });

        it('should allow null squareRewardTierId (unlink)', async () => {
            mockLoyaltyService.linkOfferToSquareTier.mockResolvedValueOnce({
                id: OFFER_UUID,
                square_reward_tier_id: null
            });

            const res = await request(app)
                .put(`/api/loyalty/offers/${OFFER_UUID}/square-tier`)
                .send({ squareRewardTierId: null });

            expect(res.status).toBe(200);
        });

        it('should reject non-UUID offer ID', async () => {
            const res = await request(app)
                .put('/api/loyalty/offers/not-a-uuid/square-tier')
                .send({ squareRewardTierId: 'tier_1' });

            expect(res.status).toBe(400);
        });

        it('should reject viewer role', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .put(`/api/loyalty/offers/${OFFER_UUID}/square-tier`)
                .send({ squareRewardTierId: 'tier_1' });

            expect(res.status).toBe(403);
        });
    });

    // ========================================================================
    // POST /api/loyalty/rewards/:id/create-square-reward
    // ========================================================================

    describe('POST /api/loyalty/rewards/:id/create-square-reward', () => {
        it('should create Square reward for earned reward', async () => {
            mockLoyaltyService.createSquareReward.mockResolvedValueOnce({
                found: true,
                eligible: true,
                success: true,
                discountId: 'disc_1'
            });

            const res = await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/create-square-reward`);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockLoyaltyService.createSquareReward).toHaveBeenCalledWith({
                merchantId: 1,
                rewardId: REWARD_UUID,
                force: false
            });
        });

        it('should pass force=true from query string', async () => {
            mockLoyaltyService.createSquareReward.mockResolvedValueOnce({
                found: true, eligible: true, success: true
            });

            await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/create-square-reward?force=true`);

            expect(mockLoyaltyService.createSquareReward).toHaveBeenCalledWith(
                expect.objectContaining({ force: true })
            );
        });

        it('should pass force=true from body', async () => {
            mockLoyaltyService.createSquareReward.mockResolvedValueOnce({
                found: true, eligible: true, success: true
            });

            await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/create-square-reward`)
                .send({ force: true });

            expect(mockLoyaltyService.createSquareReward).toHaveBeenCalledWith(
                expect.objectContaining({ force: true })
            );
        });

        it('should return 404 when reward not found', async () => {
            mockLoyaltyService.createSquareReward.mockResolvedValueOnce({
                found: false,
                error: 'Reward not found'
            });

            const res = await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/create-square-reward`);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Reward not found');
        });

        it('should return 400 when reward not eligible', async () => {
            mockLoyaltyService.createSquareReward.mockResolvedValueOnce({
                found: true,
                eligible: false,
                error: 'Reward already synced'
            });

            const res = await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/create-square-reward`);

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Reward already synced');
        });

        it('should reject non-UUID reward ID', async () => {
            const res = await request(app)
                .post('/api/loyalty/rewards/not-uuid/create-square-reward');

            expect(res.status).toBe(400);
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post(`/api/loyalty/rewards/${REWARD_UUID}/create-square-reward`);

            expect(res.status).toBe(403);
        });
    });

    // ========================================================================
    // POST /api/loyalty/rewards/sync-to-pos
    // ========================================================================

    describe('POST /api/loyalty/rewards/sync-to-pos', () => {
        it('should sync earned rewards to POS', async () => {
            mockLoyaltyService.syncRewardsToPOS.mockResolvedValueOnce({
                synced: 5,
                failed: 0,
                skipped: 2
            });

            const res = await request(app)
                .post('/api/loyalty/rewards/sync-to-pos');

            expect(res.status).toBe(200);
            expect(res.body.synced).toBe(5);
            expect(mockLoyaltyService.syncRewardsToPOS).toHaveBeenCalledWith({
                merchantId: 1,
                force: false
            });
        });

        it('should pass force=true from query', async () => {
            mockLoyaltyService.syncRewardsToPOS.mockResolvedValueOnce({ synced: 0 });

            await request(app)
                .post('/api/loyalty/rewards/sync-to-pos?force=true');

            expect(mockLoyaltyService.syncRewardsToPOS).toHaveBeenCalledWith(
                expect.objectContaining({ force: true })
            );
        });

        it('should pass force=true from body', async () => {
            mockLoyaltyService.syncRewardsToPOS.mockResolvedValueOnce({ synced: 0 });

            await request(app)
                .post('/api/loyalty/rewards/sync-to-pos')
                .send({ force: true });

            expect(mockLoyaltyService.syncRewardsToPOS).toHaveBeenCalledWith(
                expect.objectContaining({ force: true })
            );
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post('/api/loyalty/rewards/sync-to-pos');

            expect(res.status).toBe(403);
        });
    });

    // ========================================================================
    // GET /api/loyalty/rewards/pending-sync
    // ========================================================================

    describe('GET /api/loyalty/rewards/pending-sync', () => {
        it('should return pending and synced counts', async () => {
            mockLoyaltyService.getPendingSyncCounts.mockResolvedValueOnce({
                pendingSync: 3,
                alreadySynced: 12,
                total: 15
            });

            const res = await request(app)
                .get('/api/loyalty/rewards/pending-sync');

            expect(res.status).toBe(200);
            expect(res.body.pendingSync).toBe(3);
            expect(res.body.alreadySynced).toBe(12);
            expect(mockLoyaltyService.getPendingSyncCounts).toHaveBeenCalledWith(1);
        });

        it('should require authentication', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/loyalty/rewards/pending-sync');
            expect(res.status).toBe(401);
        });

        it('should not require write access (read-only)', async () => {
            app = createTestApp({ role: 'viewer' });
            mockLoyaltyService.getPendingSyncCounts.mockResolvedValueOnce({ pendingSync: 0 });

            const res = await request(app).get('/api/loyalty/rewards/pending-sync');
            expect(res.status).toBe(200);
        });
    });

    // ========================================================================
    // CROSS-CUTTING
    // ========================================================================

    describe('Middleware enforcement', () => {
        it('should return 401 on all endpoints without auth', async () => {
            app = createTestApp({ authenticated: false });
            const endpoints = [
                { method: 'get', path: '/api/loyalty/square-program' },
                { method: 'get', path: '/api/loyalty/rewards/pending-sync' },
                { method: 'put', path: `/api/loyalty/offers/${OFFER_UUID}/square-tier` },
                { method: 'post', path: `/api/loyalty/rewards/${REWARD_UUID}/create-square-reward` },
                { method: 'post', path: '/api/loyalty/rewards/sync-to-pos' },
            ];
            for (const ep of endpoints) {
                const res = await request(app)[ep.method](ep.path);
                expect(res.status).toBe(401);
            }
        });

        it('should return 400 on all endpoints without merchant context', async () => {
            app = createTestApp({ hasMerchant: false });
            const endpoints = [
                { method: 'get', path: '/api/loyalty/square-program' },
                { method: 'get', path: '/api/loyalty/rewards/pending-sync' },
            ];
            for (const ep of endpoints) {
                const res = await request(app)[ep.method](ep.path);
                expect(res.status).toBe(400);
            }
        });
    });
});
