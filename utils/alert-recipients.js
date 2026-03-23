'use strict';

/**
 * Alert Recipients Helper
 *
 * Resolves email recipients for system alerts based on user roles.
 * Uses the staff system (user_merchants) instead of hardcoded email addresses.
 *
 * Alert types:
 *   'critical'    — owner only (errors, webhook failures, security)
 *   'operational'  — owner + manager (inventory, order issues, sync failures)
 *   'info'         — owner + manager (general notifications)
 *
 * Infrastructure note: Cloudflare Email Routing / transactional sender setup
 * is a separate task. See docs/TECHNICAL_DEBT.md.
 */

const db = require('./database');
const logger = require('./logger');

/**
 * Role sets for each alert type
 */
const ALERT_ROLE_MAP = {
    critical: ['owner'],
    operational: ['owner', 'manager'],
    info: ['owner', 'manager']
};

/**
 * Get email recipients for a given merchant and alert type.
 *
 * @param {number} merchantId - Merchant ID
 * @param {string} alertType - One of 'critical', 'operational', 'info'
 * @returns {Promise<string[]>} Array of email addresses
 */
async function getAlertRecipients(merchantId, alertType) {
    if (!merchantId) return [];

    const roles = ALERT_ROLE_MAP[alertType];
    if (!roles) {
        logger.warn('Unknown alert type for recipient lookup', { alertType, merchantId });
        return [];
    }

    try {
        const result = await db.query(
            `SELECT DISTINCT u.email
             FROM user_merchants um
             JOIN users u ON u.id = um.user_id
             WHERE um.merchant_id = $1
               AND um.role = ANY($2)
               AND u.email IS NOT NULL`,
            [merchantId, roles]
        );

        return result.rows.map(r => r.email);
    } catch (error) {
        logger.error('Failed to resolve alert recipients', {
            merchantId,
            alertType,
            error: error.message
        });
        return [];
    }
}

module.exports = { getAlertRecipients, ALERT_ROLE_MAP };
