/**
 * Square Customer Group Discount Service
 *
 * Manages Square Customer Group Discounts for loyalty rewards:
 * - Create/delete customer groups for rewards
 * - Create/delete discounts and pricing rules
 * - Validate discount objects exist in Square
 * - Detect reward redemption from orders
 *
 * When a customer earns a reward in our system, we create a Customer Group Discount
 * that auto-applies at Square POS when the customer is identified at checkout.
 * This replaces the old Loyalty API approach which required points.
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken, generateIdempotencyKey } = require('./shared-utils');
const { getCustomerDetails } = require('./customer-admin-service');
const { deleteCatalogObjects, deleteCustomerGroupWithMembers } = require('../../utils/square-catalog-cleanup');

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
                'Square-Version': '2025-01-16'
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
 * Create a Customer Group in Square for a specific reward
 * Each reward gets its own group so we can track/remove individually
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.internalRewardId - Our internal reward ID
 * @param {string} params.offerName - Name of the offer for display
 * @param {string} params.customerName - Customer name for group naming
 * @returns {Promise<Object>} Result with group ID if successful
 */
async function createRewardCustomerGroup({ merchantId, internalRewardId, offerName, customerName }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const groupName = `Loyalty Reward ${internalRewardId} - ${offerName} - ${customerName}`.substring(0, 255);

        const createGroupStart = Date.now();
        const response = await fetch('https://connect.squareup.com/v2/customers/groups', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify({
                idempotency_key: `loyalty-reward-group-${internalRewardId}`,
                group: {
                    name: groupName
                }
            })
        });
        const createGroupDuration = Date.now() - createGroupStart;

        loyaltyLogger.squareApi({
            endpoint: '/customers/groups',
            method: 'POST',
            status: response.status,
            duration: createGroupDuration,
            success: response.ok,
            merchantId,
            context: 'createRewardCustomerGroup',
        });

        if (!response.ok) {
            const errorData = await response.json();
            logger.error('Failed to create customer group', {
                merchantId,
                internalRewardId,
                error: errorData,
                status: response.status
            });
            return { success: false, error: `Square API error: ${JSON.stringify(errorData)}` };
        }

        const data = await response.json();
        const groupId = data.group?.id;

        if (!groupId) {
            return { success: false, error: 'No group ID returned from Square' };
        }

        logger.info('Created customer group for reward', {
            merchantId,
            internalRewardId,
            groupId,
            groupName
        });

        return { success: true, groupId };

    } catch (error) {
        logger.error('Error creating customer group', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Add a customer to a Square Customer Group
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {string} params.groupId - Square group ID
 * @returns {Promise<Object>} Result
 */
async function addCustomerToGroup({ merchantId, squareCustomerId, groupId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const addToGroupStart = Date.now();
        const response = await fetch(
            `https://connect.squareup.com/v2/customers/${squareCustomerId}/groups/${groupId}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                }
            }
        );
        const addToGroupDuration = Date.now() - addToGroupStart;

        loyaltyLogger.squareApi({
            endpoint: `/customers/${squareCustomerId}/groups/${groupId}`,
            method: 'PUT',
            status: response.status,
            duration: addToGroupDuration,
            success: response.ok,
            merchantId,
            context: 'addCustomerToGroup',
        });

        if (!response.ok) {
            const errorData = await response.json();
            logger.error('Failed to add customer to group', {
                merchantId,
                squareCustomerId,
                groupId,
                error: errorData
            });
            return { success: false, error: `Square API error: ${JSON.stringify(errorData)}` };
        }

        logger.info('Added customer to group', {
            merchantId,
            squareCustomerId,
            groupId
        });

        return { success: true };

    } catch (error) {
        logger.error('Error adding customer to group', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Remove a customer from a Square Customer Group
 *
 * Uses makeSquareRequest directly (not deleteCustomerGroupWithMembers) because
 * this needs to remove membership WITHOUT deleting the group — used in error
 * cleanup paths where the group may still be needed. For the combined
 * remove-members-then-delete-group operation, see deleteCustomerGroupWithMembers
 * in utils/square-catalog-cleanup.js.
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {string} params.groupId - Square group ID
 * @returns {Promise<Object>} Result
 */
async function removeCustomerFromGroup({ merchantId, squareCustomerId, groupId }) {
    try {
        const api = require('./shared-utils').getSquareApi();
        const accessToken = await api.getMerchantToken(merchantId);
        await api.makeSquareRequest(
            `/v2/customers/${squareCustomerId}/groups/${groupId}`,
            { method: 'DELETE', accessToken }
        );
        logger.info('Removed customer from group', { merchantId, squareCustomerId, groupId });
        return { success: true };
    } catch (error) {
        if (error.message && error.message.includes('404')) {
            return { success: true }; // Already removed
        }
        logger.error('Failed to remove customer from group', {
            merchantId, squareCustomerId, groupId, error: error.message,
        });
        return { success: false, error: error.message };
    }
}

/**
 * Delete a Customer Group from Square
 *
 * Uses makeSquareRequest directly (not deleteCustomerGroupWithMembers) because
 * this needs to delete the group WITHOUT removing members first — used in error
 * cleanup paths where the customer was never added. For the combined
 * remove-members-then-delete-group operation, see deleteCustomerGroupWithMembers
 * in utils/square-catalog-cleanup.js.
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.groupId - Square group ID
 * @returns {Promise<Object>} Result
 */
async function deleteCustomerGroup({ merchantId, groupId }) {
    try {
        const api = require('./shared-utils').getSquareApi();
        const accessToken = await api.getMerchantToken(merchantId);
        await api.makeSquareRequest(
            `/v2/customers/groups/${groupId}`,
            { method: 'DELETE', accessToken }
        );
        logger.info('Deleted customer group', { merchantId, groupId });
        return { success: true };
    } catch (error) {
        if (error.message && error.message.includes('404')) {
            return { success: true }; // Already deleted
        }
        logger.error('Failed to delete customer group', {
            merchantId, groupId, error: error.message,
        });
        return { success: false, error: error.message };
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
                    // TODO: BACKLOG - currency hardcoded to CAD; for multi-tenant SaaS, pull from merchant config
                    maximum_amount_money: {
                        amount: maxDiscountAmountCents,
                        currency: 'CAD'
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
        const response = await fetch('https://connect.squareup.com/v2/catalog/batch-upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify({
                idempotency_key: generateIdempotencyKey(`loyalty-discount-batch-${internalRewardId}`),
                batches: [{
                    objects: catalogObjects
                }]
            })
        });
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
                         ON v.square_variation_id = qv.variation_id AND qv.is_active = TRUE
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
            WHERE id = $6
        `, [
            groupResult.groupId,
            discountResult.discountId,
            discountResult.productSetId,
            discountResult.pricingRuleId,
            maxDiscountAmountCents,
            internalRewardId
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
            WHERE id = $1
        `, [internalRewardId]);

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
                    'Square-Version': '2025-01-16'
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
        const updatedObject = {
            type: 'DISCOUNT',
            id: squareDiscountId,
            version: discountObj.version,
            discount_data: {
                ...discountObj.discount_data,
                maximum_amount_money: {
                    amount: newAmountCents,
                    currency: discountObj.discount_data?.maximum_amount_money?.currency || 'CAD'
                }
            }
        };

        const upsertResponse = await fetch('https://connect.squareup.com/v2/catalog/batch-upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify({
                idempotency_key: generateIdempotencyKey(`loyalty-discount-price-update-${rewardId}-${newAmountCents}`),
                batches: [{ objects: [updatedObject] }]
            })
        });

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
            WHERE id = $2
        `, [newAmountCents, rewardId]);

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

/**
 * Validate earned rewards and their Square discount objects
 * Checks that discounts exist in Square and match database state
 * Optionally fixes discrepancies
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {boolean} [params.fixIssues=false] - Whether to fix found issues
 * @returns {Promise<Object>} Validation results
 */
async function validateEarnedRewardsDiscounts({ merchantId, fixIssues = false }) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    logger.info('Validating earned rewards discounts', { merchantId, fixIssues });

    const accessToken = await getSquareAccessToken(merchantId);
    if (!accessToken) {
        return { success: false, error: 'No access token available' };
    }

    // Get all earned rewards with Square discount IDs
    const rewardsResult = await db.query(`
        SELECT r.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1
          AND r.status = 'earned'
        ORDER BY r.earned_at DESC
    `, [merchantId]);

    const results = {
        totalEarned: rewardsResult.rows.length,
        validated: 0,
        issues: [],
        fixed: []
    };

    for (const reward of rewardsResult.rows) {
        const validationResult = await validateSingleRewardDiscount({
            merchantId,
            reward,
            accessToken,
            fixIssues
        });

        if (validationResult.valid) {
            results.validated++;
        } else {
            results.issues.push({
                rewardId: reward.id,
                squareCustomerId: reward.square_customer_id,
                offerName: reward.offer_name,
                earnedAt: reward.earned_at,
                issue: validationResult.issue,
                details: validationResult.details
            });

            if (fixIssues && validationResult.fixed) {
                results.fixed.push({
                    rewardId: reward.id,
                    action: validationResult.fixAction
                });
            }
        }
    }

    logger.info('Discount validation complete', {
        merchantId,
        totalEarned: results.totalEarned,
        validated: results.validated,
        issueCount: results.issues.length,
        fixedCount: results.fixed.length
    });

    return {
        success: true,
        ...results
    };
}

/**
 * Sync discount caps for all earned (unredeemed) rewards with current catalog prices.
 *
 * For each earned reward that has a Square discount object:
 *   1. Fetch the current MAX(price_money) from qualifying variations
 *   2. Compare against discount_amount_cents stored locally
 *   3. If current price > stored cap, update the Square DISCOUNT object
 *
 * This ensures free-item rewards always cover the full current price,
 * even if prices increased after the customer earned the reward.
 *
 * @param {Object} params
 * @param {number} params.merchantId - Internal merchant ID
 * @returns {Promise<Object>} Sync results with counts and details
 */
async function syncRewardDiscountPrices({ merchantId }) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    logger.info('Starting reward discount price sync', { merchantId });

    // Get all earned rewards with Square discount IDs, joined with
    // the current max catalog price for their qualifying variations
    const rewardsResult = await db.query(`
        SELECT r.id as reward_id,
               r.square_discount_id,
               r.discount_amount_cents,
               r.offer_id,
               o.offer_name,
               (SELECT MAX(v.price_money) FROM variations v
                INNER JOIN loyalty_qualifying_variations qv
                    ON v.square_variation_id = qv.variation_id AND qv.is_active = TRUE
                WHERE qv.offer_id = r.offer_id AND qv.merchant_id = r.merchant_id
                  AND v.merchant_id = r.merchant_id AND v.price_money > 0
               ) as current_max_price_cents
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1
          AND r.status = 'earned'
          AND r.square_discount_id IS NOT NULL
        ORDER BY r.earned_at DESC
    `, [merchantId]);

    const results = {
        totalChecked: rewardsResult.rows.length,
        upToDate: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
        details: []
    };

    for (const reward of rewardsResult.rows) {
        const currentPrice = parseInt(reward.current_max_price_cents, 10) || 0;
        const storedCap = parseInt(reward.discount_amount_cents, 10) || 0;

        if (currentPrice <= 0) {
            results.skipped++;
            continue;
        }

        if (storedCap >= currentPrice) {
            results.upToDate++;
            continue;
        }

        // Current catalog price exceeds the discount cap — update Square
        logger.info('Reward discount cap below current price, updating', {
            merchantId,
            rewardId: reward.reward_id,
            offerName: reward.offer_name,
            storedCap,
            currentPrice,
            delta: currentPrice - storedCap
        });

        const updateResult = await updateRewardDiscountAmount({
            merchantId,
            squareDiscountId: reward.square_discount_id,
            newAmountCents: currentPrice,
            rewardId: reward.reward_id
        });

        if (updateResult.success) {
            results.updated++;
            results.details.push({
                rewardId: reward.reward_id,
                offerName: reward.offer_name,
                oldCap: storedCap,
                newCap: currentPrice
            });
        } else {
            results.failed++;
            results.details.push({
                rewardId: reward.reward_id,
                offerName: reward.offer_name,
                error: updateResult.error
            });
        }
    }

    logger.info('Reward discount price sync complete', {
        merchantId,
        ...results,
        details: undefined // omit per-reward details from summary log
    });

    return { success: true, ...results };
}

/**
 * Validate a single reward's discount objects in Square
 */
async function validateSingleRewardDiscount({ merchantId, reward, accessToken, fixIssues }) {
    const result = {
        valid: true,
        issue: null,
        details: {},
        fixed: false,
        fixAction: null
    };

    // Check 1: Does the reward have Square IDs stored?
    if (!reward.square_discount_id && !reward.square_group_id) {
        result.valid = false;
        result.issue = 'MISSING_SQUARE_IDS';
        result.details = { message: 'No Square discount objects created for this reward' };

        if (fixIssues) {
            // Try to create the discount objects
            const createResult = await createSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: reward.id,
                offerId: reward.offer_id
            });

            if (createResult.success) {
                result.fixed = true;
                result.fixAction = 'CREATED_DISCOUNT';
                logger.info('Created missing discount for reward', {
                    merchantId,
                    rewardId: reward.id
                });
            } else {
                result.details.fixError = createResult.error;
            }
        }

        return result;
    }

    // Check 2: Verify the discount object exists in Square
    if (reward.square_discount_id) {
        try {
            const catalogCheckStart = Date.now();
            const response = await fetch(
                `https://connect.squareup.com/v2/catalog/object/${reward.square_discount_id}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2025-01-16'
                    }
                }
            );
            const catalogCheckDuration = Date.now() - catalogCheckStart;

            loyaltyLogger.squareApi({
                endpoint: `/catalog/object/${reward.square_discount_id}`,
                method: 'GET',
                status: response.status,
                duration: catalogCheckDuration,
                success: response.ok,
                merchantId,
                context: 'validateRewardSquareObjects',
            });

            if (response.status === 404) {
                result.valid = false;
                result.issue = 'DISCOUNT_NOT_FOUND';
                result.details = {
                    message: 'Discount object not found in Square catalog',
                    squareDiscountId: reward.square_discount_id
                };

                if (fixIssues) {
                    // Clear invalid IDs and recreate
                    await db.query(`
                        UPDATE loyalty_rewards SET
                            square_group_id = NULL,
                            square_discount_id = NULL,
                            square_product_set_id = NULL,
                            square_pricing_rule_id = NULL,
                            updated_at = NOW()
                        WHERE id = $1
                    `, [reward.id]);

                    const createResult = await createSquareCustomerGroupDiscount({
                        merchantId,
                        squareCustomerId: reward.square_customer_id,
                        internalRewardId: reward.id,
                        offerId: reward.offer_id
                    });

                    if (createResult.success) {
                        result.fixed = true;
                        result.fixAction = 'RECREATED_DISCOUNT';
                    } else {
                        result.details.fixError = createResult.error;
                    }
                }

                return result;
            }

            if (!response.ok) {
                const errorData = await response.json();
                result.valid = false;
                result.issue = 'DISCOUNT_API_ERROR';
                result.details = {
                    message: 'Error checking discount in Square',
                    error: errorData
                };
                return result;
            }

            // Discount exists - verify it's still valid
            const discountData = await response.json();
            const discountObj = discountData.object;

            if (discountObj.is_deleted) {
                result.valid = false;
                result.issue = 'DISCOUNT_DELETED';
                result.details = {
                    message: 'Discount was deleted in Square',
                    squareDiscountId: reward.square_discount_id
                };

                if (fixIssues) {
                    // Clear invalid IDs and recreate
                    await db.query(`
                        UPDATE loyalty_rewards SET
                            square_group_id = NULL,
                            square_discount_id = NULL,
                            square_product_set_id = NULL,
                            square_pricing_rule_id = NULL,
                            updated_at = NOW()
                        WHERE id = $1
                    `, [reward.id]);

                    const createResult = await createSquareCustomerGroupDiscount({
                        merchantId,
                        squareCustomerId: reward.square_customer_id,
                        internalRewardId: reward.id,
                        offerId: reward.offer_id
                    });

                    if (createResult.success) {
                        result.fixed = true;
                        result.fixAction = 'RECREATED_DELETED_DISCOUNT';
                    } else {
                        result.details.fixError = createResult.error;
                    }
                }

                return result;
            }

        } catch (error) {
            result.valid = false;
            result.issue = 'VALIDATION_ERROR';
            result.details = { message: error.message };
            return result;
        }
    }

    // Check 3: Verify customer group membership
    if (reward.square_group_id && reward.square_customer_id) {
        try {
            const customerCheckStart = Date.now();
            const response = await fetch(
                `https://connect.squareup.com/v2/customers/${reward.square_customer_id}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2025-01-16'
                    }
                }
            );
            const customerCheckDuration = Date.now() - customerCheckStart;

            loyaltyLogger.squareApi({
                endpoint: `/customers/${reward.square_customer_id}`,
                method: 'GET',
                status: response.status,
                duration: customerCheckDuration,
                success: response.ok,
                merchantId,
                context: 'validateRewardSquareObjects',
            });

            if (response.ok) {
                const customerData = await response.json();
                const groupIds = customerData.customer?.group_ids || [];

                if (!groupIds.includes(reward.square_group_id)) {
                    result.valid = false;
                    result.issue = 'CUSTOMER_NOT_IN_GROUP';
                    result.details = {
                        message: 'Customer not in discount group',
                        squareGroupId: reward.square_group_id,
                        customerGroups: groupIds
                    };

                    if (fixIssues) {
                        // Re-add customer to group
                        const addResult = await addCustomerToGroup({
                            merchantId,
                            squareCustomerId: reward.square_customer_id,
                            groupId: reward.square_group_id
                        });

                        if (addResult) {
                            result.fixed = true;
                            result.fixAction = 'READDED_TO_GROUP';
                        }
                    }

                    return result;
                }
            }
        } catch (error) {
            // Non-fatal - customer lookup may fail
            logger.warn('Could not verify customer group membership', {
                rewardId: reward.id,
                error: error.message
            });
        }
    }

    return result;
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
                    'Square-Version': '2025-01-16'
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
                    'Square-Version': '2025-01-16'
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

module.exports = {
    getSquareLoyaltyProgram,
    createRewardCustomerGroup,
    addCustomerToGroup,
    removeCustomerFromGroup,
    deleteCustomerGroup,
    createRewardDiscount,
    deleteRewardDiscountObjects,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    updateRewardDiscountAmount,
    syncRewardDiscountPrices,
    validateEarnedRewardsDiscounts,
    validateSingleRewardDiscount,
    updateCustomerRewardNote
};
