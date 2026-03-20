/**
 * Discount Validation Service
 *
 * Validates earned rewards' Square discount objects and syncs discount price caps
 * with current catalog prices. Read-heavy operations that verify Square state
 * matches local database state.
 *
 * Extracted from square-discount-service.js — single responsibility: validation & sync.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION } = require('./shared-utils'); // LOGIC CHANGE: use centralized Square API version from constants (CRIT-5)
const { addCustomerToGroup } = require('./square-customer-group-service');
const { updateRewardDiscountAmount } = require('./square-discount-catalog-service');

// Lazy-loaded to avoid circular dependency (validation can trigger creation)
let _createSquareCustomerGroupDiscount;
function getCreateDiscount() {
    if (!_createSquareCustomerGroupDiscount) {
        _createSquareCustomerGroupDiscount = require('./square-discount-service').createSquareCustomerGroupDiscount;
    }
    return _createSquareCustomerGroupDiscount;
}

// LOGIC CHANGE: extracted duplicate recreate-discount pattern (BACKLOG-69)
/**
 * Clear invalid Square IDs from a reward and recreate the discount.
 * Shared by DISCOUNT_NOT_FOUND and DISCOUNT_DELETED fix paths.
 *
 * @param {Object} params
 * @param {number} params.merchantId - Internal merchant ID
 * @param {Object} params.reward - Reward row with id, square_customer_id, offer_id
 * @param {boolean} [params.clearIds=true] - Whether to NULL existing Square IDs first
 * @returns {Promise<{success: boolean, fixAction?: string}>}
 */
async function recreateDiscountIfInvalid({ merchantId, reward, clearIds = true }) {
    if (clearIds) {
        await db.query(`
            UPDATE loyalty_rewards SET
                square_group_id = NULL,
                square_discount_id = NULL,
                square_product_set_id = NULL,
                square_pricing_rule_id = NULL,
                updated_at = NOW()
            WHERE id = $1 AND merchant_id = $2
        `, [reward.id, merchantId]);
    }

    const createResult = await getCreateDiscount()({
        merchantId,
        squareCustomerId: reward.square_customer_id,
        internalRewardId: reward.id,
        offerId: reward.offer_id
    });

    if (createResult.success) {
        logger.info('Recreated discount for reward', {
            merchantId,
            rewardId: reward.id,
            clearedIds: clearIds
        });
        return { success: true };
    }

    return { success: false, error: createResult.error };
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
                    ON v.id = qv.variation_id AND qv.is_active = TRUE
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

        // LOGIC CHANGE: price cap now syncs both directions (BACKLOG-70)
        if (storedCap === currentPrice) {
            results.upToDate++;
            continue;
        }

        // Price mismatch — update Square discount cap to match current catalog price
        const direction = currentPrice > storedCap ? 'increase' : 'decrease';
        logger.info('Reward discount cap mismatched, updating', {
            merchantId,
            rewardId: reward.reward_id,
            offerName: reward.offer_name,
            storedCap,
            currentPrice,
            direction,
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
                newCap: currentPrice,
                direction
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

    return { success: results.failed === 0, ...results };
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
            // LOGIC CHANGE: uses shared recreateDiscountIfInvalid (BACKLOG-69)
            const recreateResult = await recreateDiscountIfInvalid({
                merchantId, reward, clearIds: false
            });

            if (recreateResult.success) {
                result.fixed = true;
                result.fixAction = 'CREATED_DISCOUNT';
            } else {
                result.details.fixError = recreateResult.error;
            }
        }

        return result;
    }

    // Check 2: Verify the discount object exists in Square
    if (reward.square_discount_id) {
        try {
            const catalogCheckStart = Date.now();
            const response = await fetchWithTimeout(
                `https://connect.squareup.com/v2/catalog/object/${reward.square_discount_id}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': SQUARE_API_VERSION
                    }
                },
                10000
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
                    // LOGIC CHANGE: uses shared recreateDiscountIfInvalid (BACKLOG-69)
                    const recreateResult = await recreateDiscountIfInvalid({ merchantId, reward });

                    if (recreateResult.success) {
                        result.fixed = true;
                        result.fixAction = 'RECREATED_DISCOUNT';
                    } else {
                        result.details.fixError = recreateResult.error;
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
                    // LOGIC CHANGE: uses shared recreateDiscountIfInvalid (BACKLOG-69)
                    const recreateResult = await recreateDiscountIfInvalid({ merchantId, reward });

                    if (recreateResult.success) {
                        result.fixed = true;
                        result.fixAction = 'RECREATED_DELETED_DISCOUNT';
                    } else {
                        result.details.fixError = recreateResult.error;
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
            const response = await fetchWithTimeout(
                `https://connect.squareup.com/v2/customers/${reward.square_customer_id}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': SQUARE_API_VERSION
                    }
                },
                10000
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

                        if (addResult.success) {
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
    validateEarnedRewardsDiscounts,
    validateSingleRewardDiscount,
    syncRewardDiscountPrices,
    recreateDiscountIfInvalid
};
