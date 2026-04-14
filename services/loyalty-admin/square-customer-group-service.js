/**
 * Square Customer Group Service
 *
 * CRUD operations for Square Customer Groups used by loyalty rewards.
 * Each reward gets its own group so we can track/remove individually.
 *
 * Extracted from square-discount-service.js — single responsibility: group management.
 */

const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { makeSquareRequest, getMerchantToken, SquareApiError } = require('../square/square-client');

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
    const groupName = `Loyalty Reward ${internalRewardId} - ${offerName} - ${customerName}`.substring(0, 255);
    const createGroupStart = Date.now();

    try {
        const accessToken = await getMerchantToken(merchantId);

        const data = await makeSquareRequest('/v2/customers/groups', {
            method: 'POST',
            accessToken,
            body: JSON.stringify({
                idempotency_key: `loyalty-reward-group-${internalRewardId}`,
                group: {
                    name: groupName
                }
            }),
            timeout: 10000,
        });

        loyaltyLogger.squareApi({
            endpoint: '/customers/groups',
            method: 'POST',
            status: 200,
            duration: Date.now() - createGroupStart,
            success: true,
            merchantId,
            context: 'createRewardCustomerGroup',
        });

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
        const status = error instanceof SquareApiError ? error.status : 0;
        loyaltyLogger.squareApi({
            endpoint: '/customers/groups',
            method: 'POST',
            status,
            duration: Date.now() - createGroupStart,
            success: false,
            merchantId,
            context: 'createRewardCustomerGroup',
        });

        if (error instanceof SquareApiError) {
            logger.error('Failed to create customer group', {
                merchantId,
                internalRewardId,
                error: error.details,
                status: error.status
            });
            return { success: false, error: `Square API error: ${JSON.stringify(error.details)}` };
        }

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
    const endpoint = `/v2/customers/${squareCustomerId}/groups/${groupId}`;
    const addToGroupStart = Date.now();

    try {
        const accessToken = await getMerchantToken(merchantId);

        await makeSquareRequest(endpoint, {
            method: 'PUT',
            accessToken,
            timeout: 10000,
        });

        loyaltyLogger.squareApi({
            endpoint: `/customers/${squareCustomerId}/groups/${groupId}`,
            method: 'PUT',
            status: 200,
            duration: Date.now() - addToGroupStart,
            success: true,
            merchantId,
            context: 'addCustomerToGroup',
        });

        logger.info('Added customer to group', {
            merchantId,
            squareCustomerId,
            groupId
        });

        return { success: true };

    } catch (error) {
        const status = error instanceof SquareApiError ? error.status : 0;
        loyaltyLogger.squareApi({
            endpoint: `/customers/${squareCustomerId}/groups/${groupId}`,
            method: 'PUT',
            status,
            duration: Date.now() - addToGroupStart,
            success: false,
            merchantId,
            context: 'addCustomerToGroup',
        });

        if (error instanceof SquareApiError) {
            logger.error('Failed to add customer to group', {
                merchantId,
                squareCustomerId,
                groupId,
                error: error.details
            });
            return { success: false, error: `Square API error: ${JSON.stringify(error.details)}` };
        }

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
        const accessToken = await getMerchantToken(merchantId);
        await makeSquareRequest(
            `/v2/customers/${squareCustomerId}/groups/${groupId}`,
            { method: 'DELETE', accessToken }
        );
        logger.info('Removed customer from group', { merchantId, squareCustomerId, groupId });
        return { success: true };
    } catch (error) {
        if (error instanceof SquareApiError && error.status === 404) {
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
        const accessToken = await getMerchantToken(merchantId);
        await makeSquareRequest(
            `/v2/customers/groups/${groupId}`,
            { method: 'DELETE', accessToken }
        );
        logger.info('Deleted customer group', { merchantId, groupId });
        return { success: true };
    } catch (error) {
        if (error instanceof SquareApiError && error.status === 404) {
            return { success: true }; // Already deleted
        }
        logger.error('Failed to delete customer group', {
            merchantId, groupId, error: error.message,
        });
        return { success: false, error: error.message };
    }
}

module.exports = {
    createRewardCustomerGroup,
    addCustomerToGroup,
    removeCustomerFromGroup,
    deleteCustomerGroup
};
