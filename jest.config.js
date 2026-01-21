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

    // Coverage thresholds - only enforce on tested files
    // Global thresholds disabled until more tests are written
    coverageThreshold: {
        // Enforce high coverage on security-critical files that have tests
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
        }
        // Add more files here as tests are written:
        // './middleware/auth.js': { branches: 80, functions: 80, lines: 80, statements: 80 },
        // './routes/auth.js': { branches: 80, functions: 80, lines: 80, statements: 80 },
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
