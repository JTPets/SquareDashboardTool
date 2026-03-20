/**
 * Square Discount Catalog Service
 *
 * CRUD operations for Square catalog objects (DISCOUNT, PRODUCT_SET, PRICING_RULE)
 * used by loyalty rewards. Operates on Square catalog objects only — no orchestration.
 *
 * Extracted from square-discount-service.js — single responsibility: catalog CRUD.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken, generateIdempotencyKey, SQUARE_API_BASE, SQUARE_API_VERSION } = require('./shared-utils');
const { deleteCatalogObjects } = require('../../utils/square-catalog-cleanup');

// In-memory cache: merchantId -> currency code (persists for process lifetime)
// BACKLOG-9: Acceptable loss on PM2 restart — read-through cache rebuilds on first call per
// merchant. Currency rarely changes, so one extra Square API call after restart is negligible.
const merchantCurrencyCache = new Map();

/**
 * Fetch merchant's currency from Square Merchants API.
 * Caches result in-memory per merchantId. Falls back to 'CAD' on failure.
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {string} accessToken - Square access token
 * @returns {Promise<string>} ISO 4217 currency code
 */
async function getMerchantCurrency(merchantId, accessToken) {
    if (merchantCurrencyCache.has(merchantId)) {
        return merchantCurrencyCache.get(merchantId);
    }

    try {
        // Fetch square_merchant_id from DB to call Square Merchants API
        const result = await db.query(
            'SELECT square_merchant_id FROM merchants WHERE id = $1',
            [merchantId]
        );
        const squareMerchantId = result.rows[0]?.square_merchant_id;
        if (!squareMerchantId) {
            logger.warn('No square_merchant_id found, defaulting currency to CAD', { merchantId });
            merchantCurrencyCache.set(merchantId, 'CAD');
            return 'CAD';
        }

        const response = await fetchWithTimeout(
            `${SQUARE_API_BASE}/merchants/${squareMerchantId}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                }
            },
            10000
        );

        if (!response.ok) {
            logger.warn('Failed to fetch merchant currency from Square, defaulting to CAD', {
                merchantId, status: response.status
            });
            merchantCurrencyCache.set(merchantId, 'CAD');
            return 'CAD';
        }

        const data = await response.json();
        const currency = data.merchant?.currency || 'CAD';
        merchantCurrencyCache.set(merchantId, currency);
        logger.info('Cached merchant currency from Square', { merchantId, currency });
        return currency;
    } catch (error) {
        logger.warn('Error fetching merchant currency, defaulting to CAD', {
            merchantId, error: error.message
        });
        merchantCurrencyCache.set(merchantId, 'CAD');
        return 'CAD';
    }
}

/**
 * Create a Discount + Pricing Rule in Square for a reward
 * This creates a FIXED_PERCENTAGE (100%) discount that auto-applies to exactly
 * ONE qualifying item when a customer in the group checks out.
 *
 * Uses apply_products_id on the pricing rule to limit discount to a single item.
 * Square docs: "An apply rule can only match once in the match set."
 * Also includes maximum_amount_money as a per-item safety cap.
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {number} params.internalRewardId - Our internal reward ID
 * @param {string} params.groupId - Square customer group ID
 * @param {string} params.offerName - Name of the offer for display
 * @param {Array<string>} params.variationIds - Square variation IDs this discount applies to
 * @param {number} params.maxDiscountAmountCents - Per-item safety cap in cents (from purchase history)
 * @returns {Promise<Object>} Result with discount and pricing rule IDs
 */
async function createRewardDiscount({ merchantId, internalRewardId, groupId, offerName, variationIds, maxDiscountAmountCents }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const currency = await getMerchantCurrency(merchantId, accessToken);

        // Generate unique IDs for our catalog objects
        const discountId = `#loyalty-discount-${internalRewardId}`;
        const productSetId = `#loyalty-productset-${internalRewardId}`;
        const pricingRuleId = `#loyalty-pricingrule-${internalRewardId}`;

        // Build catalog objects for batch upsert:
        // 1. DISCOUNT - 100% off, with maximum_amount_money as per-item safety cap
        // 2. PRODUCT_SET - defines which variations qualify
        // 3. PRICING_RULE - links discount to product set; apply_products_id limits to 1 item
        const catalogObjects = [
            {
                type: 'DISCOUNT',
                id: discountId,
                discount_data: {
                    name: `Loyalty: ${offerName} (Reward ${internalRewardId})`,
                    discount_type: 'FIXED_PERCENTAGE',
                    percentage: '100',
                    // Safety cap: limits per-item discount if apply_products_id somehow fails
                    maximum_amount_money: {
                        amount: maxDiscountAmountCents,
                        currency: currency
                    },
                    modify_tax_basis: 'MODIFY_TAX_BASIS'
                }
            },
            {
                type: 'PRODUCT_SET',
                id: productSetId,
                product_set_data: {
                    name: `Loyalty Products: ${offerName}`,
                    product_ids_any: variationIds,
                    quantity_exact: 1
                }
            },
            {
                type: 'PRICING_RULE',
                id: pricingRuleId,
                pricing_rule_data: {
                    name: `Loyalty Rule: ${offerName}`,
                    discount_id: discountId,
                    match_products_id: productSetId,
                    apply_products_id: productSetId,
                    customer_group_ids_any: [groupId],
                    time_period_ids: []
                }
            }
        ];

        const upsertStart = Date.now();
        const response = await fetchWithTimeout('https://connect.squareup.com/v2/catalog/batch-upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': SQUARE_API_VERSION
            },
            body: JSON.stringify({
                idempotency_key: generateIdempotencyKey(`loyalty-discount-batch-${internalRewardId}`),
                batches: [{
                    objects: catalogObjects
                }]
            })
        }, 10000);
        const upsertDuration = Date.now() - upsertStart;

        loyaltyLogger.squareApi({
            endpoint: '/catalog/batch-upsert',
            method: 'POST',
            status: response.status,
            duration: upsertDuration,
            success: response.ok,
            merchantId,
            context: 'createRewardDiscount',
        });

        if (!response.ok) {
            const errorData = await response.json();
            logger.error('Failed to create discount catalog objects', {
                merchantId,
                internalRewardId,
                error: errorData
            });
            return { success: false, error: `Square API error: ${JSON.stringify(errorData)}` };
        }

        const data = await response.json();

        // Extract the real Square IDs from the response
        const idMappings = data.id_mappings || [];
        const realDiscountId = idMappings.find(m => m.client_object_id === discountId)?.object_id;
        const realProductSetId = idMappings.find(m => m.client_object_id === productSetId)?.object_id;
        const realPricingRuleId = idMappings.find(m => m.client_object_id === pricingRuleId)?.object_id;

        if (!realDiscountId || !realProductSetId || !realPricingRuleId) {
            logger.error('Missing ID mappings in batch upsert response', {
                merchantId,
                internalRewardId,
                idMappings
            });
            return { success: false, error: 'Missing ID mappings in response' };
        }

        logger.info('Created discount catalog objects for reward', {
            merchantId,
            internalRewardId,
            discountId: realDiscountId,
            productSetId: realProductSetId,
            pricingRuleId: realPricingRuleId
        });

        return {
            success: true,
            discountId: realDiscountId,
            productSetId: realProductSetId,
            pricingRuleId: realPricingRuleId
        };

    } catch (error) {
        logger.error('Error creating discount catalog objects', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Delete discount catalog objects from Square
 * Used for cleanup when a reward is redeemed or expired
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {Array<string>} params.objectIds - Square catalog object IDs to delete
 * @returns {Promise<Object>} Result
 */
async function deleteRewardDiscountObjects({ merchantId, objectIds }) {
    const result = await deleteCatalogObjects(merchantId, objectIds, {
        auditContext: 'loyalty-reward-cleanup',
    });
    return {
        success: result.success,
        deleted: result.deleted.length,
        errors: result.errors.length > 0 ? result.errors : undefined,
    };
}

/**
 * Update the maximum_amount_money on a Square DISCOUNT catalog object.
 * Used when the current catalog price exceeds the discount cap set at earn time.
 *
 * Fetches the existing object (to get its version), then upserts with the new amount.
 *
 * @param {Object} params
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareDiscountId - Square catalog DISCOUNT object ID
 * @param {number} params.newAmountCents - New maximum_amount_money in cents
 * @param {string} params.rewardId - Internal reward ID (for logging/DB update)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateRewardDiscountAmount({ merchantId, squareDiscountId, newAmountCents, rewardId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        // Step 1: Fetch existing discount object to get its version and current data
        const getResponse = await fetchWithTimeout(
            `https://connect.squareup.com/v2/catalog/object/${squareDiscountId}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                }
            },
            10000
        );

        if (!getResponse.ok) {
            const errText = await getResponse.text();
            logger.error('Failed to fetch discount object for price update', {
                merchantId, squareDiscountId, rewardId, status: getResponse.status, error: errText
            });
            return { success: false, error: `Square API error: ${getResponse.status}` };
        }

        const catalogData = await getResponse.json();
        const discountObj = catalogData.object;

        if (!discountObj || discountObj.is_deleted) {
            return { success: false, error: 'Discount object not found or deleted' };
        }

        // Step 2: Upsert with updated maximum_amount_money
        const currency = discountObj.discount_data?.maximum_amount_money?.currency
            || await getMerchantCurrency(merchantId, accessToken);
        const updatedObject = {
            type: 'DISCOUNT',
            id: squareDiscountId,
            version: discountObj.version,
            discount_data: {
                ...discountObj.discount_data,
                maximum_amount_money: {
                    amount: newAmountCents,
                    currency: currency
                }
            }
        };

        const upsertResponse = await fetchWithTimeout('https://connect.squareup.com/v2/catalog/batch-upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': SQUARE_API_VERSION
            },
            body: JSON.stringify({
                idempotency_key: generateIdempotencyKey(`loyalty-discount-price-update-${rewardId}-${newAmountCents}`),
                batches: [{ objects: [updatedObject] }]
            })
        }, 10000);

        loyaltyLogger.squareApi({
            endpoint: '/catalog/batch-upsert',
            method: 'POST',
            status: upsertResponse.status,
            success: upsertResponse.ok,
            merchantId,
            context: 'updateRewardDiscountAmount',
        });

        if (!upsertResponse.ok) {
            const errorData = await upsertResponse.json();
            logger.error('Failed to update discount amount in Square', {
                merchantId, squareDiscountId, rewardId, newAmountCents, error: errorData
            });
            return { success: false, error: `Square API error: ${JSON.stringify(errorData)}` };
        }

        // Step 3: Update local record
        await db.query(`
            UPDATE loyalty_rewards SET
                discount_amount_cents = $1,
                updated_at = NOW()
            WHERE id = $2 AND merchant_id = $3
        `, [newAmountCents, rewardId, merchantId]);

        logger.info('Updated reward discount amount in Square', {
            merchantId, rewardId, squareDiscountId,
            newAmountCents,
            newAmountFormatted: `$${(newAmountCents / 100).toFixed(2)}`
        });

        return { success: true };

    } catch (error) {
        logger.error('Error updating reward discount amount', {
            error: error.message, stack: error.stack, merchantId, rewardId
        });
        return { success: false, error: error.message };
    }
}

module.exports = {
    createRewardDiscount,
    deleteRewardDiscountObjects,
    updateRewardDiscountAmount,
    getMerchantCurrency,
    _merchantCurrencyCache: merchantCurrencyCache
};
