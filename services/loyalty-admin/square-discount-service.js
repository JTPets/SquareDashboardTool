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
const { loyaltyLogger } = require('../loyalty/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken } = require('./shared-utils');
const { getCustomerDetails } = require('./customer-admin-service');

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
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {string} params.groupId - Square group ID
 * @returns {Promise<Object>} Result
 */
async function removeCustomerFromGroup({ merchantId, squareCustomerId, groupId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const removeFromGroupStart = Date.now();
        const response = await fetch(
            `https://connect.squareup.com/v2/customers/${squareCustomerId}/groups/${groupId}`,
            {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                }
            }
        );
        const removeFromGroupDuration = Date.now() - removeFromGroupStart;

        loyaltyLogger.squareApi({
            endpoint: `/customers/${squareCustomerId}/groups/${groupId}`,
            method: 'DELETE',
            status: response.status,
            duration: removeFromGroupDuration,
            success: response.ok || response.status === 404,
            merchantId,
            context: 'removeCustomerFromGroup',
        });

        if (!response.ok && response.status !== 404) {
            const errorData = await response.json();
            logger.error('Failed to remove customer from group', {
                merchantId,
                squareCustomerId,
                groupId,
                error: errorData
            });
            return { success: false, error: `Square API error: ${JSON.stringify(errorData)}` };
        }

        logger.info('Removed customer from group', {
            merchantId,
            squareCustomerId,
            groupId
        });

        return { success: true };

    } catch (error) {
        logger.error('Error removing customer from group', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Delete a Customer Group from Square
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.groupId - Square group ID
 * @returns {Promise<Object>} Result
 */
async function deleteCustomerGroup({ merchantId, groupId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const deleteGroupStart = Date.now();
        const response = await fetch(
            `https://connect.squareup.com/v2/customers/groups/${groupId}`,
            {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                }
            }
        );
        const deleteGroupDuration = Date.now() - deleteGroupStart;

        loyaltyLogger.squareApi({
            endpoint: `/customers/groups/${groupId}`,
            method: 'DELETE',
            status: response.status,
            duration: deleteGroupDuration,
            success: response.ok || response.status === 404,
            merchantId,
            context: 'deleteCustomerGroup',
        });

        if (!response.ok && response.status !== 404) {
            const errorData = await response.json();
            logger.error('Failed to delete customer group', {
                merchantId,
                groupId,
                error: errorData
            });
            return { success: false, error: `Square API error: ${JSON.stringify(errorData)}` };
        }

        logger.info('Deleted customer group', {
            merchantId,
            groupId
        });

        return { success: true };

    } catch (error) {
        logger.error('Error deleting customer group', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Create a Discount + Pricing Rule in Square for a reward
 * This creates a FIXED_AMOUNT 100% discount (free item) that applies
 * to specific variations when a customer in the group checks out.
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {number} params.internalRewardId - Our internal reward ID
 * @param {string} params.groupId - Square customer group ID
 * @param {string} params.offerName - Name of the offer for display
 * @param {Array<string>} params.variationIds - Square variation IDs this discount applies to
 * @returns {Promise<Object>} Result with discount and pricing rule IDs
 */
async function createRewardDiscount({ merchantId, internalRewardId, groupId, offerName, variationIds }) {
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
        // 1. DISCOUNT - 100% off (free item)
        // 2. PRODUCT_SET - defines which variations qualify
        // 3. PRICING_RULE - links discount to product set with customer group condition
        const catalogObjects = [
            {
                type: 'DISCOUNT',
                id: discountId,
                discount_data: {
                    name: `Loyalty: ${offerName} (Reward ${internalRewardId})`,
                    discount_type: 'FIXED_PERCENTAGE',
                    percentage: '100',
                    application_method: 'AUTOMATICALLY_APPLIED',
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
                    customer_group_ids_any: [groupId],
                    time_period_ids: [],
                    exclude_products_id: null,
                    exclude_strategy: 'LEAST_EXPENSIVE'
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
                idempotency_key: `loyalty-discount-batch-${internalRewardId}`,
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
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        if (!objectIds || objectIds.length === 0) {
            return { success: true, deleted: 0 };
        }

        // Filter out null/undefined IDs
        const validIds = objectIds.filter(id => id != null);
        if (validIds.length === 0) {
            return { success: true, deleted: 0 };
        }

        let deletedCount = 0;
        const errors = [];

        // Delete each object individually (batch delete has restrictions)
        for (const objectId of validIds) {
            try {
                const deleteStart = Date.now();
                const response = await fetch(
                    `https://connect.squareup.com/v2/catalog/object/${objectId}`,
                    {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                            'Square-Version': '2025-01-16'
                        }
                    }
                );
                const deleteDuration = Date.now() - deleteStart;

                loyaltyLogger.squareApi({
                    endpoint: `/catalog/object/${objectId}`,
                    method: 'DELETE',
                    status: response.status,
                    duration: deleteDuration,
                    success: response.ok || response.status === 404,
                    merchantId,
                    context: 'deleteRewardDiscountObjects',
                });

                if (response.ok || response.status === 404) {
                    deletedCount++;
                } else {
                    const errorData = await response.json();
                    errors.push({ objectId, error: errorData });
                }
            } catch (err) {
                errors.push({ objectId, error: err.message });
            }
        }

        if (errors.length > 0) {
            logger.warn('Some discount objects failed to delete', {
                merchantId,
                deletedCount,
                errors
            });
        } else {
            logger.info('Deleted discount objects', {
                merchantId,
                deletedCount
            });
        }

        return {
            success: errors.length === 0,
            deleted: deletedCount,
            errors: errors.length > 0 ? errors : undefined
        };

    } catch (error) {
        logger.error('Error deleting discount objects', { error: error.message, stack: error.stack, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Create a Square Customer Group Discount for an earned reward
 * This is the main entry point - orchestrates group creation, customer assignment, and discount creation.
 * Once created, the discount will auto-apply at Square POS.
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

        // Step 3: Create discount + pricing rule
        const discountResult = await createRewardDiscount({
            merchantId,
            internalRewardId,
            groupId: groupResult.groupId,
            offerName: offer.offer_name,
            variationIds
        });

        if (!discountResult.success) {
            // Cleanup: remove customer from group and delete group
            await removeCustomerFromGroup({ merchantId, squareCustomerId, groupId: groupResult.groupId });
            await deleteCustomerGroup({ merchantId, groupId: groupResult.groupId });
            return discountResult;
        }

        // Step 4: Store Square object IDs in our reward record for cleanup later
        await db.query(`
            UPDATE loyalty_rewards SET
                square_group_id = $1,
                square_discount_id = $2,
                square_product_set_id = $3,
                square_pricing_rule_id = $4,
                square_pos_synced_at = NOW(),
                updated_at = NOW()
            WHERE id = $5
        `, [
            groupResult.groupId,
            discountResult.discountId,
            discountResult.productSetId,
            discountResult.pricingRuleId,
            internalRewardId
        ]);

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
        // Get the Square object IDs from our reward record
        const rewardResult = await db.query(`
            SELECT square_group_id, square_discount_id, square_product_set_id, square_pricing_rule_id
            FROM loyalty_rewards
            WHERE id = $1 AND merchant_id = $2
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

        // Step 1: Remove customer from group (if group exists)
        if (reward.square_group_id && squareCustomerId) {
            const removeResult = await removeCustomerFromGroup({
                merchantId,
                squareCustomerId,
                groupId: reward.square_group_id
            });
            cleanupResults.customerRemoved = removeResult.success;
        }

        // Step 2: Delete catalog objects (discount, product set, pricing rule)
        const objectsToDelete = [
            reward.square_pricing_rule_id,  // Delete rule first (depends on others)
            reward.square_product_set_id,
            reward.square_discount_id
        ].filter(id => id != null);

        if (objectsToDelete.length > 0) {
            const deleteResult = await deleteRewardDiscountObjects({
                merchantId,
                objectIds: objectsToDelete
            });
            cleanupResults.discountsDeleted = deleteResult.success;
        }

        // Step 3: Delete the customer group
        if (reward.square_group_id) {
            const deleteGroupResult = await deleteCustomerGroup({
                merchantId,
                groupId: reward.square_group_id
            });
            cleanupResults.groupDeleted = deleteGroupResult.success;
        }

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
    validateEarnedRewardsDiscounts,
    validateSingleRewardDiscount
};
