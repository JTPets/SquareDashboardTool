/**
 * Loyalty Customer Cache Service
 *
 * Manages local caching of customer details from Square.
 * Reduces API calls by storing frequently accessed customer data.
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

/**
 * Cache customer details in local database
 * @param {Object} customer - Customer details object
 * @param {string} customer.id - Square customer ID
 * @param {string} [customer.givenName] - First name
 * @param {string} [customer.familyName] - Last name
 * @param {string} [customer.displayName] - Display name
 * @param {string} [customer.phone] - Phone number
 * @param {string} [customer.email] - Email address
 * @param {string} [customer.companyName] - Company name
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<void>}
 */
async function cacheCustomerDetails(customer, merchantId) {
    if (!customer?.id || !merchantId) return;

    try {
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
            customer.id,
            customer.givenName || customer.given_name || null,
            customer.familyName || customer.family_name || null,
            customer.displayName || customer.display_name || null,
            customer.phone || customer.phone_number || null,
            customer.email || customer.email_address || null,
            customer.companyName || customer.company_name || null
        ]);

        logger.debug('Cached customer details', { customerId: customer.id, merchantId });
    } catch (error) {
        // Don't fail if caching fails - it's just an optimization
        logger.warn('Failed to cache customer details', { error: error.message, customerId: customer.id });
    }
}

/**
 * Get cached customer details from local database
 * @param {string} customerId - Square customer ID
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Customer details or null
 */
async function getCachedCustomer(customerId, merchantId) {
    if (!customerId || !merchantId) return null;

    try {
        const result = await db.query(`
            SELECT square_customer_id as id, given_name, family_name, display_name,
                   phone_number as phone, email_address as email, company_name,
                   first_seen_at, last_updated_at, last_order_at,
                   total_orders, total_rewards_earned, has_active_rewards
            FROM loyalty_customers
            WHERE merchant_id = $1 AND square_customer_id = $2
        `, [merchantId, customerId]);

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            id: row.id,
            givenName: row.given_name,
            familyName: row.family_name,
            displayName: row.display_name || [row.given_name, row.family_name].filter(Boolean).join(' '),
            phone: row.phone,
            email: row.email,
            companyName: row.company_name,
            totalOrders: row.total_orders,
            totalRewardsEarned: row.total_rewards_earned,
            hasActiveRewards: row.has_active_rewards,
            cached: true,
            lastUpdatedAt: row.last_updated_at
        };
    } catch (error) {
        logger.warn('Error fetching cached customer', { error: error.message, customerId });
        return null;
    }
}

/**
 * Search customers in local cache by phone, email, or name
 * @param {string} query - Search query
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Array>} Matching customers
 */
async function searchCachedCustomers(query, merchantId) {
    if (!query || !merchantId) return [];

    try {
        const normalizedQuery = query.replace(/[\s\-\(\)\.]/g, '');
        const isPhoneSearch = /^\+?\d{7,}$/.test(normalizedQuery);
        const isEmailSearch = query.includes('@');

        let sql, params;

        if (isPhoneSearch) {
            // Phone search - normalize and match
            const phonePattern = normalizedQuery.startsWith('+') ? normalizedQuery : `%${normalizedQuery}%`;
            sql = `
                SELECT square_customer_id as id, given_name, family_name, display_name,
                       phone_number as phone, email_address as email
                FROM loyalty_customers
                WHERE merchant_id = $1
                  AND REPLACE(REPLACE(REPLACE(REPLACE(phone_number, ' ', ''), '-', ''), '(', ''), ')', '') LIKE $2
                LIMIT 20
            `;
            params = [merchantId, phonePattern];
        } else if (isEmailSearch) {
            sql = `
                SELECT square_customer_id as id, given_name, family_name, display_name,
                       phone_number as phone, email_address as email
                FROM loyalty_customers
                WHERE merchant_id = $1
                  AND LOWER(email_address) LIKE LOWER($2)
                LIMIT 20
            `;
            params = [merchantId, `%${query}%`];
        } else {
            // Name search
            sql = `
                SELECT square_customer_id as id, given_name, family_name, display_name,
                       phone_number as phone, email_address as email
                FROM loyalty_customers
                WHERE merchant_id = $1
                  AND (
                      LOWER(display_name) LIKE LOWER($2)
                      OR LOWER(given_name) LIKE LOWER($2)
                      OR LOWER(family_name) LIKE LOWER($2)
                  )
                LIMIT 20
            `;
            params = [merchantId, `%${query}%`];
        }

        const result = await db.query(sql, params);

        return result.rows.map(row => ({
            id: row.id,
            givenName: row.given_name,
            familyName: row.family_name,
            displayName: row.display_name || [row.given_name, row.family_name].filter(Boolean).join(' ') || 'Unknown',
            phone: row.phone,
            email: row.email,
            cached: true
        }));
    } catch (error) {
        logger.warn('Error searching cached customers', { error: error.message, query });
        return [];
    }
}

/**
 * Update customer stats after loyalty activity
 * @param {string} customerId - Square customer ID
 * @param {number} merchantId - Merchant ID
 * @param {Object} stats - Stats to update
 * @param {boolean} [stats.incrementOrders] - Increment order count
 * @param {boolean} [stats.incrementRewards] - Increment rewards earned count
 * @param {boolean} [stats.hasActiveRewards] - Set active rewards flag
 */
async function updateCustomerStats(customerId, merchantId, stats = {}) {
    if (!customerId || !merchantId) return;

    try {
        const updates = [];
        const values = [merchantId, customerId];
        let paramIndex = 3;

        if (stats.incrementOrders) {
            updates.push(`total_orders = total_orders + 1`);
            updates.push(`last_order_at = NOW()`);
        }
        if (stats.incrementRewards) {
            updates.push(`total_rewards_earned = total_rewards_earned + 1`);
        }
        if (typeof stats.hasActiveRewards === 'boolean') {
            updates.push(`has_active_rewards = $${paramIndex++}`);
            values.push(stats.hasActiveRewards);
        }

        if (updates.length > 0) {
            updates.push(`last_updated_at = NOW()`);
            await db.query(`
                UPDATE loyalty_customers
                SET ${updates.join(', ')}
                WHERE merchant_id = $1 AND square_customer_id = $2
            `, values);
        }
    } catch (error) {
        logger.warn('Failed to update customer stats', { error: error.message, customerId });
    }
}

module.exports = {
    cacheCustomerDetails,
    getCachedCustomer,
    searchCachedCustomers,
    updateCustomerStats
};
