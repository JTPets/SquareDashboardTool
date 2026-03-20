/**
 * Response Helper Utilities
 * Standardizes API response format across routes (BACKLOG-3)
 *
 * Standard format:
 * - Success: { success: true, ...data }  (flat merge for objects)
 * - Error: { success: false, error: 'message', code: 'ERROR_CODE' }
 *
 * // LOGIC CHANGE: sendSuccess uses flat merge (not data wrapping) to preserve
 * // existing response shapes while adding success: true consistently.
 */

/**
 * Send a success response. Object data is flat-merged with { success: true };
 * non-object data (arrays, primitives) is wrapped in { success: true, data }.
 * @param {Object} res - Express response object
 * @param {Object|Array|*} data - Response data
 * @param {number} [statusCode=200] - HTTP status code
 */
function sendSuccess(res, data, statusCode = 200) {
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        res.status(statusCode).json({ success: true, ...data });
    } else {
        res.status(statusCode).json({ success: true, data });
    }
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
 * Send a paginated success response
 * @param {Object} res - Express response object
 * @param {Object} data - Response data object (items + metadata)
 * @param {number} [statusCode=200] - HTTP status code
 */
function sendPaginated(res, data, statusCode = 200) {
    res.status(statusCode).json({ success: true, ...data });
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
    sendPaginated,
    ErrorCodes
};
