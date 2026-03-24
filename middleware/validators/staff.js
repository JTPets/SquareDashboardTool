'use strict';

/**
 * Staff Route Validators — BACKLOG-41
 */

const { body, query } = require('express-validator');
const { handleValidationErrors, validateIntId } = require('./index');

const ALLOWED_ROLES = ['manager', 'clerk', 'readonly'];

const inviteStaff = [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),
    body('role')
        .isIn(ALLOWED_ROLES)
        .withMessage(`role must be one of: ${ALLOWED_ROLES.join(', ')}`),
    handleValidationErrors
];

const acceptInvitation = [
    body('token')
        .isString()
        .trim()
        .notEmpty()
        .withMessage('token is required'),
    body('password')
        .optional()
        .isString()
        .isLength({ min: 8 })
        .withMessage('password must be at least 8 characters if provided'),
    handleValidationErrors
];

const removeStaff = [
    validateIntId('userId'),
    handleValidationErrors
];

const changeRole = [
    validateIntId('userId'),
    body('role')
        .isIn(ALLOWED_ROLES)
        .withMessage(`role must be one of: ${ALLOWED_ROLES.join(', ')}`),
    handleValidationErrors
];

const validateTokenQuery = [
    query('token')
        .isString()
        .trim()
        .notEmpty()
        .withMessage('token query parameter is required'),
    handleValidationErrors
];

const cancelInvitation = [
    validateIntId('id'),
    handleValidationErrors
];

module.exports = { inviteStaff, acceptInvitation, removeStaff, changeRole, validateTokenQuery, cancelInvitation };
