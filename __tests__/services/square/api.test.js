/**
 * Square API Shim Tests
 *
 * Tests for the backward-compatibility re-export shim (api.js).
 * Validates that all sub-module exports are correctly re-exported.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/token-encryption', () => ({
    decryptToken: jest.fn(),
    isEncryptedToken: jest.fn(),
    encryptToken: jest.fn(),
}));

jest.mock('../../../utils/idempotency', () => ({
    generateIdempotencyKey: jest.fn(),
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { API_VERSION: '2024-01-01', MAX_PAGINATION_ITERATIONS: 500 },
    SYNC: { SALES_VELOCITY_DAYS: 91, CATALOG_BATCH_SIZE: 100, INVENTORY_BATCH_SIZE: 100, BATCH_DELAY_MS: 100, INTER_BATCH_DELAY_MS: 200, NEW_VARIATION_DAYS: 7 },
    RETRY: { MAX_ATTEMPTS: 3, BASE_DELAY_MS: 1000, MAX_DELAY_MS: 30000 },
    CACHE: { INVOICES_SCOPE_TTL_MS: 3600000, CUSTOMER_CACHE_TTL_MS: 300000 },
    TIME: { ONE_HOUR_MS: 3600000, ONE_DAY_MS: 86400000, ONE_WEEK_MS: 604800000 },
    INTERVALS: { REVIEW_LOOKBACK_DAYS: 30, EXPIRY_REVIEW_MIN_DAYS: 90, EXPIRY_REVIEW_MAX_DAYS: 120 },
    SENIORS_DISCOUNT: { MIN_AGE: 60 },
}));

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

const api = require('../../../services/square/api');

describe('Square API Shim (api.js)', () => {
    // ==================== Re-exported Functions ====================
    describe('re-exports all sub-module functions', () => {
        const expectedExports = [
            // Shared infrastructure
            'getMerchantToken',
            'makeSquareRequest',
            'generateIdempotencyKey',
            // Locations
            'syncLocations',
            // Vendors
            'syncVendors',
            'ensureVendorsExist',
            // Catalog sync
            'syncCatalog',
            'deltaSyncCatalog',
            // Inventory
            'syncInventory',
            'getSquareInventoryCount',
            'setSquareInventoryCount',
            'setSquareInventoryAlertThreshold',
            'syncCommittedInventory',
            // Sales velocity
            'syncSalesVelocity',
            'syncSalesVelocityAllPeriods',
            'updateSalesVelocityFromOrder',
            // Orchestration
            'fullSync',
            // Diagnostics
            'fixLocationMismatches',
            'fixInventoryAlerts',
            'enableItemAtAllLocations',
            // Custom attributes
            'listCustomAttributeDefinitions',
            'upsertCustomAttributeDefinition',
            'updateCustomAttributeValues',
            'batchUpdateCustomAttributeValues',
            'initializeCustomAttributes',
            'pushCasePackToSquare',
            'pushBrandsToSquare',
            'pushExpiryDatesToSquare',
            'deleteCustomAttributeDefinition',
            // Pricing
            'batchUpdateVariationPrices',
            'updateVariationCost',
            'batchUpdateCatalogContent',
            // Lifecycle
            'cleanup',
        ];

        for (const name of expectedExports) {
            test(`exports ${name}`, () => {
                expect(api).toHaveProperty(name);
                expect(typeof api[name]).toBe('function');
            });
        }
    });

    // ==================== cleanup ====================
    describe('cleanup', () => {
        test('calls cleanupInventory without throwing', () => {
            expect(() => api.cleanup()).not.toThrow();
        });
    });
});
