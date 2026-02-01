/**
 * Seniors Discount Service
 *
 * Manages the Seniors Day discount program via Square Customer Groups.
 * - Creates/manages Square customer group for seniors (60+)
 * - Creates/manages catalog discount and pricing rule
 * - Handles customer birthday updates from webhooks
 * - Manages group membership based on age eligibility
 */

const crypto = require('crypto');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { SENIORS_DISCOUNT } = require('../../config/constants');
const { LoyaltySquareClient } = require('../loyalty/square-client');
const { calculateAge, isSenior, parseBirthday, formatBirthday } = require('./age-calculator');

/**
 * SeniorsService - Manages seniors discount for a merchant
 */
class SeniorsService {
    /**
     * @param {number} merchantId - Internal merchant ID
     */
    constructor(merchantId) {
        this.merchantId = merchantId;
        this.squareClient = null;
        this.config = null;
    }

    /**
     * Initialize the service - must be called before other operations
     * @returns {Promise<SeniorsService>}
     */
    async initialize() {
        this.squareClient = new LoyaltySquareClient(this.merchantId);
        await this.squareClient.initialize();

        // Load existing config if any
        await this.loadConfig();

        return this;
    }

    /**
     * Load configuration from database
     * @private
     */
    async loadConfig() {
        const result = await db.query(
            `SELECT * FROM seniors_discount_config WHERE merchant_id = $1`,
            [this.merchantId]
        );

        this.config = result.rows[0] || null;
    }

    /**
     * Get current configuration
     * @returns {Object|null}
     */
    getConfig() {
        return this.config;
    }

    /**
     * Set up all Square objects for seniors discount (one-time setup)
     * Creates: customer group, discount object, product set, pricing rule
     * @returns {Promise<Object>} Created config
     */
    async setupSquareObjects() {
        logger.info('Setting up seniors discount Square objects', {
            merchantId: this.merchantId,
        });

        // Check if already set up
        if (this.config?.square_group_id && this.config?.square_discount_id) {
            logger.info('Seniors discount already configured', {
                merchantId: this.merchantId,
                groupId: this.config.square_group_id,
                discountId: this.config.square_discount_id,
            });
            return this.config;
        }

        const results = {
            square_group_id: this.config?.square_group_id || null,
            square_discount_id: this.config?.square_discount_id || null,
            square_product_set_id: this.config?.square_product_set_id || null,
            square_pricing_rule_id: this.config?.square_pricing_rule_id || null,
        };

        // Step 1: Create customer group
        if (!results.square_group_id) {
            const group = await this.createSeniorsGroup();
            results.square_group_id = group.id;
        }

        // Step 2: Create catalog objects (discount, product set, pricing rule)
        if (!results.square_discount_id) {
            const catalogObjects = await this.createCatalogObjects(results.square_group_id);
            results.square_discount_id = catalogObjects.discountId;
            results.square_product_set_id = catalogObjects.productSetId;
            results.square_pricing_rule_id = catalogObjects.pricingRuleId;
        }

        // Step 3: Save configuration to database
        await this.saveConfig(results);

        // Log audit entry
        await this.logAudit('SETUP_COMPLETE', null, {
            groupId: results.square_group_id,
            discountId: results.square_discount_id,
            productSetId: results.square_product_set_id,
            pricingRuleId: results.square_pricing_rule_id,
        }, 'MANUAL');

        logger.info('Seniors discount setup complete', {
            merchantId: this.merchantId,
            ...results,
        });

        return this.config;
    }

    /**
     * Create the seniors customer group in Square
     * @private
     * @returns {Promise<Object>} Created group
     */
    async createSeniorsGroup() {
        const idempotencyKey = `seniors-group-${this.merchantId}-${Date.now()}`;

        logger.info('Creating seniors customer group', {
            merchantId: this.merchantId,
            groupName: SENIORS_DISCOUNT.GROUP_NAME,
        });

        const group = await this.squareClient.createCustomerGroup(
            SENIORS_DISCOUNT.GROUP_NAME,
            idempotencyKey
        );

        logger.info('Seniors customer group created', {
            merchantId: this.merchantId,
            groupId: group.id,
            groupName: group.name,
        });

        return group;
    }

    /**
     * Create catalog objects: discount, product set, and pricing rule
     * @private
     * @param {string} groupId - Seniors customer group ID
     * @returns {Promise<Object>} Created object IDs
     */
    async createCatalogObjects(groupId) {
        const idempotencyKey = `seniors-catalog-${this.merchantId}-${Date.now()}`;

        // Temporary IDs for batch upsert (Square replaces with real IDs)
        const discountTempId = '#seniors-discount';
        const productSetTempId = '#seniors-all-items';
        const pricingRuleTempId = '#seniors-pricing-rule';

        const objects = [
            // Discount object (10% off)
            {
                type: 'DISCOUNT',
                id: discountTempId,
                discount_data: {
                    name: SENIORS_DISCOUNT.DISCOUNT_NAME,
                    discount_type: 'FIXED_PERCENTAGE',
                    percentage: String(SENIORS_DISCOUNT.DISCOUNT_PERCENT),
                },
            },
            // Product set (all products)
            {
                type: 'PRODUCT_SET',
                id: productSetTempId,
                product_set_data: {
                    name: 'seniors-all-items',
                    all_products: true,
                },
            },
            // Pricing rule (ties discount to group)
            // Note: Pricing rule is created with customer_group_ids_any
            // Date constraints will be managed by enable/disable functions
            {
                type: 'PRICING_RULE',
                id: pricingRuleTempId,
                pricing_rule_data: {
                    name: 'seniors-day-discount',
                    discount_id: discountTempId,
                    match_products_id: productSetTempId,
                    customer_group_ids_any: [groupId],
                    // Start disabled - cron job will enable on 1st of month
                    // Using a past date to effectively disable
                    valid_from_date: '2020-01-01',
                    valid_until_date: '2020-01-01',
                },
            },
        ];

        logger.info('Creating seniors catalog objects', {
            merchantId: this.merchantId,
            objectCount: objects.length,
        });

        const createdObjects = await this.squareClient.batchUpsertCatalog(objects, idempotencyKey);

        // Map temp IDs to real IDs
        const idMapping = {};
        for (const obj of createdObjects) {
            if (obj.type === 'DISCOUNT') {
                idMapping.discountId = obj.id;
            } else if (obj.type === 'PRODUCT_SET') {
                idMapping.productSetId = obj.id;
            } else if (obj.type === 'PRICING_RULE') {
                idMapping.pricingRuleId = obj.id;
            }
        }

        logger.info('Seniors catalog objects created', {
            merchantId: this.merchantId,
            ...idMapping,
        });

        return idMapping;
    }

    /**
     * Save configuration to database
     * @private
     * @param {Object} config - Configuration to save
     */
    async saveConfig(config) {
        const result = await db.query(
            `INSERT INTO seniors_discount_config (
                merchant_id, square_group_id, square_discount_id,
                square_product_set_id, square_pricing_rule_id,
                discount_percent, min_age
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (merchant_id) DO UPDATE SET
                square_group_id = EXCLUDED.square_group_id,
                square_discount_id = EXCLUDED.square_discount_id,
                square_product_set_id = EXCLUDED.square_product_set_id,
                square_pricing_rule_id = EXCLUDED.square_pricing_rule_id,
                updated_at = NOW()
            RETURNING *`,
            [
                this.merchantId,
                config.square_group_id,
                config.square_discount_id,
                config.square_product_set_id,
                config.square_pricing_rule_id,
                SENIORS_DISCOUNT.DISCOUNT_PERCENT,
                SENIORS_DISCOUNT.MIN_AGE,
            ]
        );

        this.config = result.rows[0];
    }

    /**
     * Handle a customer birthday update (from webhook)
     * @param {Object} params
     * @param {string} params.squareCustomerId - Square customer ID
     * @param {string} params.birthday - Birthday in YYYY-MM-DD format
     * @returns {Promise<Object>} Result with groupChanged flag
     */
    async handleCustomerBirthdayUpdate({ squareCustomerId, birthday }) {
        const result = {
            customerId: squareCustomerId,
            birthday,
            age: null,
            isSenior: false,
            groupChanged: false,
            action: null,
        };

        if (!birthday) {
            return result;
        }

        // Ensure we have config
        if (!this.config?.square_group_id) {
            logger.warn('Seniors discount not configured for merchant', {
                merchantId: this.merchantId,
            });
            return result;
        }

        // Calculate age and check eligibility
        result.age = calculateAge(birthday);
        result.isSenior = isSenior(birthday, this.config.min_age);

        // Update birthday in loyalty_customers cache
        await this.updateCustomerBirthday(squareCustomerId, birthday);

        // Check current membership status
        const membership = await this.getMembership(squareCustomerId);
        const isCurrentlyMember = membership?.is_active === true;

        // Determine action needed
        if (result.isSenior && !isCurrentlyMember) {
            // Add to group
            await this.addCustomerToSeniorsGroup(squareCustomerId, birthday, result.age);
            result.groupChanged = true;
            result.action = 'ADDED';
        } else if (!result.isSenior && isCurrentlyMember) {
            // Remove from group (edge case: birthday corrected)
            await this.removeCustomerFromSeniorsGroup(squareCustomerId);
            result.groupChanged = true;
            result.action = 'REMOVED';
        }

        if (result.groupChanged) {
            await this.logAudit(
                result.action === 'ADDED' ? 'CUSTOMER_ADDED' : 'CUSTOMER_REMOVED',
                squareCustomerId,
                { birthday, age: result.age },
                'WEBHOOK'
            );
        }

        return result;
    }

    /**
     * Update customer birthday in loyalty_customers table
     * @private
     * @param {string} squareCustomerId
     * @param {string} birthday
     */
    async updateCustomerBirthday(squareCustomerId, birthday) {
        await db.query(
            `UPDATE loyalty_customers
             SET birthday = $1
             WHERE square_customer_id = $2 AND merchant_id = $3`,
            [birthday, squareCustomerId, this.merchantId]
        );
    }

    /**
     * Get membership record for a customer
     * @param {string} squareCustomerId
     * @returns {Promise<Object|null>}
     */
    async getMembership(squareCustomerId) {
        const result = await db.query(
            `SELECT * FROM seniors_group_members
             WHERE square_customer_id = $1 AND merchant_id = $2`,
            [squareCustomerId, this.merchantId]
        );
        return result.rows[0] || null;
    }

    /**
     * Add a customer to the seniors group
     * @param {string} squareCustomerId
     * @param {string} birthday
     * @param {number} age
     */
    async addCustomerToSeniorsGroup(squareCustomerId, birthday, age) {
        logger.info('Adding customer to seniors group', {
            merchantId: this.merchantId,
            customerId: squareCustomerId,
            age,
        });

        // Add to Square group
        await this.squareClient.addCustomerToGroup(
            squareCustomerId,
            this.config.square_group_id
        );

        // Track in database
        await db.query(
            `INSERT INTO seniors_group_members (
                merchant_id, square_customer_id, birthday, age_at_last_check, is_active
            ) VALUES ($1, $2, $3, $4, TRUE)
            ON CONFLICT (merchant_id, square_customer_id) DO UPDATE SET
                birthday = EXCLUDED.birthday,
                age_at_last_check = EXCLUDED.age_at_last_check,
                is_active = TRUE,
                added_to_group_at = NOW(),
                removed_from_group_at = NULL`,
            [this.merchantId, squareCustomerId, birthday, age]
        );
    }

    /**
     * Remove a customer from the seniors group
     * @param {string} squareCustomerId
     */
    async removeCustomerFromSeniorsGroup(squareCustomerId) {
        logger.info('Removing customer from seniors group', {
            merchantId: this.merchantId,
            customerId: squareCustomerId,
        });

        // Remove from Square group
        await this.squareClient.removeCustomerFromGroup(
            squareCustomerId,
            this.config.square_group_id
        );

        // Update database
        await db.query(
            `UPDATE seniors_group_members
             SET is_active = FALSE, removed_from_group_at = NOW()
             WHERE square_customer_id = $1 AND merchant_id = $2`,
            [squareCustomerId, this.merchantId]
        );
    }

    /**
     * Log an audit entry
     * @param {string} action
     * @param {string|null} squareCustomerId
     * @param {Object} details
     * @param {string} triggeredBy
     */
    async logAudit(action, squareCustomerId, details, triggeredBy) {
        await db.query(
            `INSERT INTO seniors_discount_audit_log
             (merchant_id, action, square_customer_id, details, triggered_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [this.merchantId, action, squareCustomerId, JSON.stringify(details), triggeredBy]
        );
    }

    /**
     * Get group member count
     * @returns {Promise<number>}
     */
    async getMemberCount() {
        const result = await db.query(
            `SELECT COUNT(*) as count FROM seniors_group_members
             WHERE merchant_id = $1 AND is_active = TRUE`,
            [this.merchantId]
        );
        return parseInt(result.rows[0].count, 10);
    }

    /**
     * Get list of group members (paginated)
     * @param {Object} options
     * @param {number} [options.limit=50]
     * @param {number} [options.offset=0]
     * @returns {Promise<Array>}
     */
    async getMembers({ limit = 50, offset = 0 } = {}) {
        const result = await db.query(
            `SELECT sgm.*, lc.given_name, lc.family_name, lc.email_address, lc.phone_number
             FROM seniors_group_members sgm
             LEFT JOIN loyalty_customers lc
                ON sgm.square_customer_id = lc.square_customer_id
                AND sgm.merchant_id = lc.merchant_id
             WHERE sgm.merchant_id = $1 AND sgm.is_active = TRUE
             ORDER BY sgm.added_to_group_at DESC
             LIMIT $2 OFFSET $3`,
            [this.merchantId, limit, offset]
        );
        return result.rows;
    }

    /**
     * Get recent audit log entries
     * @param {Object} options
     * @param {number} [options.limit=100]
     * @returns {Promise<Array>}
     */
    async getAuditLog({ limit = 100 } = {}) {
        const result = await db.query(
            `SELECT * FROM seniors_discount_audit_log
             WHERE merchant_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [this.merchantId, limit]
        );
        return result.rows;
    }
}

module.exports = { SeniorsService };
