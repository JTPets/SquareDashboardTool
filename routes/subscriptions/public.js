const express = require('express');
const router = express.Router();
const featureRegistry = require('../../config/feature-registry');
const { configureLoginRateLimit } = require('../../middleware/security');
const { checkPublicPromo } = require('../../services/subscriptions/promo-validation');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

const promoRateLimit = configureLoginRateLimit();

router.get('/public/pricing', (req, res) => {
    const modules = featureRegistry.getPaidModules().map(m => ({
        key: m.key,
        name: m.name,
        price_cents: m.price_cents,
    }));
    const bundles = Object.values(featureRegistry.bundles).map(b => ({
        key: b.key,
        name: b.name,
        includes: b.includes,
        price_cents: b.price_cents,
    }));
    sendSuccess(res, { modules, bundles });
});

router.get('/public/promo/check', promoRateLimit, asyncHandler(async (req, res) => {
    const code = (req.query.code || '').trim();
    if (!code) {
        return sendError(res, 'code is required', 400, 'MISSING_CODE');
    }
    const result = await checkPublicPromo(code);
    sendSuccess(res, result);
}));

module.exports = router;
