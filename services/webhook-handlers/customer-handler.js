/**
 * Customer Webhook Handler
 *
 * Handles Square webhook events for customer create/update.
 * Consolidates all customer-related webhook processing:
 * - Delivery order note sync
 * - Loyalty catchup for newly linkable orders
 * - Seniors discount birthday evaluation
 *
 * Event types handled:
 * - customer.created  (resolves BACKLOG-11)
 * - customer.updated
 *
 * @module services/webhook-handlers/customer-handler
 */

const logger = require('../../utils/logger');
const db = require('../../utils/database');
const loyaltyService = require('../../utils/loyalty-service');
const { SeniorsService } = require('../seniors');
const { LoyaltySquareClient } = require('../loyalty/square-client');
const { cacheCustomerDetails } = require('../loyalty-admin/customer-cache-service');

class CustomerHandler {
    /**
     * Handle customer.created or customer.updated event
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleCustomerChange(context) {
        const { data, merchantId, entityId, event } = context;
        const result = { handled: true };

        if (!merchantId) {
            return result;
        }

        // Use entityId (canonical) with fallback to nested object
        const customerId = entityId || data?.customer?.id;
        if (!customerId) {
            return result;
        }

        // 1. Sync customer notes to delivery orders (if note present in payload)
        if (data.customer) {
            const noteResult = await this._syncCustomerNotes(
                merchantId, customerId, data.customer.note || null
            );
            if (noteResult) {
                result.customerNotes = noteResult;
            }
        }

        // 2. Run loyalty catchup — phone/email may have changed
        const catchupResult = await loyaltyService.runLoyaltyCatchup({
            merchantId,
            customerIds: [customerId],
            periodDays: 1,
            maxCustomers: 1,
        });

        if (catchupResult.ordersNewlyTracked > 0) {
            logger.info('Loyalty catchup found untracked orders via customer webhook', {
                customerId,
                eventType: event.type,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked,
            });
            result.loyaltyCatchup = {
                customerId,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked,
            };
        }

        // 3. Re-fetch customer from Square to get full profile (birthday not in webhook payload)
        //    Cache customer details for ALL merchants — not gated on seniors config
        const customer = await this._fetchAndCacheCustomer(merchantId, customerId);

        // 4. Seniors birthday check — only runs if customer has birthday
        //    Safe to skip null-birthday: handleCustomerBirthdayUpdate() also returns early
        //    for null birthday, and sweepLocalAges() cron re-evaluates cached birthdays monthly.
        //    Birthday removal from Square is a no-op in the seniors flow by design.
        if (customer?.birthday) {
            const seniorsResult = await this._checkSeniorsBirthday(merchantId, customerId, customer);
            if (seniorsResult) {
                result.seniorsDiscount = seniorsResult;
            }
        }

        return result;
    }

    /**
     * Sync customer notes to delivery orders
     * @private
     * @param {number} merchantId
     * @param {string} customerId
     * @param {string|null} customerNote
     * @returns {Promise<Object|null>} Result or null if no orders updated
     */
    async _syncCustomerNotes(merchantId, customerId, customerNote) {
        const updateResult = await db.query(
            `UPDATE delivery_orders
             SET customer_note = $1, updated_at = NOW()
             WHERE merchant_id = $2 AND square_customer_id = $3`,
            [customerNote, merchantId, customerId]
        );

        if (updateResult.rowCount > 0) {
            logger.info('Customer notes synced via webhook', {
                merchantId, customerId, ordersUpdated: updateResult.rowCount,
            });
            return { customerId, ordersUpdated: updateResult.rowCount };
        }

        return null;
    }

    /**
     * Fetch customer from Square API and cache details locally
     * Non-blocking — errors are logged but never fail the webhook
     * @private
     * @param {number} merchantId
     * @param {string} customerId - Square customer ID
     * @returns {Promise<Object|null>} Square customer object or null
     */
    async _fetchAndCacheCustomer(merchantId, customerId) {
        try {
            const squareClient = new LoyaltySquareClient(merchantId);
            await squareClient.initialize();
            const customer = await squareClient.getCustomer(customerId);

            if (customer) {
                await cacheCustomerDetails(customer, merchantId);
            }

            return customer;
        } catch (error) {
            logger.warn('Failed to fetch/cache customer details', {
                merchantId, customerId, error: error.message,
            });
            return null;
        }
    }

    /**
     * Check if customer qualifies for seniors discount
     * Non-blocking — errors are logged but never fail the webhook
     * @private
     * @param {number} merchantId
     * @param {string} customerId - Square customer ID
     * @param {Object} customer - Square customer object (already fetched)
     * @returns {Promise<Object|null>} Seniors result or null
     */
    async _checkSeniorsBirthday(merchantId, customerId, customer) {
        try {
            // Guard: only evaluate if seniors feature is configured
            const configCheck = await db.query(
                `SELECT id FROM seniors_discount_config
                 WHERE merchant_id = $1 AND is_enabled = TRUE AND square_group_id IS NOT NULL`,
                [merchantId]
            );

            if (configCheck.rows.length === 0) {
                return null;
            }

            // Evaluate seniors eligibility
            const service = new SeniorsService(merchantId);
            await service.initialize();
            const seniorsResult = await service.handleCustomerBirthdayUpdate({
                squareCustomerId: customerId,
                birthday: customer.birthday,
            });

            if (seniorsResult.groupChanged) {
                logger.info('Seniors group membership changed via customer webhook', {
                    merchantId,
                    customerId,
                    action: seniorsResult.action,
                    age: seniorsResult.age,
                });
                return seniorsResult;
            }

            return null;
        } catch (error) {
            // Non-blocking: seniors check failure must never break the webhook
            logger.warn('Failed to check seniors eligibility', {
                merchantId, customerId, error: error.message,
            });
            return null;
        }
    }
}

module.exports = CustomerHandler;
