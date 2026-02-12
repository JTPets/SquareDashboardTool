/**
 * Square Catalog Cleanup Utility
 *
 * Shared utility for deleting Square catalog objects (discounts, pricing rules,
 * product sets) and cleaning up customer groups. Consolidates three previously
 * separate deletion code paths into one with consistent behavior.
 *
 * Uses makeSquareRequest for retry logic, rate-limit handling, and centralized
 * Square API versioning.
 *
 * See docs/BACKLOG-6-INVESTIGATION.md for full context.
 */

const logger = require('./logger');

// Lazy-load to avoid circular dependency
let squareApi = null;
function getSquareApi() {
    if (!squareApi) {
        squareApi = require('../services/square/api');
    }
    return squareApi;
}

/**
 * Delete Square catalog objects using batch-delete.
 * Supports mixed types (DISCOUNT, PRODUCT_SET, PRICING_RULE) in a single call.
 * Tolerates 404 (already deleted). Uses makeSquareRequest for retry + rate-limit handling.
 *
 * @param {number} merchantId - Merchant ID for token lookup
 * @param {string[]} objectIds - Square catalog object IDs to delete
 * @param {Object} [options]
 * @param {string} [options.auditContext] - Caller context for logging (e.g. 'loyalty-cleanup', 'expiry-tier-clear')
 * @returns {Promise<{success: boolean, deleted: string[], failed: string[], errors: any[]}>}
 */
async function deleteCatalogObjects(merchantId, objectIds, options = {}) {
    const { auditContext = 'unknown' } = options;

    // Filter out null/undefined/empty IDs
    const validIds = (objectIds || []).filter(id => id != null && id !== '');
    if (validIds.length === 0) {
        return { success: true, deleted: [], failed: [], errors: [] };
    }

    const api = getSquareApi();

    try {
        const accessToken = await api.getMerchantToken(merchantId);

        const result = await api.makeSquareRequest('/v2/catalog/batch-delete', {
            method: 'POST',
            accessToken,
            body: JSON.stringify({ object_ids: validIds }),
        });

        // batch-delete returns deleted_object_ids (may be subset if some already gone)
        const deletedIds = result.deleted_object_ids || validIds;
        const failedIds = validIds.filter(id => !deletedIds.includes(id));

        logger.info('Deleted catalog objects', {
            merchantId,
            deletedCount: deletedIds.length,
            deletedIds,
            context: auditContext,
        });

        return {
            success: true,
            deleted: deletedIds,
            failed: failedIds,
            errors: [],
        };

    } catch (error) {
        // 404 means the objects are already gone — treat as success
        if (error.message && error.message.includes('404')) {
            logger.info('Catalog objects already deleted (404)', {
                merchantId,
                objectIds: validIds,
                context: auditContext,
            });
            return { success: true, deleted: validIds, failed: [], errors: [] };
        }

        logger.error('Failed to delete catalog objects', {
            merchantId,
            objectIds: validIds,
            error: error.message,
            context: auditContext,
        });

        return {
            success: false,
            deleted: [],
            failed: validIds,
            errors: [{ objectIds: validIds, error: error.message }],
        };
    }
}

/**
 * Delete a Square customer group after removing specified members.
 * Tolerates 404 at each step (already removed/deleted).
 * Uses makeSquareRequest for retry + rate-limit handling.
 *
 * @param {number} merchantId - Merchant ID for token lookup
 * @param {string} groupId - Square customer group ID
 * @param {string[]} [customerIds] - Customer IDs to remove from group first
 * @returns {Promise<{success: boolean, customersRemoved: boolean, groupDeleted: boolean}>}
 */
async function deleteCustomerGroupWithMembers(merchantId, groupId, customerIds = []) {
    if (!groupId) {
        return { success: true, customersRemoved: true, groupDeleted: true };
    }

    const api = getSquareApi();
    let customersRemoved = true;
    let groupDeleted = false;

    try {
        const accessToken = await api.getMerchantToken(merchantId);

        // Step 1: Remove each customer from the group
        for (const customerId of customerIds.filter(id => id != null)) {
            try {
                await api.makeSquareRequest(
                    `/v2/customers/${customerId}/groups/${groupId}`,
                    { method: 'DELETE', accessToken }
                );
                logger.info('Removed customer from group', {
                    merchantId, customerId, groupId,
                });
            } catch (err) {
                // 404 = already removed, treat as success
                if (err.message && err.message.includes('404')) {
                    logger.info('Customer already removed from group (404)', {
                        merchantId, customerId, groupId,
                    });
                } else {
                    logger.error('Failed to remove customer from group', {
                        merchantId, customerId, groupId,
                        error: err.message,
                    });
                    customersRemoved = false;
                }
            }
        }

        // Step 2: Delete the group itself
        try {
            await api.makeSquareRequest(
                `/v2/customers/groups/${groupId}`,
                { method: 'DELETE', accessToken }
            );
            groupDeleted = true;
            logger.info('Deleted customer group', { merchantId, groupId });
        } catch (err) {
            if (err.message && err.message.includes('404')) {
                groupDeleted = true;
                logger.info('Customer group already deleted (404)', { merchantId, groupId });
            } else {
                logger.error('Failed to delete customer group', {
                    merchantId, groupId,
                    error: err.message,
                });
            }
        }

    } catch (error) {
        logger.error('Error in deleteCustomerGroupWithMembers', {
            merchantId, groupId,
            error: error.message,
        });
        return { success: false, customersRemoved: false, groupDeleted: false };
    }

    return {
        success: customersRemoved && groupDeleted,
        customersRemoved,
        groupDeleted,
    };
}

module.exports = {
    deleteCatalogObjects,
    deleteCustomerGroupWithMembers,
};
