'use strict';

/**
 * Pricing Service
 *
 * Single source of truth for all platform pricing.
 * DB (module_pricing + subscription_plans) is authoritative.
 * feature-registry.js price_cents are seed defaults only — used on first boot
 * to populate module_pricing, never read directly in production paths.
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const featureRegistry = require('../config/feature-registry');

/**
 * Return all module prices from DB, keyed by module_key.
 * Falls back to registry defaults for any module not yet in DB.
 * @returns {Promise<Object>} map of moduleKey -> price_cents
 */
async function getModulePriceMap() {
    const result = await db.query('SELECT module_key, price_cents FROM module_pricing');
    const dbMap = {};
    for (const row of result.rows) {
        dbMap[row.module_key] = row.price_cents;
    }

    // Fill in any gaps with registry defaults (handles seeding lag)
    for (const mod of featureRegistry.getAllModules()) {
        if (!(mod.key in dbMap)) {
            dbMap[mod.key] = mod.price_cents;
        }
    }
    return dbMap;
}

/**
 * Return price in cents for a single module.
 * Falls back to registry default if not in DB.
 * @param {string} moduleKey
 * @returns {Promise<number>}
 */
async function getModulePrice(moduleKey) {
    const result = await db.query(
        'SELECT price_cents FROM module_pricing WHERE module_key = $1',
        [moduleKey]
    );
    if (result.rows.length > 0) return result.rows[0].price_cents;

    const mod = featureRegistry.modules[moduleKey];
    return mod ? mod.price_cents : null;
}

/**
 * Update a module price in DB.
 * @param {string} moduleKey
 * @param {number} priceCents
 */
async function updateModulePrice(moduleKey, priceCents) {
    await db.query(
        `INSERT INTO module_pricing (module_key, price_cents, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (module_key) DO UPDATE
         SET price_cents = EXCLUDED.price_cents, updated_at = NOW()`,
        [moduleKey, priceCents]
    );
    logger.info('Module price updated', { moduleKey, priceCents });
}

/**
 * Return all module pricing rows enriched with registry metadata.
 * @returns {Promise<Array>}
 */
async function getAllModulePricing() {
    const priceMap = await getModulePriceMap();
    return featureRegistry.getPaidModules().map(mod => ({
        key: mod.key,
        name: mod.name,
        description: mod.description || null,
        price_cents: priceMap[mod.key] ?? mod.price_cents,
        default_price_cents: mod.price_cents,
    }));
}

/**
 * Return all plan prices for the platform owner merchant.
 * @returns {Promise<Array>}
 */
async function getPlatformPlanPricing() {
    const ownerRow = await db.query(
        `SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1`
    );
    if (ownerRow.rows.length === 0) return getPlanPricingDefaults();

    const merchantId = ownerRow.rows[0].id;
    const result = await db.query(
        `SELECT plan_key, name, description, price_cents, billing_frequency, is_active
         FROM subscription_plans
         WHERE merchant_id = $1 AND is_active = TRUE
         ORDER BY price_cents ASC`,
        [merchantId]
    );
    if (result.rows.length > 0) return result.rows;

    return getPlanPricingDefaults();
}

/**
 * Return registry defaults for plans when no DB rows exist.
 * @returns {Array}
 */
function getPlanPricingDefaults() {
    return Object.values(featureRegistry.publicPlans).map(p => ({
        plan_key: p.key,
        name: p.name,
        description: null,
        price_cents: p.price_cents,
        billing_frequency: p.billing_frequency,
        is_active: true,
    }));
}

/**
 * Update a plan price for the platform owner merchant.
 * @param {string} planKey
 * @param {number} priceCents
 */
async function updatePlatformPlanPrice(planKey, priceCents) {
    const ownerRow = await db.query(
        `SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1`
    );
    if (ownerRow.rows.length === 0) {
        throw new Error('No platform owner merchant found');
    }
    const merchantId = ownerRow.rows[0].id;

    const result = await db.query(
        `UPDATE subscription_plans
         SET price_cents = $1, updated_at = NOW()
         WHERE merchant_id = $2 AND plan_key = $3
         RETURNING plan_key, price_cents`,
        [priceCents, merchantId, planKey]
    );
    if (result.rows.length === 0) {
        throw new Error(`Plan "${planKey}" not found for platform owner`);
    }
    logger.info('Platform plan price updated', { planKey, priceCents, merchantId });
    return result.rows[0];
}

/**
 * Seed module_pricing table from feature-registry defaults.
 * Uses INSERT ... ON CONFLICT DO NOTHING so existing admin overrides are preserved.
 */
async function seedModulePricing() {
    const paid = featureRegistry.getPaidModules();
    for (const mod of paid) {
        await db.query(
            `INSERT INTO module_pricing (module_key, price_cents, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (module_key) DO NOTHING`,
            [mod.key, mod.price_cents]
        );
    }
    logger.info('Module pricing seeded from feature-registry defaults', { count: paid.length });
}

module.exports = {
    getModulePriceMap,
    getModulePrice,
    updateModulePrice,
    getAllModulePricing,
    getPlatformPlanPricing,
    updatePlatformPlanPrice,
    seedModulePricing,
};
