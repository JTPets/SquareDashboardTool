'use strict';

/**
 * Feature Gate Middleware Test Suite
 *
 * Tests for per-module feature gating enforcement
 * and loadMerchantContext feature population
 */

const { requireFeature } = require('../../middleware/feature-gate');
const db = require('../../utils/database');

// Mock response factory
function mockResponse() {
    const res = {
        statusCode: 200,
        jsonData: null,
    };
    res.status = jest.fn((code) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((data) => {
        res.jsonData = data;
        return res;
    });
    return res;
}

// Mock request factory
function mockRequest(options = {}) {
    return {
        merchantContext: options.merchantContext || null,
        path: options.path || '/api/test',
    };
}

describe('Feature Gate Middleware', () => {

    describe('requireFeature()', () => {

        test('platform owner bypasses all feature checks', () => {
            const middleware = requireFeature('cycle_counts');
            const req = mockRequest({
                merchantContext: {
                    id: 1,
                    subscriptionStatus: 'platform_owner',
                    features: []
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('free module (base) always passes regardless of merchant_features', () => {
            const middleware = requireFeature('base');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    subscriptionStatus: 'active',
                    features: []
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('enabled feature passes', () => {
            const middleware = requireFeature('cycle_counts');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    subscriptionStatus: 'active',
                    features: ['cycle_counts', 'reorder']
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('disabled feature returns 403 with FEATURE_REQUIRED code', () => {
            const middleware = requireFeature('delivery');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    subscriptionStatus: 'active',
                    features: ['cycle_counts']
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.success).toBe(false);
            expect(res.jsonData.code).toBe('FEATURE_REQUIRED');
            expect(res.jsonData.feature).toBe('delivery');
        });

        test('missing merchant context returns 403', () => {
            const middleware = requireFeature('cycle_counts');
            const req = mockRequest({ merchantContext: null });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('NO_MERCHANT');
        });

        test('merchant with no features and non-platform-owner gets 403 for paid features', () => {
            const middleware = requireFeature('expiry');
            const req = mockRequest({
                merchantContext: {
                    id: 3,
                    subscriptionStatus: 'active',
                    features: []
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('FEATURE_REQUIRED');
            expect(res.jsonData.feature).toBe('expiry');
            expect(res.jsonData.module_name).toBe('Expiry Automation');
            expect(res.jsonData.price_cents).toBe(999);
        });

        test('merchant with undefined features array gets 403 for paid features', () => {
            const middleware = requireFeature('loyalty');
            const req = mockRequest({
                merchantContext: {
                    id: 4,
                    subscriptionStatus: 'trial'
                    // features not set
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('FEATURE_REQUIRED');
        });

        test('response includes module_name and price_cents for known features', () => {
            const middleware = requireFeature('gmc');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    subscriptionStatus: 'active',
                    features: []
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(res.jsonData.module_name).toBe('Google Shopping');
            expect(res.jsonData.price_cents).toBe(999);
        });

        test('platform owner with empty features array still bypasses', () => {
            const middleware = requireFeature('ai_tools');
            const req = mockRequest({
                merchantContext: {
                    id: 1,
                    subscriptionStatus: 'platform_owner',
                    features: []
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });

    describe('loadMerchantContext feature population', () => {
        // We need to require loadMerchantContext after db mock is set up
        let loadMerchantContext;

        beforeEach(() => {
            jest.clearAllMocks();
            // Re-require to get fresh module with mocked db
            loadMerchantContext = require('../../middleware/merchant').loadMerchantContext;
        });

        test('populates features array from DB for non-platform-owner', async () => {
            const merchantRow = {
                id: 5,
                square_merchant_id: 'sq_test',
                business_name: 'Test Store',
                business_email: 'test@test.com',
                subscription_status: 'active',
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

            const featuresRows = [
                { feature_key: 'cycle_counts' },
                { feature_key: 'reorder' }
            ];

            // First call: find primary merchant
            // Second call: load merchant details
            // Third call: load features
            db.query
                .mockResolvedValueOnce({ rows: [{ merchant_id: 5 }] })
                .mockResolvedValueOnce({ rows: [merchantRow] })
                .mockResolvedValueOnce({ rows: featuresRows });

            const req = {
                session: { user: { id: 1 } },
                merchantContext: null
            };
            const res = mockResponse();
            const next = jest.fn();

            await loadMerchantContext(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.merchantContext).not.toBeNull();
            expect(req.merchantContext.features).toEqual(['cycle_counts', 'reorder']);
        });

        test('sets empty features for platform_owner without querying DB', async () => {
            const merchantRow = {
                id: 1,
                square_merchant_id: 'sq_owner',
                business_name: 'Platform Owner Store',
                business_email: 'owner@test.com',
                subscription_status: 'platform_owner',
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
                .mockResolvedValueOnce({ rows: [{ merchant_id: 1 }] })
                .mockResolvedValueOnce({ rows: [merchantRow] });

            const req = {
                session: { user: { id: 1 } },
                merchantContext: null
            };
            const res = mockResponse();
            const next = jest.fn();

            await loadMerchantContext(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.merchantContext.features).toEqual([]);
            // Should only have 2 DB calls (no features query for platform_owner)
            expect(db.query).toHaveBeenCalledTimes(2);
        });
    });
});
