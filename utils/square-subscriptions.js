/**
 * Square Subscriptions Management
 *
 * Handles creation and management of subscription plans via Square's Catalog API
 * and enrollment of customers via Square's Subscriptions API.
 *
 * SECURITY: No credit card data is stored locally. All payment data is held by Square.
 * We only store Square IDs (customer_id, card_id, subscription_id, plan_variation_id).
 *
 * References:
 * - https://developer.squareup.com/docs/subscriptions-api/overview
 * - https://developer.squareup.com/docs/subscriptions-api/plans-and-variations
 * - https://developer.squareup.com/reference/square/subscriptions-api/create-subscription
 */

const logger = require('./logger');
const db = require('./database');
const { makeSquareRequest } = require('./square-api');

/**
 * Get the application's Square access token for subscription management
 * This uses the app's own credentials, not a merchant's OAuth token
 */
function getAppAccessToken() {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) {
        throw new Error('SQUARE_ACCESS_TOKEN not configured - required for subscription management');
    }
    return token;
}

/**
 * Create or update subscription plans in Square's Catalog
 * This should be run once during initial setup or when plans change
 *
 * @returns {Promise<Object>} Created/updated plan details
 */
async function setupSubscriptionPlans() {
    const accessToken = getAppAccessToken();
    const locationId = process.env.SQUARE_LOCATION_ID;

    if (!locationId) {
        throw new Error('SQUARE_LOCATION_ID not configured - required for subscriptions');
    }

    logger.info('Setting up Square subscription plans...');

    // Get our local plans
    const localPlans = await db.query('SELECT * FROM subscription_plans WHERE is_active = TRUE');

    const results = {
        plans: [],
        errors: []
    };

    for (const plan of localPlans.rows) {
        try {
            // Check if plan already exists in Square
            if (plan.square_plan_id) {
                // Verify it still exists in Square
                const existing = await makeSquareRequest(`/v2/catalog/object/${plan.square_plan_id}`, {
                    accessToken
                });
                if (existing.object) {
                    logger.info(`Plan ${plan.plan_key} already exists in Square`, {
                        squarePlanId: plan.square_plan_id
                    });
                    results.plans.push({
                        planKey: plan.plan_key,
                        squarePlanId: plan.square_plan_id,
                        status: 'existing'
                    });
                    continue;
                }
            }

            // Create the subscription plan in Square
            const planResult = await createSquarePlan(plan, accessToken);

            // Update local database with Square plan ID
            await db.query(`
                UPDATE subscription_plans
                SET square_plan_id = $1, updated_at = NOW()
                WHERE id = $2
            `, [planResult.planVariationId, plan.id]);

            results.plans.push({
                planKey: plan.plan_key,
                squarePlanId: planResult.planVariationId,
                squareBasePlanId: planResult.basePlanId,
                status: 'created'
            });

            logger.info(`Created Square subscription plan: ${plan.plan_key}`, planResult);

        } catch (error) {
            logger.error(`Failed to create Square plan: ${plan.plan_key}`, { error: error.message, stack: error.stack });
            results.errors.push({
                planKey: plan.plan_key,
                error: error.message
            });
        }
    }

    return results;
}

/**
 * Create a subscription plan and variation in Square's Catalog
 *
 * @param {Object} plan - Local plan data
 * @param {string} accessToken - Square access token
 * @returns {Promise<Object>} Created plan IDs
 */
async function createSquarePlan(plan, accessToken) {
    const idempotencyKey = `plan-${plan.plan_key}-${Date.now()}`;

    // Determine cadence based on billing frequency
    const cadence = plan.billing_frequency === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';

    // Create the base subscription plan
    const planResponse = await makeSquareRequest('/v2/catalog/object', {
        method: 'POST',
        accessToken,
        body: JSON.stringify({
            idempotency_key: `${idempotencyKey}-plan`,
            object: {
                type: 'SUBSCRIPTION_PLAN',
                id: `#${plan.plan_key}-plan`,
                subscription_plan_data: {
                    name: plan.name,
                    // This is a service subscription, not tied to catalog items
                    all_items: false
                }
            }
        })
    });

    if (!planResponse.catalog_object) {
        throw new Error('Failed to create subscription plan: ' + JSON.stringify(planResponse.errors));
    }

    const basePlanId = planResponse.catalog_object.id;

    // Create the plan variation with pricing
    const variationResponse = await makeSquareRequest('/v2/catalog/object', {
        method: 'POST',
        accessToken,
        body: JSON.stringify({
            idempotency_key: `${idempotencyKey}-variation`,
            object: {
                type: 'SUBSCRIPTION_PLAN_VARIATION',
                id: `#${plan.plan_key}-variation`,
                subscription_plan_variation_data: {
                    name: plan.name,
                    subscription_plan_id: basePlanId,
                    phases: [
                        {
                            cadence: cadence,
                            ordinal: 0,
                            // No periods limit = runs indefinitely
                            pricing: {
                                type: 'STATIC',
                                price_money: {
                                    amount: plan.price_cents,
                                    currency: 'CAD'
                                }
                            }
                        }
                    ]
                }
            }
        })
    });

    if (!variationResponse.catalog_object) {
        throw new Error('Failed to create plan variation: ' + JSON.stringify(variationResponse.errors));
    }

    return {
        basePlanId: basePlanId,
        planVariationId: variationResponse.catalog_object.id
    };
}

/**
 * Create a subscription for a customer
 *
 * SECURITY: We only pass IDs to Square - no card numbers or sensitive data
 * Square handles all payment processing and PCI compliance
 *
 * @param {Object} params - Subscription parameters
 * @param {string} params.customerId - Square customer ID
 * @param {string} params.cardId - Square card on file ID
 * @param {string} params.planVariationId - Square plan variation ID
 * @param {string} params.locationId - Square location ID
 * @param {string} [params.startDate] - Optional start date (YYYY-MM-DD). If omitted, starts immediately.
 * @param {string} [params.sourceName] - Application source name
 * @returns {Promise<Object>} Created subscription
 */
async function createSubscription({ customerId, cardId, planVariationId, locationId, startDate, sourceName = 'Square Dashboard Addon' }) {
    const accessToken = getAppAccessToken();

    if (!customerId || !planVariationId || !locationId) {
        throw new Error('customerId, planVariationId, and locationId are required');
    }

    const idempotencyKey = `sub-${customerId}-${Date.now()}`;

    const requestBody = {
        idempotency_key: idempotencyKey,
        location_id: locationId,
        plan_variation_id: planVariationId,
        customer_id: customerId,
        source: {
            name: sourceName
        }
    };

    // Only include card_id if provided - Square will email invoice if no card
    if (cardId) {
        requestBody.card_id = cardId;
    }

    // Set start date if provided (for deferred subscriptions like promo codes)
    if (startDate) {
        requestBody.start_date = startDate;
    }

    logger.info('Creating Square subscription', {
        customerId,
        planVariationId,
        locationId,
        hasCard: !!cardId,
        startDate: startDate || 'immediate'
    });

    const response = await makeSquareRequest('/v2/subscriptions', {
        method: 'POST',
        accessToken,
        body: JSON.stringify(requestBody)
    });

    if (response.errors) {
        const errorMsg = response.errors.map(e => e.detail || e.code).join(', ');
        throw new Error(`Failed to create subscription: ${errorMsg}`);
    }

    if (!response.subscription) {
        throw new Error('No subscription returned from Square');
    }

    logger.info('Square subscription created', {
        subscriptionId: response.subscription.id,
        status: response.subscription.status,
        customerId,
        startDate: response.subscription.start_date
    });

    return response.subscription;
}

/**
 * Get subscription details from Square
 *
 * @param {string} subscriptionId - Square subscription ID
 * @returns {Promise<Object>} Subscription details
 */
async function getSubscription(subscriptionId) {
    const accessToken = getAppAccessToken();

    const response = await makeSquareRequest(`/v2/subscriptions/${subscriptionId}`, {
        accessToken
    });

    if (response.errors) {
        throw new Error('Failed to get subscription: ' + response.errors[0].detail);
    }

    return response.subscription;
}

/**
 * Cancel a subscription
 *
 * @param {string} subscriptionId - Square subscription ID
 * @returns {Promise<Object>} Canceled subscription
 */
async function cancelSubscription(subscriptionId) {
    const accessToken = getAppAccessToken();

    logger.info('Canceling Square subscription', { subscriptionId });

    const response = await makeSquareRequest(`/v2/subscriptions/${subscriptionId}/cancel`, {
        method: 'POST',
        accessToken,
        body: JSON.stringify({})
    });

    if (response.errors) {
        throw new Error('Failed to cancel subscription: ' + response.errors[0].detail);
    }

    logger.info('Square subscription canceled', {
        subscriptionId,
        status: response.subscription?.status
    });

    return response.subscription;
}

/**
 * Pause a subscription
 *
 * @param {string} subscriptionId - Square subscription ID
 * @returns {Promise<Object>} Paused subscription
 */
async function pauseSubscription(subscriptionId) {
    const accessToken = getAppAccessToken();

    const response = await makeSquareRequest(`/v2/subscriptions/${subscriptionId}/pause`, {
        method: 'POST',
        accessToken,
        body: JSON.stringify({})
    });

    if (response.errors) {
        throw new Error('Failed to pause subscription: ' + response.errors[0].detail);
    }

    return response.subscription;
}

/**
 * Resume a paused subscription
 *
 * @param {string} subscriptionId - Square subscription ID
 * @returns {Promise<Object>} Resumed subscription
 */
async function resumeSubscription(subscriptionId) {
    const accessToken = getAppAccessToken();

    const response = await makeSquareRequest(`/v2/subscriptions/${subscriptionId}/resume`, {
        method: 'POST',
        accessToken,
        body: JSON.stringify({
            resume_effective_date: new Date().toISOString().split('T')[0] // Today
        })
    });

    if (response.errors) {
        throw new Error('Failed to resume subscription: ' + response.errors[0].detail);
    }

    return response.subscription;
}

/**
 * Get plan variation ID for a plan key
 *
 * @param {string} planKey - Plan key (e.g., 'monthly', 'annual')
 * @returns {Promise<string|null>} Square plan variation ID or null
 */
async function getPlanVariationId(planKey) {
    const result = await db.query(`
        SELECT square_plan_id FROM subscription_plans
        WHERE plan_key = $1 AND is_active = TRUE
    `, [planKey]);

    return result.rows[0]?.square_plan_id || null;
}

/**
 * List all subscription plans from local database with Square status
 *
 * @returns {Promise<Array>} List of plans
 */
async function listPlans() {
    const result = await db.query(`
        SELECT
            id, plan_key, name, description, price_cents,
            billing_frequency, square_plan_id, is_active, is_intro_pricing,
            created_at, updated_at
        FROM subscription_plans
        ORDER BY price_cents ASC
    `);

    return result.rows;
}

/**
 * Update subscription in Square when card on file changes
 *
 * @param {string} subscriptionId - Square subscription ID
 * @param {string} cardId - New card ID
 * @returns {Promise<Object>} Updated subscription
 */
async function updateSubscriptionCard(subscriptionId, cardId) {
    const accessToken = getAppAccessToken();

    // First get the current subscription to get version
    const current = await getSubscription(subscriptionId);

    const response = await makeSquareRequest(`/v2/subscriptions/${subscriptionId}`, {
        method: 'PUT',
        accessToken,
        body: JSON.stringify({
            subscription: {
                card_id: cardId,
                version: current.version
            }
        })
    });

    if (response.errors) {
        throw new Error('Failed to update subscription card: ' + response.errors[0].detail);
    }

    logger.info('Subscription card updated', { subscriptionId });

    return response.subscription;
}

module.exports = {
    setupSubscriptionPlans,
    createSubscription,
    getSubscription,
    cancelSubscription,
    pauseSubscription,
    resumeSubscription,
    getPlanVariationId,
    listPlans,
    updateSubscriptionCard,
    getAppAccessToken
};
