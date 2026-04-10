'use strict';

const { requirePluginFeature } = require('../../src/plugins/featureGate');

// Mock response factory (matches project pattern)
function mockResponse() {
    const res = {
        statusCode: 200,
        jsonData: null,
        req: { requestId: 'test-req-123' }
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

function mockRequest(options = {}) {
    return {
        merchantContext: options.merchantContext || null,
        path: options.path || '/api/plugins/test'
    };
}

describe('Plugin Feature Gate', () => {

    describe('requirePluginFeature()', () => {

        test('returns 403 when no merchant context', () => {
            const middleware = requirePluginFeature('retail_automation');
            const req = mockRequest();
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.success).toBe(false);
        });

        test('platform owner bypasses all feature checks', () => {
            const middleware = requirePluginFeature('retail_automation');
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

        test('allows access when merchant has the feature', () => {
            const middleware = requirePluginFeature('retail_automation');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    subscriptionStatus: 'active',
                    features: ['retail_automation', 'other_feature']
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('returns 403 when merchant does not have the feature', () => {
            const middleware = requirePluginFeature('retail_automation');
            const req = mockRequest({
                merchantContext: {
                    id: 3,
                    subscriptionStatus: 'active',
                    features: ['other_feature']
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.success).toBe(false);
            expect(res.jsonData.error).toContain('retail_automation');
            expect(res.jsonData.code).toBe('PLUGIN_FEATURE_REQUIRED');
        });

        test('handles undefined features array', () => {
            const middleware = requirePluginFeature('some_feature');
            const req = mockRequest({
                merchantContext: {
                    id: 4,
                    subscriptionStatus: 'active'
                    // no features key
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('handles empty features array', () => {
            const middleware = requirePluginFeature('my_feature');
            const req = mockRequest({
                merchantContext: {
                    id: 5,
                    subscriptionStatus: 'active',
                    features: []
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('different feature names produce different middleware', () => {
            const mw1 = requirePluginFeature('feature_a');
            const mw2 = requirePluginFeature('feature_b');

            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    subscriptionStatus: 'active',
                    features: ['feature_a']
                }
            });

            const res1 = mockResponse();
            const next1 = jest.fn();
            mw1(req, res1, next1);
            expect(next1).toHaveBeenCalled();

            const res2 = mockResponse();
            const next2 = jest.fn();
            mw2(req, res2, next2);
            expect(next2).not.toHaveBeenCalled();
            expect(res2.status).toHaveBeenCalledWith(403);
        });

        test('error message includes the feature name', () => {
            const middleware = requirePluginFeature('special_plugin');
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

            expect(res.jsonData.error).toContain('special_plugin');
        });
    });
});
