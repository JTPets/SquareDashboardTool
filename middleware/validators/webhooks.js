/**
 * Webhook Route Validators
 *
 * Validates input for webhook management endpoints
 */

const { body, param } = require('express-validator');
const { handleValidationErrors, validateOptionalArray, validateOptionalBoolean, validateOptionalString } = require('./index');

/**
 * Validate URL format
 */
const validateUrl = (fieldName) =>
    body(fieldName)
        .trim()
        .notEmpty()
        .withMessage(`${fieldName} is required`)
        .isURL({ protocols: ['http', 'https'], require_protocol: true })
        .withMessage(`${fieldName} must be a valid URL with http or https protocol`);

/**
 * Validate optional URL format
 */
const validateOptionalUrl = (fieldName) =>
    body(fieldName)
        .optional()
        .trim()
        .isURL({ protocols: ['http', 'https'], require_protocol: true })
        .withMessage(`${fieldName} must be a valid URL with http or https protocol if provided`);

/**
 * Validate subscription ID parameter
 */
const validateSubscriptionId = param('subscriptionId')
    .trim()
    .notEmpty()
    .withMessage('subscriptionId is required')
    .isLength({ min: 1, max: 100 })
    .withMessage('subscriptionId must be 1-100 characters');

/**
 * Validate event types array
 */
const validateEventTypes = body('eventTypes')
    .optional()
    .isArray()
    .withMessage('eventTypes must be an array')
    .custom((value) => {
        if (value && value.length > 0) {
            // Check each event type is a non-empty string
            for (const eventType of value) {
                if (typeof eventType !== 'string' || !eventType.trim()) {
                    throw new Error('Each event type must be a non-empty string');
                }
                // Basic format check: should contain a dot (e.g., 'order.created')
                if (!eventType.includes('.')) {
                    throw new Error(`Invalid event type format: ${eventType}`);
                }
            }
        }
        return true;
    });

/**
 * POST /api/webhooks/register
 */
const register = [
    validateUrl('notificationUrl'),
    validateEventTypes,
    validateOptionalString('name', { maxLength: 200 }),
    handleValidationErrors
];

/**
 * POST /api/webhooks/ensure
 */
const ensure = [
    validateUrl('notificationUrl'),
    validateEventTypes,
    validateOptionalBoolean('updateIfExists'),
    handleValidationErrors
];

/**
 * PUT /api/webhooks/subscriptions/:subscriptionId
 */
const update = [
    validateSubscriptionId,
    validateOptionalBoolean('enabled'),
    validateEventTypes,
    validateOptionalUrl('notificationUrl'),
    validateOptionalString('name', { maxLength: 200 }),
    handleValidationErrors
];

/**
 * DELETE /api/webhooks/subscriptions/:subscriptionId
 */
const deleteSubscription = [
    validateSubscriptionId,
    handleValidationErrors
];

/**
 * POST /api/webhooks/subscriptions/:subscriptionId/test
 */
const test = [
    validateSubscriptionId,
    handleValidationErrors
];

module.exports = {
    register,
    ensure,
    update,
    deleteSubscription,
    test,
    // Export individual validators for reuse
    validateUrl,
    validateOptionalUrl,
    validateSubscriptionId,
    validateEventTypes
};
