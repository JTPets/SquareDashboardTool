/**
 * Response Helper Utilities
 * Standardizes API response format across routes
 *
 * Standard format:
 * - Success: { success: true, data: { ... } }
 * - Error: { success: false, error: 'message', code: 'ERROR_CODE' }
 */

/**
 * Send a success response
 * @param {Object} res - Express response object
 * @param {Object} data - Response data
 * @param {number} [statusCode=200] - HTTP status code
 */
function sendSuccess(res, data, statusCode = 200) {
    res.status(statusCode).json({
        success: true,
        data
    });
}

/**
 * Send an error response
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 * @param {number} [statusCode=400] - HTTP status code
 * @param {string} [code] - Error code for client handling
 */
function sendError(res, message, statusCode = 400, code = null) {
    const response = {
        success: false,
        error: message
    };
    if (code) {
        response.code = code;
    }
    res.status(statusCode).json(response);
}

/**
 * Error codes for common scenarios
 */
const ErrorCodes = {
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    CONFLICT: 'CONFLICT',
    EXTERNAL_API_ERROR: 'EXTERNAL_API_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
};

module.exports = {
    sendSuccess,
    sendError,
    ErrorCodes
};
