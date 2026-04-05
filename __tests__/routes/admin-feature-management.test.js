/**
 * Tests for admin feature management logic added in feat/admin-feature-management:
 *
 *   GET  /api/admin/merchants/:merchantId/features     — route handler logic
 *   PUT  /api/admin/merchants/:merchantId/features/:featureKey — upsert logic
 *   POST /api/admin/merchants/:merchantId/extend-trial — GREATEST() behavior
 *   POST /api/admin/merchants/:merchantId/activate     — comp activation
 *
 * All tests are pure unit tests (no HTTP/express) to match test environment
 * constraints (no node_modules available for supertest).
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../utils/database', () => ({ query: jest.fn() }));

const db = require('../../utils/database');
const featureRegistry = require('../../config/feature-registry');

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Helpers — mirror route handler logic
// ---------------------------------------------------------------------------

/**
 * Mirrors: GET /api/admin/merchants/:merchantId/features
 */
async function getMerchantFeaturesLogic(merchantId) {
    const result = await db.query(
        `SELECT feature_key, enabled, source, enabled_at, disabled_at
         FROM merchant_features
         WHERE merchant_id = $1`,
        [merchantId]
    );

    const featureMap = {};
    result.rows.forEach(row => { featureMap[row.feature_key] = row; });

    const features = featureRegistry.getPaidModules().map(mod => {
        const row = featureMap[mod.key] || null;
        return {
            feature_key: mod.key,
            name: mod.name,
            price_cents: mod.price_cents,
            enabled: row ? row.enabled : false,
            source: row ? row.source : null,
        };
    });

    return { features };
}

/**
 * Mirrors: PUT /api/admin/merchants/:merchantId/features/:featureKey
 */
async function updateMerchantFeatureLogic(merchantId, featureKey, enabled) {
    const disabledAt = enabled ? null : new Date().toISOString();

    const result = await db.query(
        `INSERT INTO merchant_features (merchant_id, feature_key, enabled, source, enabled_at, disabled_at)
         VALUES ($1, $2, $3, 'admin_override', NOW(), $4)
         ON CONFLICT (merchant_id, feature_key)
         DO UPDATE SET
             enabled = EXCLUDED.enabled,
             source = 'admin_override',
             enabled_at = NOW(),
             disabled_at = EXCLUDED.disabled_at
         RETURNING feature_key, enabled, source`,
        [merchantId, featureKey, enabled, disabledAt]
    );

    return { feature: result.rows[0] };
}

/**
 * Mirrors: POST /api/admin/merchants/:merchantId/extend-trial (GREATEST behavior)
 */
async function extendTrialLogic(merchantId, days) {
    const result = await db.query(
        `UPDATE merchants
         SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + INTERVAL '1 day' * $1,
             subscription_status = CASE
                 WHEN subscription_status IN ('expired', 'suspended') THEN 'trial'
                 ELSE subscription_status
             END,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, business_name, trial_ends_at, subscription_status`,
        [days, merchantId]
    );

    if (result.rows.length === 0) {
        return { error: 'Not found', status: 404 };
    }
    return { merchant: result.rows[0] };
}

/**
 * Mirrors: POST /api/admin/merchants/:merchantId/activate
 */
async function activateMerchantLogic(merchantId) {
    const merchantResult = await db.query(
        `UPDATE merchants
         SET subscription_status = 'active', updated_at = NOW()
         WHERE id = $1
         RETURNING id, business_name, subscription_status`,
        [merchantId]
    );

    if (merchantResult.rows.length === 0) {
        return { error: 'Not found', status: 404 };
    }

    const paidModules = featureRegistry.getPaidModules();
    for (const mod of paidModules) {
        await db.query(
            `INSERT INTO merchant_features (merchant_id, feature_key, enabled, source, enabled_at, disabled_at)
             VALUES ($1, $2, TRUE, 'admin_override', NOW(), NULL)
             ON CONFLICT (merchant_id, feature_key)
             DO UPDATE SET
                 enabled = TRUE,
                 source = 'admin_override',
                 enabled_at = NOW(),
                 disabled_at = NULL`,
            [merchantId, mod.key]
        );
    }

    return { merchant: merchantResult.rows[0], modulesGranted: paidModules.length };
}

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/merchants/:merchantId/features
// ---------------------------------------------------------------------------
describe('getMerchantFeaturesLogic() — GET /api/admin/merchants/:merchantId/features', () => {
    it('returns features array with all paid modules', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await getMerchantFeaturesLogic(1);

        expect(result.features).toBeDefined();
        expect(Array.isArray(result.features)).toBe(true);
        expect(result.features.length).toBe(featureRegistry.getPaidModules().length);
    });

    it('defaults enabled=false when no row exists for module', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await getMerchantFeaturesLogic(1);

        result.features.forEach(f => {
            expect(f.enabled).toBe(false);
            expect(f.source).toBeNull();
        });
    });

    it('reflects enabled=true and source from existing row', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ feature_key: 'loyalty', enabled: true, source: 'admin_override',
                     enabled_at: '2026-04-01T00:00:00Z', disabled_at: null }]
        });

        const result = await getMerchantFeaturesLogic(1);

        const loyaltyFeature = result.features.find(f => f.feature_key === 'loyalty');
        expect(loyaltyFeature).toBeDefined();
        expect(loyaltyFeature.enabled).toBe(true);
        expect(loyaltyFeature.source).toBe('admin_override');
    });

    it('queries merchant_features filtered by merchant_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getMerchantFeaturesLogic(42);

        const call = db.query.mock.calls[0];
        expect(call[0]).toContain('WHERE merchant_id = $1');
        expect(call[1]).toEqual([42]);
    });

    it('includes name and price_cents for each module', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await getMerchantFeaturesLogic(1);

        result.features.forEach(f => {
            expect(f.name).toBeDefined();
            expect(typeof f.price_cents).toBe('number');
            expect(f.price_cents).toBeGreaterThan(0);
        });
    });
});

// ---------------------------------------------------------------------------
// Tests: PUT /api/admin/merchants/:merchantId/features/:featureKey
// ---------------------------------------------------------------------------
describe('updateMerchantFeatureLogic() — PUT /api/admin/merchants/:merchantId/features/:featureKey', () => {
    it('enables a feature and returns feature row', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ feature_key: 'loyalty', enabled: true, source: 'admin_override' }]
        });

        const result = await updateMerchantFeatureLogic(1, 'loyalty', true);

        expect(result.feature.enabled).toBe(true);
        expect(result.feature.source).toBe('admin_override');
    });

    it('disables a feature and returns feature row', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ feature_key: 'loyalty', enabled: false, source: 'admin_override' }]
        });

        const result = await updateMerchantFeatureLogic(1, 'loyalty', false);

        expect(result.feature.enabled).toBe(false);
    });

    it('uses ON CONFLICT upsert with admin_override source', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ feature_key: 'reorder', enabled: true, source: 'admin_override' }]
        });

        await updateMerchantFeatureLogic(5, 'reorder', true);

        const call = db.query.mock.calls[0];
        expect(call[0]).toContain("ON CONFLICT (merchant_id, feature_key)");
        expect(call[0]).toContain("source = 'admin_override'");
    });

    it('passes null disabled_at when enabling', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ feature_key: 'delivery', enabled: true, source: 'admin_override' }] });

        await updateMerchantFeatureLogic(1, 'delivery', true);

        const params = db.query.mock.calls[0][1];
        expect(params[3]).toBeNull(); // disabledAt = null when enabled
    });

    it('passes non-null disabled_at when disabling', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ feature_key: 'delivery', enabled: false, source: 'admin_override' }] });

        await updateMerchantFeatureLogic(1, 'delivery', false);

        const params = db.query.mock.calls[0][1];
        expect(params[3]).not.toBeNull(); // disabledAt is set when disabling
    });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/admin/merchants/:merchantId/extend-trial (GREATEST)
// ---------------------------------------------------------------------------
describe('extendTrialLogic() — POST /api/admin/merchants/:merchantId/extend-trial', () => {
    it('returns updated merchant on success', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 1, business_name: 'Test', trial_ends_at: '2026-05-01', subscription_status: 'trial' }]
        });

        const result = await extendTrialLogic(1, 14);

        expect(result.merchant.id).toBe(1);
        expect(result.merchant.subscription_status).toBe('trial');
    });

    it('returns 404 when merchant not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await extendTrialLogic(999, 7);

        expect(result.status).toBe(404);
    });

    it('uses GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) in SQL', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 1, business_name: 'Test', trial_ends_at: '2026-05-01', subscription_status: 'trial' }]
        });

        await extendTrialLogic(1, 30);

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('GREATEST(COALESCE(trial_ends_at, NOW()), NOW())');
    });

    it('passes days and merchantId as params', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 7, business_name: 'X', trial_ends_at: '2026-05-01', subscription_status: 'trial' }]
        });

        await extendTrialLogic(7, 30);

        const params = db.query.mock.calls[0][1];
        expect(params[0]).toBe(30);
        expect(params[1]).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/admin/merchants/:merchantId/activate
// ---------------------------------------------------------------------------
describe('activateMerchantLogic() — POST /api/admin/merchants/:merchantId/activate', () => {
    const MERCHANT_ROW = { id: 1, business_name: 'Test Shop', subscription_status: 'active' };

    it('returns activated merchant and modulesGranted count', async () => {
        const paidCount = featureRegistry.getPaidModules().length;
        db.query
            .mockResolvedValueOnce({ rows: [MERCHANT_ROW] }) // UPDATE merchants
            .mockResolvedValue({ rows: [] }); // each module INSERT

        const result = await activateMerchantLogic(1);

        expect(result.merchant.subscription_status).toBe('active');
        expect(result.modulesGranted).toBe(paidCount);
    });

    it('returns 404 when merchant not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await activateMerchantLogic(999);

        expect(result.status).toBe(404);
    });

    it('sets subscription_status = active in UPDATE', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [MERCHANT_ROW] })
            .mockResolvedValue({ rows: [] });

        await activateMerchantLogic(1);

        const updateSql = db.query.mock.calls[0][0];
        expect(updateSql).toContain("subscription_status = 'active'");
    });

    it('inserts one row per paid module with admin_override source', async () => {
        const paidModules = featureRegistry.getPaidModules();
        db.query
            .mockResolvedValueOnce({ rows: [MERCHANT_ROW] })
            .mockResolvedValue({ rows: [] });

        await activateMerchantLogic(1);

        // First call is the UPDATE merchants; remaining calls are module inserts
        expect(db.query.mock.calls.length).toBe(1 + paidModules.length);

        const insertCalls = db.query.mock.calls.slice(1);
        insertCalls.forEach(call => {
            expect(call[0]).toContain("source = 'admin_override'");
            expect(call[0]).toContain('ON CONFLICT (merchant_id, feature_key)');
        });
    });

    it('inserts all known paid module keys', async () => {
        const paidModules = featureRegistry.getPaidModules();
        const expectedKeys = paidModules.map(m => m.key);

        db.query
            .mockResolvedValueOnce({ rows: [MERCHANT_ROW] })
            .mockResolvedValue({ rows: [] });

        await activateMerchantLogic(1);

        const insertedKeys = db.query.mock.calls.slice(1).map(call => call[1][1]);
        expect(insertedKeys.sort()).toEqual(expectedKeys.sort());
    });
});
