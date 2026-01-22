/**
 * Tests for application error classes
 */

const {
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
} = require('../../utils/app-error');

describe('AppError', () => {
    it('should create an error with message and default status 500', () => {
        const error = new AppError('Something went wrong');

        expect(error.message).toBe('Something went wrong');
        expect(error.statusCode).toBe(500);
        expect(error.code).toBeNull();
        expect(error.isOperational).toBe(true);
        expect(error instanceof Error).toBe(true);
    });

    it('should create an error with custom status code', () => {
        const error = new AppError('Custom error', 418);

        expect(error.statusCode).toBe(418);
    });

    it('should create an error with custom code', () => {
        const error = new AppError('Coded error', 400, 'CUSTOM_CODE');

        expect(error.code).toBe('CUSTOM_CODE');
    });

    it('should have a stack trace', () => {
        const error = new AppError('Stack test');

        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('Stack test');
    });
});

describe('BadRequestError', () => {
    it('should have status 400 and BAD_REQUEST code', () => {
        const error = new BadRequestError();

        expect(error.statusCode).toBe(400);
        expect(error.code).toBe('BAD_REQUEST');
        expect(error.message).toBe('Invalid request');
    });

    it('should accept custom message', () => {
        const error = new BadRequestError('Missing required field');

        expect(error.message).toBe('Missing required field');
    });
});

describe('UnauthorizedError', () => {
    it('should have status 401 and UNAUTHORIZED code', () => {
        const error = new UnauthorizedError();

        expect(error.statusCode).toBe(401);
        expect(error.code).toBe('UNAUTHORIZED');
        expect(error.message).toBe('Authentication required');
    });
});

describe('ForbiddenError', () => {
    it('should have status 403 and FORBIDDEN code', () => {
        const error = new ForbiddenError();

        expect(error.statusCode).toBe(403);
        expect(error.code).toBe('FORBIDDEN');
        expect(error.message).toBe('Access denied');
    });
});

describe('NotFoundError', () => {
    it('should have status 404 and NOT_FOUND code', () => {
        const error = new NotFoundError();

        expect(error.statusCode).toBe(404);
        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).toBe('Resource not found');
    });

    it('should accept custom message', () => {
        const error = new NotFoundError('Item not found');

        expect(error.message).toBe('Item not found');
    });
});

describe('ConflictError', () => {
    it('should have status 409 and CONFLICT code', () => {
        const error = new ConflictError();

        expect(error.statusCode).toBe(409);
        expect(error.code).toBe('CONFLICT');
        expect(error.message).toBe('Resource conflict');
    });
});

describe('ValidationError', () => {
    it('should have status 422 and VALIDATION_ERROR code', () => {
        const error = new ValidationError();

        expect(error.statusCode).toBe(422);
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toBe('Validation failed');
    });

    it('should include validation errors array', () => {
        const errors = [
            { field: 'email', message: 'Invalid email' },
            { field: 'name', message: 'Name is required' }
        ];
        const error = new ValidationError('Invalid input', errors);

        expect(error.errors).toEqual(errors);
    });
});

describe('RateLimitError', () => {
    it('should have status 429 and RATE_LIMITED code', () => {
        const error = new RateLimitError();

        expect(error.statusCode).toBe(429);
        expect(error.code).toBe('RATE_LIMITED');
        expect(error.message).toBe('Too many requests');
    });

    it('should include retryAfter value', () => {
        const error = new RateLimitError('Slow down', 60);

        expect(error.retryAfter).toBe(60);
    });
});

describe('ExternalServiceError', () => {
    it('should have status 502 and EXTERNAL_SERVICE_ERROR code', () => {
        const error = new ExternalServiceError();

        expect(error.statusCode).toBe(502);
        expect(error.code).toBe('EXTERNAL_SERVICE_ERROR');
        expect(error.service).toBe('unknown');
    });

    it('should include service name', () => {
        const error = new ExternalServiceError('Square API failed', 'Square');

        expect(error.service).toBe('Square');
        expect(error.message).toBe('Square API failed');
    });
});

describe('ServiceUnavailableError', () => {
    it('should have status 503 and SERVICE_UNAVAILABLE code', () => {
        const error = new ServiceUnavailableError();

        expect(error.statusCode).toBe(503);
        expect(error.code).toBe('SERVICE_UNAVAILABLE');
        expect(error.message).toBe('Service temporarily unavailable');
    });
});

describe('Error inheritance', () => {
    it('all errors should be instances of AppError', () => {
        expect(new BadRequestError()).toBeInstanceOf(AppError);
        expect(new UnauthorizedError()).toBeInstanceOf(AppError);
        expect(new ForbiddenError()).toBeInstanceOf(AppError);
        expect(new NotFoundError()).toBeInstanceOf(AppError);
        expect(new ConflictError()).toBeInstanceOf(AppError);
        expect(new ValidationError()).toBeInstanceOf(AppError);
        expect(new RateLimitError()).toBeInstanceOf(AppError);
        expect(new ExternalServiceError()).toBeInstanceOf(AppError);
        expect(new ServiceUnavailableError()).toBeInstanceOf(AppError);
    });

    it('all errors should be instances of Error', () => {
        expect(new BadRequestError()).toBeInstanceOf(Error);
        expect(new NotFoundError()).toBeInstanceOf(Error);
    });

    it('all errors should be operational', () => {
        expect(new BadRequestError().isOperational).toBe(true);
        expect(new NotFoundError().isOperational).toBe(true);
        expect(new ValidationError().isOperational).toBe(true);
    });
});
