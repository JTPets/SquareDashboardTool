const express = require('express');
const router = express.Router();
const { configureLoginRateLimit } = require('../../middleware/security');
const { checkPublicPromo } = require('../../services/subscriptions/promo-validation');
const pricingService = require('../../services/pricing-service');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

const promoRateLimit = configureLoginRateLimit();

// GET /api/public/pricing
// Returns all module and plan prices from DB (source of truth).
// No hardcoded fallbacks — if DB unavailable, prices are "unavailable".
router.get('/public/pricing', asyncHandler(async (req, res) => {
    const [modulePricing, planPricing] = await Promise.all([
        pricingService.getAllModulePricing(),
        pricingService.getPlatformPlanPricing(),
    ]);

    const modules = modulePricing.map(m => ({
        key: m.key,
        name: m.name,
        description: m.description,
        price_cents: m.price_cents,
    }));

    const plans = planPricing.map(p => ({
        key: p.plan_key,
        name: p.name,
        price_cents: p.price_cents,
        billing_frequency: p.billing_frequency,
    }));

    sendSuccess(res, { modules, plans });
}));

router.get('/public/promo/check', promoRateLimit, asyncHandler(async (req, res) => {
    const code = (req.query.code || '').trim();
    if (!code) {
        return sendError(res, 'code is required', 400, 'MISSING_CODE');
    }
    const result = await checkPublicPromo(code);
    sendSuccess(res, result);
}));

module.exports = router;
