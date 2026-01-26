/**
 * Auth Route Validators
 * Validation middleware for authentication routes
 */

const { body, param, query } = require('express-validator');
const {
    handleValidationErrors,
    validateEmail,
    validateOptionalString,
    validateOptionalBoolean,
    validateIntId
} = require('./index');
const { validatePassword: checkPasswordStrength } = require('../../utils/password');

// Valid user roles
const VALID_ROLES = ['admin', 'user', 'readonly'];

/**
 * Custom validator for password strength
 * Uses the existing password validation utility
 */
const validatePasswordStrength = (fieldName) =>
    body(fieldName)
        .custom((value) => {
            const validation = checkPasswordStrength(value);
            if (!validation.valid) {
                throw new Error(validation.errors.join('. '));
            }
            return true;
        });

/**
 * Custom validator for optional password with strength check
 */
const validateOptionalPasswordStrength = (fieldName) =>
    body(fieldName)
        .optional()
        .custom((value) => {
            const validation = checkPasswordStrength(value);
            if (!validation.valid) {
                throw new Error(validation.errors.join('. '));
            }
            return true;
        });

/**
 * Validate reset token (body field)
 * Token is a 64-character hex string (32 bytes)
 */
const validateResetToken = () =>
    body('token')
        .trim()
        .notEmpty()
        .withMessage('Token is required')
        .isHexadecimal()
        .withMessage('Token must be a valid hex string')
        .isLength({ min: 64, max: 64 })
        .withMessage('Token must be 64 characters');

/**
 * Validate reset token (query parameter)
 */
const validateResetTokenQuery = () =>
    query('token')
        .trim()
        .notEmpty()
        .withMessage('Token is required')
        .isHexadecimal()
        .withMessage('Token must be a valid hex string')
        .isLength({ min: 64, max: 64 })
        .withMessage('Token must be 64 characters');

// ==================== LOGIN/LOGOUT ====================

/**
 * POST /api/auth/login
 * Requires email and password
 */
const login = [
    validateEmail('email'),
    body('password')
        .notEmpty()
        .withMessage('Password is required'),
    handleValidationErrors
];

// POST /api/auth/logout - No validation needed
// GET /api/auth/me - No validation needed

// ==================== CHANGE PASSWORD ====================

/**
 * POST /api/auth/change-password
 * Requires current password and new password with strength check
 */
const changePassword = [
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
    validatePasswordStrength('newPassword'),
    handleValidationErrors
];

// ==================== ADMIN USER MANAGEMENT ====================

// GET /api/auth/users - No validation needed (admin-protected)

/**
 * POST /api/auth/users
 * Create new user - email required, name/role/password optional
 */
const createUser = [
    validateEmail('email'),
    validateOptionalString('name', { maxLength: 255 }),
    body('role')
        .optional()
        .isIn(VALID_ROLES)
        .withMessage(`Role must be one of: ${VALID_ROLES.join(', ')}`),
    validateOptionalPasswordStrength('password'),
    handleValidationErrors
];

/**
 * PUT /api/auth/users/:id
 * Update user - name/role/is_active all optional
 */
const updateUser = [
    validateIntId('id'),
    validateOptionalString('name', { maxLength: 255 }),
    body('role')
        .optional()
        .isIn(VALID_ROLES)
        .withMessage(`Role must be one of: ${VALID_ROLES.join(', ')}`),
    validateOptionalBoolean('is_active'),
    handleValidationErrors
];

/**
 * POST /api/auth/users/:id/reset-password
 * Admin password reset - newPassword optional (generates if not provided)
 */
const resetUserPassword = [
    validateIntId('id'),
    validateOptionalPasswordStrength('newPassword'),
    handleValidationErrors
];

/**
 * POST /api/auth/users/:id/unlock
 * Unlock user account - just needs valid user ID
 */
const unlockUser = [
    validateIntId('id'),
    handleValidationErrors
];

// ==================== PASSWORD RESET (PUBLIC) ====================

/**
 * POST /api/auth/forgot-password
 * Request password reset - just needs email
 */
const forgotPassword = [
    validateEmail('email'),
    handleValidationErrors
];

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
const resetPassword = [
    validateResetToken(),
    validatePasswordStrength('newPassword'),
    handleValidationErrors
];

/**
 * GET /api/auth/verify-reset-token
 * Verify reset token validity
 */
const verifyResetToken = [
    validateResetTokenQuery(),
    handleValidationErrors
];

module.exports = {
    login,
    changePassword,
    createUser,
    updateUser,
    resetUserPassword,
    unlockUser,
    forgotPassword,
    resetPassword,
    verifyResetToken,
    // Constants exported for tests
    VALID_ROLES
};
