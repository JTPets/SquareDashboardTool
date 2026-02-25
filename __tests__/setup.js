/**
 * Jest Test Setup
 * This file runs before each test file
 */

// Set test environment
process.env.NODE_ENV = 'test';

// Set a test encryption key (32 bytes = 64 hex chars)
// This is only for testing - production uses a different key
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

// Set session secret for tests
process.env.SESSION_SECRET = 'test-session-secret-for-jest-tests';

// Disable logging during tests to reduce noise
// Comment out these lines if you need to debug tests
jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// Mock email notifier to prevent real emails during tests
jest.mock('../utils/email-notifier', () => ({
    sendCritical: jest.fn().mockResolvedValue(),
    sendAlert: jest.fn().mockResolvedValue(),
    sendInfo: jest.fn().mockResolvedValue(),
    enabled: false,
}));

// Mock database to prevent actual PostgreSQL connections during tests
// Individual tests can override this mock as needed
jest.mock('../utils/database', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn().mockImplementation(async (fn) => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        return fn(mockClient);
    }),
    getClient: jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
    }),
    pool: {
        end: jest.fn().mockResolvedValue()
    }
}));

// Global timeout for async operations
jest.setTimeout(10000);

// Clean up after all tests
afterAll(async () => {
    // Allow time for any pending async operations to complete
    await new Promise(resolve => setTimeout(resolve, 100));
});
