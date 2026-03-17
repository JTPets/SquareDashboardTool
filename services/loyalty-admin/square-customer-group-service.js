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
const { fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION } = require('./shared-utils'); // LOGIC CHANGE: use centralized Square API version from constants (CRIT-5)

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
        const response = await fetchWithTimeout('https://connect.squareup.com/v2/customers/groups', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': SQUARE_API_VERSION
            },
            body: JSON.stringify({
                idempotency_key: `loyalty-reward-group-${internalRewardId}`,
                group: {
                    name: groupName
                }
            })
        }, 10000);
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
        const response = await fetchWithTimeout(
            `https://connect.squareup.com/v2/customers/${squareCustomerId}/groups/${groupId}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                }
            },
            10000
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

module.exports = {
    createRewardCustomerGroup,
    addCustomerToGroup,
    removeCustomerFromGroup,
    deleteCustomerGroup
};
