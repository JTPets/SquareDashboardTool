/**
 * Customer Refresh Service
 *
 * Refreshes customer details for rewards with missing phone numbers.
 * Finds customers with missing data, fetches from Square, and updates cache.
 *
 * Extracted from routes/loyalty/processing.js POST /refresh-customers (A-14)
 * — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - Reinvents semaphore pattern (should use p-limit or similar)
 * - Inline SQL for finding customers with missing phone data
 * - Concurrency limit (5) is hardcoded
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getCustomerDetails } = require('./customer-admin-service');

/**
 * Refresh customer details for rewards with missing phone numbers.
 * Finds all unique customer IDs with rewards but no phone in cache,
 * then fetches from Square with concurrency control.
 *
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Refresh results { total, refreshed, failed, errors? }
 */
async function refreshCustomersWithMissingData(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for refreshCustomersWithMissingData - tenant isolation required');
    }

    // Find all unique customer IDs with rewards but no phone in cache
    const missingResult = await db.query(`
        SELECT DISTINCT r.square_customer_id
        FROM loyalty_rewards r
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
          AND (lc.phone_number IS NULL OR lc.square_customer_id IS NULL)
    `, [merchantId]);

    const customerIds = missingResult.rows.map(r => r.square_customer_id);

    if (customerIds.length === 0) {
        return { success: true, message: 'No customers with missing phone data', refreshed: 0 };
    }

    logger.info('Refreshing customer data for rewards', { merchantId, count: customerIds.length });

    let refreshed = 0;
    let failed = 0;
    const errors = [];

    // Concurrent customer fetch with semaphore
    const CONCURRENCY = 5;
    let active = 0;
    const queue = [];

    function runWithLimit(fn) {
        return new Promise((resolve, reject) => {
            const execute = async () => {
                active++;
                try {
                    resolve(await fn());
                } catch (err) {
                    reject(err);
                } finally {
                    active--;
                    if (queue.length > 0) {
                        queue.shift()();
                    }
                }
            };
            if (active < CONCURRENCY) {
                execute();
            } else {
                queue.push(execute);
            }
        });
    }

    const results = await Promise.allSettled(
        customerIds.map(customerId =>
            runWithLimit(async () => {
                const customer = await getCustomerDetails(customerId, merchantId);
                return { customerId, customer };
            })
        )
    );

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.customer) {
            refreshed++;
            logger.debug('Refreshed customer', {
                customerId: result.value.customerId,
                phone: result.value.customer.phone ? 'yes' : 'no'
            });
        } else {
            failed++;
            const customerId = result.status === 'fulfilled'
                ? result.value.customerId : 'unknown';
            const error = result.status === 'rejected'
                ? result.reason.message : 'Customer not found in Square';
            errors.push({ customerId, error });
        }
    }

    logger.info('Customer refresh complete', { merchantId, refreshed, failed });

    return {
        success: true,
        total: customerIds.length,
        refreshed,
        failed,
        errors: errors.length > 0 ? errors : undefined
    };
}

module.exports = {
    refreshCustomersWithMissingData
};
