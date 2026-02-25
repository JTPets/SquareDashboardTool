/**
 * Jest Configuration
 * @type {import('jest').Config}
 */
module.exports = {
    // Test environment
    testEnvironment: 'node',

    // Test file patterns
    testMatch: [
        '**/__tests__/**/*.test.js',
        '**/*.test.js'
    ],

    // Ignore patterns
    testPathIgnorePatterns: [
        '/node_modules/',
        '/public/',
        '/storage/'
    ],

    // Coverage configuration
    collectCoverageFrom: [
        'utils/**/*.js',
        'middleware/**/*.js',
        'routes/**/*.js',
        'services/**/*.js',
        '!**/node_modules/**',
        '!**/__tests__/**'
    ],

    // Coverage thresholds - only enforce on tested files
    // Global thresholds disabled until more tests are written
    coverageThreshold: {
        // Security utilities - high coverage required
        './utils/password.js': {
            branches: 80,
            functions: 100,
            lines: 90,
            statements: 90
        },
        './utils/token-encryption.js': {
            branches: 100,
            functions: 100,
            lines: 100,
            statements: 100
        },
        // Authentication middleware - critical access control
        './middleware/auth.js': {
            branches: 70,
            functions: 80,
            lines: 80,
            statements: 80
        },
        // Merchant middleware - multi-tenant isolation (some functions need DB mocking)
        './middleware/merchant.js': {
            branches: 20,
            functions: 40,
            lines: 25,
            statements: 25
        },
        // Directory aggregate thresholds — ratchet up as coverage improves (Ref: REMEDIATION-PLAN T-5)
        // Current: services ~14%, routes ~2.5%. Targets: services 30%, routes 20%
        './services/': {
            branches: 8,
            functions: 10,
            lines: 10,
            statements: 10
        },
        './routes/': {
            branches: 1,
            functions: 0,
            lines: 2,
            statements: 2
        }
    },

    // Coverage reporters
    coverageReporters: ['text', 'text-summary', 'html', 'lcov'],

    // Coverage directory
    coverageDirectory: 'coverage',

    // Setup files to run before each test
    setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],

    // Timeout for async tests (10 seconds)
    testTimeout: 10000,

    // Verbose output
    verbose: true,

    // Clear mocks between tests
    clearMocks: true,

    // Restore mocks after each test
    restoreMocks: true,

    // Module directories
    moduleDirectories: ['node_modules', '<rootDir>'],

    // Transform settings (no transform needed for pure Node.js)
    transform: {},

    // Reporter for CI environments
    reporters: process.env.CI
        ? ['default', 'jest-junit']
        : ['default'],
};
