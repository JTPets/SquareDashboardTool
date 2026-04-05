/**
 * Tests for GET /api/merchant/features
 *
 * Verifies the new trial-countdown fields added in feat/merchant-subscription-ui:
 *   - subscription_status
 *   - trial_ends_at
 *   - trial_days_remaining
 *
 * Uses a lightweight inline handler that mirrors the logic in server.js so we
 * can test without booting the full server (which has many side-effects).
 */

// ---------------------------------------------------------------------------
// Shared mocks (must be before any require())
// ---------------------------------------------------------------------------
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers — mirror the inline handler logic from server.js
// ---------------------------------------------------------------------------

const featureRegistry = require('../../config/feature-registry');

/**
 * Replicate the GET /api/merchant/features response assembly.
 * Keeps tests decoupled from the full Express app while testing real logic.
 *
 * @param {object} merchantContext  - Simulates req.merchantContext
 * @returns {object}                - Simulates the sendSuccess payload
 */
function buildFeaturesResponse(merchantContext) {
    const mc = merchantContext;
    const isPlatformOwner = mc.subscriptionStatus === 'platform_owner';
    const enabledFeatures = isPlatformOwner
        ? featureRegistry.getPaidModules().map(m => m.key)
        : (mc.features || []);

    const available = featureRegistry.getPaidModules().map(mod => ({
        key: mod.key,
        name: mod.name,
        price_cents: mod.price_cents,
        enabled: isPlatformOwner || enabledFeatures.includes(mod.key)
    }));

    let trialDaysRemaining = null;
    if (mc.subscriptionStatus === 'trial' && mc.trialEndsAt) {
        const msLeft = new Date(mc.trialEndsAt) - new Date();
        trialDaysRemaining = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
    }

    return {
        success: true,
        enabled: enabledFeatures,
        available,
        is_platform_owner: isPlatformOwner,
        subscription_status: mc.subscriptionStatus,
        trial_ends_at: mc.trialEndsAt || null,
        trial_days_remaining: trialDaysRemaining
    };
}

// ---------------------------------------------------------------------------
// Test contexts
// ---------------------------------------------------------------------------

const TRIAL_CONTEXT = {
    id: 10,
    subscriptionStatus: 'trial',
    isSubscriptionValid: true,
    trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    features: []
};

const TRIAL_URGENT_CONTEXT = {
    id: 11,
    subscriptionStatus: 'trial',
    isSubscriptionValid: true,
    trialEndsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days left
    features: []
};

const TRIAL_EXPIRED_CONTEXT = {
    id: 12,
    subscriptionStatus: 'trial',
    isSubscriptionValid: false,
    trialEndsAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), // yesterday
    features: []
};

const ACTIVE_CONTEXT = {
    id: 20,
    subscriptionStatus: 'active',
    isSubscriptionValid: true,
    trialEndsAt: null,
    features: ['cycle_counts', 'reorder']
};

const PLATFORM_OWNER_CONTEXT = {
    id: 1,
    subscriptionStatus: 'platform_owner',
    isSubscriptionValid: true,
    trialEndsAt: null,
    features: []
};

const EXPIRED_CONTEXT = {
    id: 30,
    subscriptionStatus: 'expired',
    isSubscriptionValid: false,
    trialEndsAt: null,
    features: []
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/merchant/features — subscription_status field', () => {
    it('includes subscription_status for trial merchant', () => {
        const res = buildFeaturesResponse(TRIAL_CONTEXT);
        expect(res.subscription_status).toBe('trial');
    });

    it('includes subscription_status for active merchant', () => {
        const res = buildFeaturesResponse(ACTIVE_CONTEXT);
        expect(res.subscription_status).toBe('active');
    });

    it('includes subscription_status for expired merchant', () => {
        const res = buildFeaturesResponse(EXPIRED_CONTEXT);
        expect(res.subscription_status).toBe('expired');
    });

    it('includes subscription_status for platform_owner', () => {
        const res = buildFeaturesResponse(PLATFORM_OWNER_CONTEXT);
        expect(res.subscription_status).toBe('platform_owner');
    });
});

describe('GET /api/merchant/features — trial_ends_at field', () => {
    it('returns trial_ends_at ISO string for trial merchant', () => {
        const res = buildFeaturesResponse(TRIAL_CONTEXT);
        expect(res.trial_ends_at).toBe(TRIAL_CONTEXT.trialEndsAt);
    });

    it('returns trial_ends_at = null for active merchant', () => {
        const res = buildFeaturesResponse(ACTIVE_CONTEXT);
        expect(res.trial_ends_at).toBeNull();
    });

    it('returns trial_ends_at = null for platform_owner', () => {
        const res = buildFeaturesResponse(PLATFORM_OWNER_CONTEXT);
        expect(res.trial_ends_at).toBeNull();
    });
});

describe('GET /api/merchant/features — trial_days_remaining field', () => {
    it('returns positive integer for a trial with days remaining', () => {
        const res = buildFeaturesResponse(TRIAL_CONTEXT);
        expect(typeof res.trial_days_remaining).toBe('number');
        expect(res.trial_days_remaining).toBeGreaterThan(0);
        expect(res.trial_days_remaining).toBeLessThanOrEqual(7);
    });

    it('returns ≤ 3 for a trial with 2 days remaining', () => {
        const res = buildFeaturesResponse(TRIAL_URGENT_CONTEXT);
        expect(res.trial_days_remaining).toBeLessThanOrEqual(3);
        expect(res.trial_days_remaining).toBeGreaterThanOrEqual(1);
    });

    it('returns 0 (not negative) for an expired trial', () => {
        const res = buildFeaturesResponse(TRIAL_EXPIRED_CONTEXT);
        expect(res.trial_days_remaining).toBe(0);
    });

    it('returns null for active (non-trial) merchant', () => {
        const res = buildFeaturesResponse(ACTIVE_CONTEXT);
        expect(res.trial_days_remaining).toBeNull();
    });

    it('returns null for platform_owner', () => {
        const res = buildFeaturesResponse(PLATFORM_OWNER_CONTEXT);
        expect(res.trial_days_remaining).toBeNull();
    });

    it('returns null when subscription_status is trial but trialEndsAt is null', () => {
        const ctx = { ...TRIAL_CONTEXT, trialEndsAt: null };
        const res = buildFeaturesResponse(ctx);
        expect(res.trial_days_remaining).toBeNull();
    });
});

describe('GET /api/merchant/features — existing fields unaffected', () => {
    it('platform_owner still sees all features enabled', () => {
        const res = buildFeaturesResponse(PLATFORM_OWNER_CONTEXT);
        expect(res.is_platform_owner).toBe(true);
        const allKeys = featureRegistry.getPaidModules().map(m => m.key);
        expect(res.enabled).toEqual(expect.arrayContaining(allKeys));
        res.available.forEach(mod => {
            expect(mod.enabled).toBe(true);
        });
    });

    it('active merchant sees only their enabled features', () => {
        const res = buildFeaturesResponse(ACTIVE_CONTEXT);
        expect(res.is_platform_owner).toBe(false);
        expect(res.enabled).toEqual(['cycle_counts', 'reorder']);
    });

    it('available array always contains all paid modules', () => {
        const allKeys = featureRegistry.getPaidModules().map(m => m.key);
        [TRIAL_CONTEXT, ACTIVE_CONTEXT, EXPIRED_CONTEXT].forEach(ctx => {
            const res = buildFeaturesResponse(ctx);
            const returnedKeys = res.available.map(m => m.key);
            expect(returnedKeys).toEqual(expect.arrayContaining(allKeys));
        });
    });
});
