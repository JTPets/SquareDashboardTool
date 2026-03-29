/**
 * Tests for GMC merchant-service
 * Covers: merchantApiRequest retry/rate-limit, auth delegation to google-auth (GMC-BUG-001),
 *         duplicate token listener guard, batch settings insert
 */

// Mock OAuth2 instance returned by getAuthenticatedClient
const mockOAuth2Instance = {
    setCredentials: jest.fn(),
    on: jest.fn(),
    listenerCount: jest.fn().mockReturnValue(0),
    getAccessToken: jest.fn().mockResolvedValue({ token: 'test-token' })
};

// Mock googleapis — { virtual: true } allows mocking even if module isn't installed
jest.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: jest.fn().mockImplementation(() => mockOAuth2Instance)
        }
    }
}), { virtual: true });

// Mock google-auth.js — getAuthClient now delegates to getAuthenticatedClient (GMC-BUG-001)
const mockGetAuthenticatedClient = jest.fn().mockResolvedValue(mockOAuth2Instance);
jest.mock('../../../utils/google-auth', () => ({
    getAuthenticatedClient: mockGetAuthenticatedClient
}));

// Mock fs.promises
jest.mock('fs', () => ({
    promises: {
        writeFile: jest.fn().mockResolvedValue(),
        appendFile: jest.fn().mockResolvedValue(),
        mkdir: jest.fn().mockResolvedValue()
    }
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

const merchantService = require('../../../services/gmc/merchant-service');

describe('GMC Merchant Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset OAuth2 mock defaults
        mockOAuth2Instance.listenerCount.mockReturnValue(0);
        mockOAuth2Instance.on.mockReset();
        mockOAuth2Instance.setCredentials.mockReset();
        mockOAuth2Instance.getAccessToken.mockResolvedValue({ token: 'test-token' });
        // Reset getAuthenticatedClient mock (GMC-BUG-001)
        mockGetAuthenticatedClient.mockResolvedValue(mockOAuth2Instance);
        // Reset global fetch mock
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    /**
     * Helper: set up db.query mocks for testConnection flow.
     * testConnection calls: getGmcApiSettings (1 query) → getAuthClient (delegates to google-auth)
     */
    function mockTestConnectionDeps(settings = { gmc_merchant_id: '12345' }) {
        // First query: getGmcApiSettings
        db.query.mockResolvedValueOnce({
            rows: Object.entries(settings).map(([k, v]) => ({
                setting_key: k, setting_value: v
            }))
        });
        // getAuthClient now delegates to getAuthenticatedClient (mocked globally)
    }

    describe('merchantApiRequest - rate limit handling (I-1)', () => {
        it('should retry on 429 with Retry-After header', async () => {
            mockTestConnectionDeps();

            // First call returns 429, second succeeds
            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    status: 429,
                    ok: false,
                    headers: { get: (h) => h === 'retry-after' ? '1' : null }
                })
                .mockResolvedValueOnce({
                    status: 200,
                    ok: true,
                    json: () => Promise.resolve({ accountName: 'Test Account' })
                });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API rate limited, retrying',
                expect.objectContaining({ attempt: 1, retryAfterSeconds: 1 })
            );
        });

        it('should use default 5s retry-after when header is missing', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    status: 429,
                    ok: false,
                    headers: { get: () => null }
                })
                .mockResolvedValueOnce({
                    status: 200,
                    ok: true,
                    json: () => Promise.resolve({ accountName: 'Test' })
                });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API rate limited, retrying',
                expect.objectContaining({ retryAfterSeconds: 5 })
            );
        }, 15000);

        it('should not retry on 4xx client errors (other than 429)', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 403,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'Forbidden' } })
            });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('should retry on 5xx server errors with exponential backoff', async () => {
            mockTestConnectionDeps();

            // Two 500s then success
            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    status: 500,
                    ok: false,
                    json: () => Promise.resolve({ error: { message: 'Internal Server Error' } })
                })
                .mockResolvedValueOnce({
                    status: 500,
                    ok: false,
                    json: () => Promise.resolve({ error: { message: 'Internal Server Error' } })
                })
                .mockResolvedValueOnce({
                    status: 200,
                    ok: true,
                    json: () => Promise.resolve({ accountName: 'Test' })
                });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(3);
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API server error, retrying',
                expect.objectContaining({ attempt: 1, delayMs: 1000 })
            );
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API server error, retrying',
                expect.objectContaining({ attempt: 2, delayMs: 2000 })
            );
        });

        it('should fail after max retries on persistent 429', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValue({
                status: 429,
                ok: false,
                headers: { get: (h) => h === 'retry-after' ? '1' : null }
            });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(global.fetch).toHaveBeenCalledTimes(3); // MAX_RETRIES = 3
        });
    });

    describe('getAuthClient - delegates to google-auth (GMC-BUG-001)', () => {
        it('should delegate to getAuthenticatedClient for token decryption', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ accountName: 'Test' })
            });

            await merchantService.testConnection(1);

            // Verify getAuthenticatedClient was called with the merchant ID
            expect(mockGetAuthenticatedClient).toHaveBeenCalledWith(1);
        });

        it('should use decrypted tokens (not ciphertext) via getAuthenticatedClient', async () => {
            // getAuthenticatedClient returns an oauth2 client with decrypted tokens set
            // If it were using raw DB tokens, they'd be ciphertext and Google would 401
            const clientWithDecryptedTokens = {
                ...mockOAuth2Instance,
                getAccessToken: jest.fn().mockResolvedValue({ token: 'decrypted-access-token' })
            };
            mockGetAuthenticatedClient.mockResolvedValue(clientWithDecryptedTokens);
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ accountName: 'Test' })
            });

            await merchantService.testConnection(1);

            // Verify the Bearer token used in the API call is the decrypted token
            const fetchCall = global.fetch.mock.calls[0];
            expect(fetchCall[1].headers['Authorization']).toBe('Bearer decrypted-access-token');
        });

        it('should propagate error when getAuthenticatedClient fails', async () => {
            mockGetAuthenticatedClient.mockRejectedValue(
                new Error('Not authenticated with Google. Please connect your Google Merchant Center account first.')
            );
            mockTestConnectionDeps();

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Not authenticated with Google');
        });
    });

    describe('GMC API v1 migration (BACKLOG-61)', () => {
        it('should use v1 paths for all API endpoints (not v1beta)', async () => {
            // Read the source file and verify no v1beta references remain in API paths
            const realFs = jest.requireActual('fs');
            const source = realFs.readFileSync(
                require('path').join(__dirname, '../../../services/gmc/merchant-service.js'),
                'utf8'
            );

            // Should not have any v1beta in API path strings
            const v1betaPathMatches = source.match(/\/v1beta\/accounts\//g);
            expect(v1betaPathMatches).toBeNull();

            // Should have v1 paths for all endpoint types
            expect(source).toContain('/datasources/v1/accounts/');
            expect(source).toContain('/products/v1/accounts/');
            expect(source).toContain('/accounts/v1/accounts/');
        });

        it('testConnection should use /accounts/v1/ path', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ accountName: 'Test Account' })
            });

            await merchantService.testConnection(1);

            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('/accounts/v1/accounts/12345');
            expect(calledUrl).not.toContain('v1beta');
        });

        it('upsertProduct should use /products/v1/ path', async () => {
            // Mock getGmcApiSettings is not needed — upsertProduct takes options directly
            // getAuthClient delegates to getAuthenticatedClient (mocked globally)

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ name: 'products/123' })
            });

            await merchantService.upsertProduct({
                merchantId: 1,
                gmcMerchantId: '12345',
                dataSourceId: '67890',
                product: {
                    offerId: 'SKU-001',
                    title: 'Test Product',
                    description: 'A test product',
                    link: 'https://example.com/product/1',
                    imageLink: 'https://example.com/image.jpg',
                    availability: 'in_stock',
                    condition: 'new',
                    price: { value: '19.99', currency: 'CAD' }
                },
                channel: 'ONLINE'
            });

            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('/products/v1/accounts/12345/productInputs:insert');
            expect(calledUrl).not.toContain('v1beta');
        });

        it('getDataSourceInfo should use /datasources/v1/ path', async () => {
            // getAuthClient delegates to getAuthenticatedClient (mocked globally)

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ name: 'datasources/123' })
            });

            await merchantService.getDataSourceInfo(1, '12345', '67890');

            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('/datasources/v1/accounts/12345/dataSources/67890');
            expect(calledUrl).not.toContain('v1beta');
        });

        it('buildMerchantApiProduct output should use v1 field names', () => {
            // LOGIC CHANGE: v1beta → v1 schema (BACKLOG-61)
            // Verify source uses v1 field names: productAttributes (not attributes), no channel
            const realFs = jest.requireActual('fs');
            const source = realFs.readFileSync(
                require('path').join(__dirname, '../../../services/gmc/merchant-service.js'),
                'utf8'
            );

            // v1 fields present
            expect(source).toContain('offerId: product.offerId');
            expect(source).toContain('productAttributes: {');
            expect(source).toContain('title: product.title');
            expect(source).toContain('amountMicros:');
            expect(source).toContain('currencyCode: product.price.currency');
            expect(source).toContain('gtins: product.gtin');

            // v1beta fields removed
            expect(source).not.toContain("channel: channel.toUpperCase()");
            expect(source).not.toMatch(/\battributes: \{/);
        });
    });

    describe('buildMerchantApiProduct v1 schema compliance (BACKLOG-61)', () => {
        it('should produce v1-compliant payload with productAttributes and no channel', async () => {
            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ name: 'products/123' })
            });

            await merchantService.upsertProduct({
                merchantId: 1,
                gmcMerchantId: '12345',
                dataSourceId: '67890',
                product: {
                    offerId: 'SKU-001',
                    title: 'Test Product',
                    description: 'A test product',
                    link: 'https://example.com/product/1',
                    imageLink: 'https://example.com/image.jpg',
                    availability: 'in_stock',
                    condition: 'new',
                    price: { value: '19.99', currency: 'CAD' },
                    gtin: '0123456789012',
                    brand: 'TestBrand',
                    feedLabel: 'CA',
                    contentLanguage: 'en'
                },
                channel: 'ONLINE'
            });

            const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);

            // v1: no channel field
            expect(sentBody.channel).toBeUndefined();

            // v1: productAttributes (not attributes)
            expect(sentBody.attributes).toBeUndefined();
            expect(sentBody.productAttributes).toBeDefined();

            // v1: top-level required fields
            expect(sentBody.offerId).toBe('SKU-001');
            expect(sentBody.feedLabel).toBe('CA');
            expect(sentBody.contentLanguage).toBe('en');

            // v1: productAttributes contents
            const attrs = sentBody.productAttributes;
            expect(attrs.title).toBe('Test Product');
            expect(attrs.description).toBe('A test product');
            expect(attrs.link).toBe('https://example.com/product/1');
            expect(attrs.imageLink).toBe('https://example.com/image.jpg');

            // v1: uppercase enums
            expect(attrs.availability).toBe('IN_STOCK');
            expect(attrs.condition).toBe('NEW');

            // v1: price object
            expect(attrs.price.amountMicros).toBe('19990000');
            expect(attrs.price.currencyCode).toBe('CAD');

            // v1: gtins is array (not gtin string)
            expect(attrs.gtins).toEqual(['0123456789012']);
            expect(attrs.gtin).toBeUndefined();

            expect(attrs.brand).toBe('TestBrand');
        });

        it('should omit gtins when product has no gtin', async () => {
            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ name: 'products/123' })
            });

            await merchantService.upsertProduct({
                merchantId: 1,
                gmcMerchantId: '12345',
                dataSourceId: '67890',
                product: {
                    offerId: 'SKU-002',
                    title: 'No GTIN Product',
                    description: 'Product without GTIN',
                    link: 'https://example.com/product/2',
                    imageLink: 'https://example.com/image2.jpg',
                    availability: 'out_of_stock',
                    condition: 'new',
                    price: { value: '9.99', currency: 'CAD' }
                },
                channel: 'ONLINE'
            });

            const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(sentBody.productAttributes.gtins).toBeUndefined();
            expect(sentBody.productAttributes.availability).toBe('OUT_OF_STOCK');
        });

        it('should omit feedLabel and contentLanguage when not set', async () => {
            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ name: 'products/123' })
            });

            await merchantService.upsertProduct({
                merchantId: 1,
                gmcMerchantId: '12345',
                dataSourceId: '67890',
                product: {
                    offerId: 'SKU-003',
                    title: 'Minimal Product',
                    description: 'Test',
                    link: 'https://example.com/product/3',
                    imageLink: 'https://example.com/image3.jpg',
                    availability: 'in_stock',
                    price: { value: '5.00', currency: 'USD' }
                },
                channel: 'ONLINE'
            });

            const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(sentBody.feedLabel).toBeUndefined();
            expect(sentBody.contentLanguage).toBeUndefined();
        });
    });

    describe('error path catch blocks - no ReferenceError', () => {
        it('getDataSourceInfo error path should not throw ReferenceError for path', async () => {
            // Simulate 403 API failure — path is assigned inside try, catch must still access it
            global.fetch = jest.fn().mockResolvedValue({
                status: 403,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'Forbidden' } })
            });

            // Should return null (error handled), not throw ReferenceError
            const result = await merchantService.getDataSourceInfo(1, '12345', '67890');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'Failed to get data source info',
                expect.objectContaining({
                    error: 'Forbidden',
                    url: expect.stringContaining('/datasources/v1/accounts/12345/dataSources/67890')
                })
            );
        });

        it('getDataSourceInfo error before path assignment should log N/A url', async () => {
            // Auth failure happens before path is assigned
            mockGetAuthenticatedClient.mockRejectedValueOnce(new Error('Not authenticated'));

            const result = await merchantService.getDataSourceInfo(1, '12345', '67890');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                'Failed to get data source info',
                expect.objectContaining({
                    error: 'Not authenticated',
                    url: 'N/A'
                })
            );
        });

        it('upsertProduct error path should not throw ReferenceError for apiPath', async () => {
            // Simulate 403 API failure — apiPath is assigned inside try, catch must still access it
            global.fetch = jest.fn().mockResolvedValue({
                status: 403,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'Forbidden' } })
            });

            const product = {
                offerId: 'SKU-001',
                title: 'Test',
                description: 'Test',
                link: 'https://example.com',
                imageLink: 'https://example.com/img.jpg',
                availability: 'in_stock',
                condition: 'new',
                price: { value: '9.99', currency: 'CAD' }
            };

            // Should throw the original error, not a ReferenceError
            await expect(merchantService.upsertProduct({
                merchantId: 1,
                gmcMerchantId: '12345',
                dataSourceId: '67890',
                product,
                channel: 'ONLINE'
            })).rejects.toThrow('Forbidden');

            expect(logger.error).toHaveBeenCalledWith(
                'Failed to upsert product in GMC',
                expect.objectContaining({
                    error: 'Forbidden',
                    url: expect.stringContaining('/products/v1/accounts/12345/productInputs:insert')
                })
            );
        });
    });

    describe('saveGmcApiSettings - batch insert (P-6)', () => {
        it('should insert all settings in a single query using UNNEST', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await merchantService.saveGmcApiSettings(1, {
                gmc_merchant_id: '12345',
                feed_label: 'CA',
                content_language: 'en'
            });

            expect(db.query).toHaveBeenCalledTimes(1);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UNNEST'),
                [
                    1,
                    ['gmc_merchant_id', 'feed_label', 'content_language'],
                    ['12345', 'CA', 'en']
                ]
            );
        });

        it('should not execute query when settings object is empty', async () => {
            await merchantService.saveGmcApiSettings(1, {});

            expect(db.query).not.toHaveBeenCalled();
        });

        it('should handle single setting correctly', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await merchantService.saveGmcApiSettings(1, { gmc_merchant_id: '99' });

            expect(db.query).toHaveBeenCalledTimes(1);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UNNEST'),
                [1, ['gmc_merchant_id'], ['99']]
            );
        });
    });

    describe('registerDeveloper', () => {
        it('should register GCP project successfully', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ gcpProjectId: 'my-project-123' })
            });

            const result = await merchantService.registerDeveloper(1, 'dev@example.com');

            expect(result.success).toBe(true);
            expect(result.gcpIds).toEqual({ gcpProjectId: 'my-project-123' });
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/developerRegistration:registerGcp'),
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ developerEmail: 'dev@example.com' })
                })
            );
        });

        it('should return error when Merchant Center ID not configured', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await merchantService.registerDeveloper(1, 'dev@example.com');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Merchant Center ID not configured');
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('should return error on API failure', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 403,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'Permission denied' } })
            });

            const result = await merchantService.registerDeveloper(1, 'dev@example.com');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });
    });

    describe('testConnection - needsRegistration flag', () => {
        it('should set needsRegistration when error contains not registered', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 403,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'GCP project not registered with Merchant Center' } })
            });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(result.needsRegistration).toBe(true);
        });

        it('should not set needsRegistration for other errors', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 401,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'Invalid credentials' } })
            });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(result.needsRegistration).toBeUndefined();
        });
    });
});
