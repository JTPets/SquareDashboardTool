/**
 * Customer Details Service
 *
 * Standalone functions for fetching and caching Square customer profiles.
 * Extracted from LoyaltyCustomerService (customer-identification-service.js)
 * so callers that only need customer details don't need to instantiate the
 * full identification service class.
 *
 * Used by: order-delivery.js, delivery-service.js
 * Delegated from: LoyaltyCustomerService.getCustomerDetails/cacheCustomerDetails
 */

const db = require('../../utils/database');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { SquareApiClient } = require('./square-api-client');

/**
 * Get customer details from Square API
 * @param {string} customerId - Square customer ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Customer details or null on error
 */
async function getCustomerDetails(customerId, merchantId) {
    try {
        const squareClient = await new SquareApiClient(merchantId).initialize();
        const customer = await squareClient.getCustomer(customerId);
        return {
            id: customer.id,
            givenName: customer.given_name || null,
            familyName: customer.family_name || null,
            displayName: [customer.given_name, customer.family_name]
                .filter(Boolean).join(' ') || customer.company_name || null,
            email: customer.email_address || null,
            phone: customer.phone_number || null,
            companyName: customer.company_name || null,
            // LOGIC CHANGE (BACKLOG-17): Added birthday field so customer-admin-service
            // can delegate to this function without losing birthday data.
            birthday: customer.birthday || null,
            note: customer.note || null,
            createdAt: customer.created_at,
            updatedAt: customer.updated_at,
        };
    } catch (error) {
        loyaltyLogger.error({
            action: 'GET_CUSTOMER_DETAILS_ERROR',
            customerId,
            error: error.message,
            merchantId,
        });
        return null;
    }
}

/**
 * Cache customer details to loyalty_customers table.
 * Checks local cache first; fetches from Square API if not cached.
 * @param {string} customerId - Square customer ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Customer details or null
 */
async function cacheCustomerDetails(customerId, merchantId) {
    try {
        // Check if already cached with phone number
        const cached = await db.query(`
            SELECT phone_number FROM loyalty_customers
            WHERE merchant_id = $1 AND square_customer_id = $2
        `, [merchantId, customerId]);

        if (cached.rows.length > 0 && cached.rows[0].phone_number) {
            return { id: customerId, phone: cached.rows[0].phone_number, cached: true };
        }

        // Fetch from Square API
        const customer = await getCustomerDetails(customerId, merchantId);
        if (!customer) {
            return null;
        }

        // Upsert to cache
        await db.query(`
            INSERT INTO loyalty_customers (
                merchant_id, square_customer_id, given_name, family_name,
                display_name, phone_number, email_address, company_name,
                last_updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (merchant_id, square_customer_id) DO UPDATE SET
                given_name = COALESCE(EXCLUDED.given_name, loyalty_customers.given_name),
                family_name = COALESCE(EXCLUDED.family_name, loyalty_customers.family_name),
                display_name = COALESCE(EXCLUDED.display_name, loyalty_customers.display_name),
                phone_number = COALESCE(EXCLUDED.phone_number, loyalty_customers.phone_number),
                email_address = COALESCE(EXCLUDED.email_address, loyalty_customers.email_address),
                company_name = COALESCE(EXCLUDED.company_name, loyalty_customers.company_name),
                last_updated_at = NOW()
        `, [
            merchantId,
            customerId,
            customer.givenName,
            customer.familyName,
            customer.displayName,
            customer.phone,
            customer.email,
            customer.companyName,
        ]);

        loyaltyLogger.customer({
            action: 'CUSTOMER_CACHED',
            customerId,
            hasPhone: !!customer.phone,
            merchantId,
        });

        return customer;
    } catch (error) {
        loyaltyLogger.error({
            action: 'CACHE_CUSTOMER_ERROR',
            customerId,
            error: error.message,
            merchantId,
        });
        return null;
    }
}

module.exports = { getCustomerDetails, cacheCustomerDetails };
