/**
 * Centralized configuration constants
 * Replaces magic numbers scattered throughout the codebase
 */

module.exports = {
    // Retry configuration for external API calls
    RETRY: {
        MAX_ATTEMPTS: 3,
        BASE_DELAY_MS: 1000,
        MAX_DELAY_MS: 30000,
    },

    // Cache TTL settings (in milliseconds)
    CACHE: {
        INVOICES_SCOPE_TTL_MS: 60 * 60 * 1000,      // 1 hour
        CUSTOMER_CACHE_TTL_MS: 5 * 60 * 1000,       // 5 minutes
    },

    // Session configuration
    SESSION: {
        DEFAULT_DURATION_HOURS: 24,
        TOKEN_EXPIRY_HOURS: 1,                       // Password reset tokens
        PASSWORD_RESET_EXPIRY_HOURS: 24,
    },

    // Pagination defaults
    PAGINATION: {
        DEFAULT_LIMIT: 100,
        MAX_LIMIT: 1000,
    },

    // Sync operation settings
    SYNC: {
        SALES_VELOCITY_DAYS: 91,
        CATALOG_BATCH_SIZE: 100,
        INVENTORY_BATCH_SIZE: 100,
        BATCH_DELAY_MS: 100,                         // Delay between batches to avoid rate limiting
        INTER_BATCH_DELAY_MS: 200,                   // Delay for write operations
        NEW_VARIATION_DAYS: 7,                        // Variations younger than this show velocity warning
    },

    // Time intervals (in milliseconds)
    TIME: {
        ONE_HOUR_MS: 60 * 60 * 1000,
        ONE_DAY_MS: 24 * 60 * 60 * 1000,
        ONE_WEEK_MS: 7 * 24 * 60 * 60 * 1000,
    },

    // Time intervals for SQL queries (in days)
    INTERVALS: {
        REVIEW_LOOKBACK_DAYS: 30,                    // How long before requiring re-review
        EXPIRY_REVIEW_MIN_DAYS: 90,                  // Minimum days out for review items
        EXPIRY_REVIEW_MAX_DAYS: 120,                 // Maximum days out for review items
    },

    // Rate limiting tiers (configured in middleware/security.js)
    RATE_LIMITS: {
        DELIVERY_REQUESTS: 30,
        DELIVERY_WINDOW_MINUTES: 5,
        DELIVERY_STRICT_REQUESTS: 10,
        SENSITIVE_OP_REQUESTS: 5,
        SENSITIVE_OP_WINDOW_MINUTES: 15,
    },

    // Database pool configuration
    DATABASE: {
        MAX_POOL_SIZE: 20,
        IDLE_TIMEOUT_MS: 30000,
        CONNECTION_TIMEOUT_MS: 2000,
        CLIENT_CHECKOUT_WARNING_MS: 5000,            // Warn if client held > 5 seconds
        SLOW_QUERY_THRESHOLD_MS: 1000,               // Log queries > 1 second
    },

    // Seniors Day discount configuration
    // Monthly discount program for customers aged 60+ with DOB on file
    SENIORS_DISCOUNT: {
        MIN_AGE: 60,
        DISCOUNT_PERCENT: 10,
        GROUP_NAME: 'Seniors 60 Plus',
        DISCOUNT_NAME: 'Seniors Day 10 Percent Off',
        DAY_OF_MONTH: 1,  // 1st of every month
    },
};
