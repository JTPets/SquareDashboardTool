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
        '!**/node_modules/**',
        '!**/__tests__/**'
    ],

    // Coverage thresholds - start low, increase over time
    coverageThreshold: {
        global: {
            branches: 20,
            functions: 20,
            lines: 20,
            statements: 20
        },
        // Critical files should have higher coverage
        './utils/password.js': {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80
        },
        './utils/token-encryption.js': {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80
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
