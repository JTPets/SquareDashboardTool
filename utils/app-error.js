/**
 * Application Error Classes
 *
 * Custom error classes that include HTTP status codes and user-friendly messages.
 * These errors are caught by the global error handler and returned with
 * appropriate status codes.
 */

/**
 * Base application error with status code support
 */
class AppError extends Error {
    constructor(message, statusCode = 500, code = null) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true; // Distinguishes from programming errors
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 400 Bad Request - Invalid input or parameters
 */
class BadRequestError extends AppError {
    constructor(message = 'Invalid request') {
        super(message, 400, 'BAD_REQUEST');
    }
}

/**
 * 401 Unauthorized - Authentication required
 */
class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required') {
        super(message, 401, 'UNAUTHORIZED');
    }
}

/**
 * 403 Forbidden - Insufficient permissions
 */
class ForbiddenError extends AppError {
    constructor(message = 'Access denied') {
        super(message, 403, 'FORBIDDEN');
    }
}

/**
 * 404 Not Found - Resource doesn't exist
 */
class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404, 'NOT_FOUND');
    }
}

/**
 * 409 Conflict - Resource conflict (e.g., duplicate)
 */
class ConflictError extends AppError {
    constructor(message = 'Resource conflict') {
        super(message, 409, 'CONFLICT');
    }
}

/**
 * 422 Unprocessable Entity - Validation failed
 */
class ValidationError extends AppError {
    constructor(message = 'Validation failed', errors = []) {
        super(message, 422, 'VALIDATION_ERROR');
        this.errors = errors;
    }
}

/**
 * 429 Too Many Requests - Rate limited
 */
class RateLimitError extends AppError {
    constructor(message = 'Too many requests', retryAfter = null) {
        super(message, 429, 'RATE_LIMITED');
        this.retryAfter = retryAfter;
    }
}

/**
 * 502 Bad Gateway - External service error (e.g., Square API)
 */
class ExternalServiceError extends AppError {
    constructor(message = 'External service error', service = 'unknown') {
        super(message, 502, 'EXTERNAL_SERVICE_ERROR');
        this.service = service;
    }
}

/**
 * 503 Service Unavailable - Temporary outage
 */
class ServiceUnavailableError extends AppError {
    constructor(message = 'Service temporarily unavailable') {
        super(message, 503, 'SERVICE_UNAVAILABLE');
    }
}

module.exports = {
    AppError,
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    ValidationError,
    RateLimitError,
    ExternalServiceError,
    ServiceUnavailableError
};
