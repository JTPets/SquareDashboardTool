/**
 * Square Customer Group Discount Service — Orchestration Layer
 *
 * Orchestrates the creation and cleanup of Square Customer Group Discounts
 * for loyalty rewards. Coordinates between customer group, catalog, and
 * customer note operations.
 *
 * Also contains getSquareLoyaltyProgram (Square program query) and
 * updateCustomerRewardNote (customer note management).
 *
 * Originally a 1,465-line monolith, split into:
 *   - square-customer-group-service.js  (group CRUD)
 *   - square-discount-catalog-service.js (catalog CRUD)
 *   - discount-validation-service.js     (validation & sync)
 *   - square-discount-service.js         (this file — orchestration + notes)
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION } = require('./shared-utils'); // LOGIC CHANGE: use centralized Square API version from constants (CRIT-5)
const { getCustomerDetails } = require('./customer-admin-service');
const { deleteCatalogObjects, deleteCustomerGroupWithMembers } = require('../../utils/square-catalog-cleanup');

const {
    createRewardCustomerGroup,
    addCustomerToGroup,
    removeCustomerFromGroup,
    deleteCustomerGroup
} = require('./square-customer-group-service');

const { createRewardDiscount } = require('./square-discount-catalog-service');

/**
 * Get Square Loyalty Program for a merchant
 * Returns the Square Loyalty program configuration including reward tiers
 *
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Square Loyalty program object or null if not set up
 */
async function getSquareLoyaltyProgram(merchantId) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            logger.warn('No access token for merchant when fetching loyalty program', { merchantId });
            return null;
        }

        const loyaltyProgramStart = Date.now();
        const response = await fetchWithTimeout('https://connect.squareup.com/v2/loyalty/programs/main', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': SQUARE_API_VERSION
            }
        }, 10000); // 10 second timeout
        const loyaltyProgramDuration = Date.now() - loyaltyProgramStart;

        loyaltyLogger.squareApi({
            endpoint: '/loyalty/programs/main',
            method: 'GET',
            status: response.status,
            duration: loyaltyProgramDuration,
            success: response.ok || response.status === 404,
            merchantId,
            context: 'getSquareLoyaltyProgram',
        });

        if (response.status === 404) {
            // No loyalty program configured
            logger.info('No Square Loyalty program found for merchant', { merchantId });
            return null;
        }

        if (!response.ok) {
            const errText = await response.text();
            logger.error('Error fetching Square Loyalty program', {
                status: response.status,
                error: errText,
                merchantId
            });
            return null;
        }

        const data = await response.json();
        return data.program || null;

    } catch (error) {
        logger.error('Error fetching Square Loyalty program', {
            error: error.message,
            stack: error.stack,
            merchantId
        });
        return null;
    }
}

/**
 * Create a Square Customer Group Discount for an earned reward
 * This is the main entry point - orchestrates group creation, customer assignment, and discount creation.
 * Once created, the discount will auto-apply at Square POS.
 *
 * Discount is 100% off ONE item, enforced by apply_products_id on the pricing rule.
 * Safety cap (maximum_amount_money) calculated from purchase history:
 * - Primary: MAX(unit_price_cents) from purchases linked to this specific reward
 * - Fallback: MAX(unit_price_cents) from any qualifying purchase for this offer
 * - Fail-safe: refuses to create discount if no price data exists ($0)
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.internalRewardId - Our internal reward ID
 * @param {number} params.offerId - Our internal offer ID
 * @returns {Promise<Object>} Result with Square object IDs if successful
 */
async function createSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId, offerId }) {
    try {
        // Get offer details
        const offerResult = await db.query(`
            SELECT o.*, array_agg(qv.variation_id) as variation_ids
            FROM loyalty_offers o
            LEFT JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id AND qv.is_active = TRUE
            WHERE o.id = $1 AND o.merchant_id = $2
            GROUP BY o.id
        `, [offerId, merchantId]);

        if (offerResult.rows.length === 0) {
            return { success: false, error: 'Offer not found' };
        }

        const offer = offerResult.rows[0];
        const variationIds = (offer.variation_ids || []).filter(v => v != null);

        if (variationIds.length === 0) {
            return {
                success: false,
                error: 'No qualifying variations configured for this offer'
            };
        }

        // Get customer name for group naming (optional)
        const customerDetails = await getCustomerDetails(squareCustomerId, merchantId);
        const customerName = customerDetails?.displayName || squareCustomerId.substring(0, 8);

        // Step 1: Create customer group
        const groupResult = await createRewardCustomerGroup({
            merchantId,
            internalRewardId,
            offerName: offer.offer_name,
            customerName
        });

        if (!groupResult.success) {
            return groupResult;
        }

        // Step 2: Add customer to group
        const addResult = await addCustomerToGroup({
            merchantId,
            squareCustomerId,
            groupId: groupResult.groupId
        });

        if (!addResult.success) {
            // Cleanup: delete the group we just created
            await deleteCustomerGroup({ merchantId, groupId: groupResult.groupId });
            return addResult;
        }

        // Step 3: Calculate max discount from purchase history AND current catalog price.
        // Uses the GREATER of:
        //   a) highest unit price from purchases linked to this reward (or any for this offer)
        //   b) highest current catalog price among qualifying variations
        // This ensures the discount cap always covers the current retail price,
        // even if prices increased since the customer's qualifying purchases.
        const priceResult = await db.query(`
            SELECT
                COALESCE(
                    (SELECT MAX(unit_price_cents) FROM loyalty_purchase_events
                     WHERE reward_id = $1 AND merchant_id = $2 AND unit_price_cents > 0),
                    (SELECT MAX(unit_price_cents) FROM loyalty_purchase_events
                     WHERE offer_id = $3 AND merchant_id = $2 AND unit_price_cents > 0),
                    0
                ) as max_purchase_price_cents,
                COALESCE(
                    (SELECT MAX(v.price_money) FROM variations v
                     INNER JOIN loyalty_qualifying_variations qv
                         ON v.id = qv.variation_id AND qv.is_active = TRUE
                     WHERE qv.offer_id = $3 AND qv.merchant_id = $2
                       AND v.merchant_id = $2 AND v.price_money > 0),
                    0
                ) as max_catalog_price_cents
        `, [internalRewardId, merchantId, offerId]);

        const maxPurchasePrice = parseInt(priceResult.rows[0].max_purchase_price_cents, 10) || 0;
        const maxCatalogPrice = parseInt(priceResult.rows[0].max_catalog_price_cents, 10) || 0;
        const maxDiscountAmountCents = Math.max(maxPurchasePrice, maxCatalogPrice);

        if (maxDiscountAmountCents <= 0) {
            logger.error('Cannot determine discount amount for reward - no purchase or catalog price data', {
                merchantId, internalRewardId, offerId
            });
            // Cleanup group since we can't create the discount
            await removeCustomerFromGroup({ merchantId, squareCustomerId, groupId: groupResult.groupId });
            await deleteCustomerGroup({ merchantId, groupId: groupResult.groupId });
            return {
                success: false,
                error: 'Cannot determine discount amount - no purchase or catalog price data available'
            };
        }

        logger.info('Calculated max discount amount for reward', {
            merchantId, internalRewardId, offerId,
            maxPurchasePrice,
            maxCatalogPrice,
            maxDiscountAmountCents,
            maxDiscountFormatted: `$${(maxDiscountAmountCents / 100).toFixed(2)}`
        });

        // Step 4: Create discount + pricing rule
        const discountResult = await createRewardDiscount({
            merchantId,
            internalRewardId,
            groupId: groupResult.groupId,
            offerName: offer.offer_name,
            variationIds,
            maxDiscountAmountCents
        });

        if (!discountResult.success) {
            // Cleanup: remove customer from group and delete group
            await removeCustomerFromGroup({ merchantId, squareCustomerId, groupId: groupResult.groupId });
            await deleteCustomerGroup({ merchantId, groupId: groupResult.groupId });
            return discountResult;
        }

        // Step 5: Store Square object IDs and discount cap in our reward record
        await db.query(`
            UPDATE loyalty_rewards SET
                square_group_id = $1,
                square_discount_id = $2,
                square_product_set_id = $3,
                square_pricing_rule_id = $4,
                discount_amount_cents = $5,
                square_pos_synced_at = NOW(),
                updated_at = NOW()
            WHERE id = $6 AND merchant_id = $7
        `, [
            groupResult.groupId,
            discountResult.discountId,
            discountResult.productSetId,
            discountResult.pricingRuleId,
            maxDiscountAmountCents,
            internalRewardId,
            merchantId
        ]);

        // Step 6: Add reward notification to customer note (non-blocking)
        await updateCustomerRewardNote({
            operation: 'add',
            merchantId,
            squareCustomerId,
            offerName: offer.offer_name
        });

        logger.info('Created Square Customer Group Discount for reward', {
            merchantId,
            internalRewardId,
            squareCustomerId,
            groupId: groupResult.groupId,
            discountId: discountResult.discountId,
            pricingRuleId: discountResult.pricingRuleId
        });

        return {
            success: true,
            groupId: groupResult.groupId,
            discountId: discountResult.discountId,
            productSetId: discountResult.productSetId,
            pricingRuleId: discountResult.pricingRuleId
        };

    } catch (error) {
        logger.error('Error creating Square Customer Group Discount', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Cleanup Square Customer Group Discount after a reward is redeemed
 * Removes the customer from the group and deletes the discount/pricing rule
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.internalRewardId - Our internal reward ID
 * @returns {Promise<Object>} Result
 */
async function cleanupSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId }) {
    try {
        // Get the Square object IDs and offer name from our reward record
        const rewardResult = await db.query(`
            SELECT r.square_group_id, r.square_discount_id, r.square_product_set_id,
                   r.square_pricing_rule_id, r.offer_id, o.offer_name
            FROM loyalty_rewards r
            LEFT JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.id = $1 AND r.merchant_id = $2
        `, [internalRewardId, merchantId]);

        if (rewardResult.rows.length === 0) {
            return { success: false, error: 'Reward not found' };
        }

        const reward = rewardResult.rows[0];
        const cleanupResults = {
            customerRemoved: false,
            groupDeleted: false,
            discountsDeleted: false
        };

        // Step 1+3: Remove customer from group, then delete the group
        if (reward.square_group_id) {
            const customerIds = squareCustomerId ? [squareCustomerId] : [];
            const groupResult = await deleteCustomerGroupWithMembers(
                merchantId,
                reward.square_group_id,
                customerIds
            );
            cleanupResults.customerRemoved = groupResult.customersRemoved;
            cleanupResults.groupDeleted = groupResult.groupDeleted;
        }

        // Step 2: Delete catalog objects (discount, product set, pricing rule) in one batch
        const objectsToDelete = [
            reward.square_pricing_rule_id,
            reward.square_product_set_id,
            reward.square_discount_id
        ];

        const catalogResult = await deleteCatalogObjects(merchantId, objectsToDelete, {
            auditContext: 'loyalty-reward-cleanup',
        });
        cleanupResults.discountsDeleted = catalogResult.success;

        // Step 4: Clear the Square IDs from our record
        await db.query(`
            UPDATE loyalty_rewards SET
                square_group_id = NULL,
                square_discount_id = NULL,
                square_product_set_id = NULL,
                square_pricing_rule_id = NULL,
                updated_at = NOW()
            WHERE id = $1 AND merchant_id = $2
        `, [internalRewardId, merchantId]);

        // Step 5: Remove reward notification from customer note (non-blocking)
        if (reward.offer_name && squareCustomerId) {
            await updateCustomerRewardNote({
                operation: 'remove',
                merchantId,
                squareCustomerId,
                offerName: reward.offer_name
            });
        }

        logger.info('Cleaned up Square Customer Group Discount', {
            merchantId,
            internalRewardId,
            ...cleanupResults
        });

        return {
            success: true,
            ...cleanupResults
        };

    } catch (error) {
        logger.error('Error cleaning up Square Customer Group Discount', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Update customer note in Square to add/remove reward notification lines.
 * Uses tagged format `🎁 REWARD: {text}` to manage reward lines without
 * destroying other note content (delivery notes, etc).
 *
 * @param {Object} params
 * @param {'add'|'remove'} params.operation - Add or remove a reward line
 * @param {number} params.merchantId
 * @param {string} params.squareCustomerId
 * @param {string} params.offerName - Used in the tag: "🎁 REWARD: Free {offerName}"
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateCustomerRewardNote({ operation, merchantId, squareCustomerId, offerName }) {
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const accessToken = await getSquareAccessToken(merchantId);
            if (!accessToken) {
                logger.warn('No access token for reward note update', { merchantId, operation });
                return { success: false, error: 'No access token available' };
            }

            const rewardLine = `🎁 REWARD: Free ${offerName}`;

            // Step 1: GET current customer to read note and version
            const getStart = Date.now();
            const getResponse = await fetchWithTimeout(
                `https://connect.squareup.com/v2/customers/${squareCustomerId}`,
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
            const getDuration = Date.now() - getStart;

            loyaltyLogger.squareApi({
                endpoint: `/customers/${squareCustomerId}`,
                method: 'GET',
                status: getResponse.status,
                duration: getDuration,
                success: getResponse.ok,
                merchantId,
                context: 'updateCustomerRewardNote',
            });

            if (!getResponse.ok) {
                const errText = await getResponse.text();
                logger.error('Failed to fetch customer for reward note', {
                    merchantId, squareCustomerId, operation, status: getResponse.status, error: errText
                });
                return { success: false, error: `Square API error: ${getResponse.status}` };
            }

            const customerData = await getResponse.json();
            const customer = customerData.customer;
            const currentNote = customer.note || '';
            const version = customer.version;

            // Step 2: Build updated note
            let updatedNote;

            if (operation === 'add') {
                // Check if line already exists (idempotent)
                const lines = currentNote.split('\n');
                if (lines.some(line => line.trim() === rewardLine)) {
                    logger.info('Reward note already exists, skipping', {
                        merchantId, squareCustomerId, offerName
                    });
                    return { success: true };
                }
                // Append reward line
                updatedNote = currentNote ? `${currentNote}\n${rewardLine}` : rewardLine;
            } else if (operation === 'remove') {
                // Strip matching line(s)
                const lines = currentNote.split('\n');
                const filtered = lines.filter(line => line.trim() !== rewardLine);
                if (filtered.length === lines.length) {
                    logger.info('Reward note not found, skipping removal', {
                        merchantId, squareCustomerId, offerName
                    });
                    return { success: true };
                }
                // Clean up extra blank lines
                updatedNote = filtered
                    .join('\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
            } else {
                return { success: false, error: `Invalid operation: ${operation}` };
            }

            // Step 3: PUT update with version for optimistic concurrency
            const putStart = Date.now();
            const putResponse = await fetchWithTimeout(
                `https://connect.squareup.com/v2/customers/${squareCustomerId}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': SQUARE_API_VERSION
                    },
                    body: JSON.stringify({
                        note: updatedNote,
                        version
                    })
                },
                10000
            );
            const putDuration = Date.now() - putStart;

            loyaltyLogger.squareApi({
                endpoint: `/customers/${squareCustomerId}`,
                method: 'PUT',
                status: putResponse.status,
                duration: putDuration,
                success: putResponse.ok,
                merchantId,
                context: 'updateCustomerRewardNote',
            });

            if (putResponse.status === 409 && attempt < MAX_RETRIES) {
                logger.warn('Customer note version conflict (409), retrying', {
                    merchantId, squareCustomerId, operation, attempt: attempt + 1
                });
                continue;
            }

            if (!putResponse.ok) {
                const errText = await putResponse.text();
                logger.error('Failed to update customer reward note', {
                    merchantId, squareCustomerId, operation, status: putResponse.status, error: errText
                });
                return { success: false, error: `Square API error: ${putResponse.status}` };
            }

            logger.info('Updated customer reward note', {
                merchantId, squareCustomerId, operation, offerName
            });

            return { success: true };

        } catch (error) {
            logger.error('Error updating customer reward note', {
                error: error.message, stack: error.stack, merchantId, squareCustomerId, operation, offerName
            });
            return { success: false, error: error.message };
        }
    }

    return { success: false, error: 'Max retries exceeded for version conflict' };
}

module.exports = {
    getSquareLoyaltyProgram,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    updateCustomerRewardNote
};
