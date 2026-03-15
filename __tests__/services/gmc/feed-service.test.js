/**
 * GMC Feed Service Tests
 *
 * Tests for Google Merchant Center feed generation, TSV formatting,
 * settings management, brand/taxonomy imports, and local inventory feeds.
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

jest.mock('fs', () => ({
    promises: {
        mkdir: jest.fn().mockResolvedValue(undefined),
        writeFile: jest.fn().mockResolvedValue(undefined),
    },
}));

const db = require('../../../utils/database');
const fs = require('fs').promises;
const feedService = require('../../../services/gmc/feed-service');

describe('GMC Feed Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== getSettings ====================
    describe('getSettings', () => {
        test('returns settings as key-value object', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { setting_key: 'currency', setting_value: 'CAD' },
                    { setting_key: 'website_base_url', setting_value: 'https://shop.com' },
                ],
            });

            const result = await feedService.getSettings(1);
            expect(result).toEqual({ currency: 'CAD', website_base_url: 'https://shop.com' });
        });

        test('returns empty object when no merchantId', async () => {
            const result = await feedService.getSettings(null);
            expect(result).toEqual({});
            expect(db.query).not.toHaveBeenCalled();
        });

        test('returns empty object for no settings rows', async () => {
            db.query.mockResolvedValue({ rows: [] });
            const result = await feedService.getSettings(1);
            expect(result).toEqual({});
        });
    });

    // ==================== generateFeedData ====================
    describe('generateFeedData', () => {
        test('throws if merchantId is missing', async () => {
            await expect(feedService.generateFeedData({}))
                .rejects.toThrow('merchantId is required');
        });

        test('generates feed data from product rows', async () => {
            // First call: getSettings
            db.query
                .mockResolvedValueOnce({ rows: [{ setting_key: 'currency', setting_value: 'CAD' }] })
                // Second call: product query
                .mockResolvedValueOnce({
                    rows: [{
                        variation_id: 'var1',
                        variation_name: 'Small',
                        sku: 'SKU001',
                        upc: '123456789',
                        price_money: 1099,
                        currency: 'CAD',
                        item_id: 'item1',
                        item_name: 'Dog Food',
                        description: 'Great dog food',
                        category_id: 'cat1',
                        category_name: 'Pet Food',
                        item_image_ids: '["img1"]',
                        image_urls: ['https://img.com/dog.jpg'],
                        brand_name: 'ACANA',
                        google_product_category: 'Animals > Pet Supplies',
                        google_taxonomy_id: 3237,
                        quantity: 25,
                    }],
                });

            const result = await feedService.generateFeedData({ merchantId: 1 });

            expect(result.products).toHaveLength(1);
            expect(result.products[0].id).toBe('var1');
            expect(result.products[0].title).toBe('Dog Food~Small');
            expect(result.products[0].price).toBe('10.99 CAD');
            expect(result.products[0].availability).toBe('in_stock');
            expect(result.products[0].brand).toBe('ACANA');
            expect(result.stats.total).toBe(1);
        });

        test('uses "Regular" variation name to produce item-only title', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{
                        variation_id: 'var1',
                        variation_name: 'Regular',
                        sku: 'SKU001',
                        upc: null,
                        price_money: 500,
                        currency: 'CAD',
                        item_id: 'item1',
                        item_name: 'Simple Item',
                        description: null,
                        category_id: null,
                        category_name: null,
                        item_image_ids: null,
                        image_urls: null,
                        brand_name: null,
                        google_product_category: null,
                        google_taxonomy_id: null,
                        quantity: 0,
                    }],
                });

            const result = await feedService.generateFeedData({ merchantId: 1 });
            expect(result.products[0].title).toBe('Simple Item');
            expect(result.products[0].availability).toBe('out_of_stock');
        });

        test('handles product processing error gracefully', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [
                        // A normal row
                        { variation_id: 'v1', variation_name: 'Reg', sku: null, upc: null, price_money: 100, currency: 'CAD', item_id: 'i1', item_name: 'Good', description: '', category_id: null, category_name: null, image_urls: null, brand_name: null, google_product_category: null, quantity: 1 },
                    ],
                });

            const result = await feedService.generateFeedData({ merchantId: 1 });
            expect(result.products.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ==================== generateTsvContent ====================
    describe('generateTsvContent', () => {
        test('generates TSV with headers and rows', () => {
            const products = [{
                id: 'v1', title: 'Dog Food', link: 'https://shop.com/p/dog-food/v1',
                description: 'Great food', gtin: '123', category: 'Pet', image_link: 'http://img.com/a.jpg',
                additional_image_link_1: '', additional_image_link_2: '', condition: 'new',
                availability: 'in_stock', quantity: 10, brand: 'ACANA',
                google_product_category: 'Animals', price: '10.99 CAD', adult: 'no', is_bundle: 'no',
            }];

            const tsv = feedService.generateTsvContent(products);
            const lines = tsv.split('\n');

            expect(lines[0]).toContain('id\ttitle\tlink');
            expect(lines[1]).toContain('v1\tDog Food');
            expect(lines).toHaveLength(2);
        });

        test('escapes tabs and newlines in values', () => {
            const products = [{
                id: 'v1', title: 'Dog\tFood', link: 'url', description: 'Line1\nLine2',
                gtin: '', category: '', image_link: '', additional_image_link_1: '',
                additional_image_link_2: '', condition: 'new', availability: 'in_stock',
                quantity: 0, brand: '', google_product_category: '', price: '', adult: 'no', is_bundle: 'no',
            }];

            const tsv = feedService.generateTsvContent(products);
            // Tabs in value replaced with spaces
            expect(tsv.split('\n')[1]).toContain('Dog Food');
            // Newlines in value replaced with spaces
            expect(tsv.split('\n')[1]).toContain('Line1 Line2');
        });

        test('handles null/undefined values', () => {
            const products = [{
                id: null, title: undefined, link: '', description: null,
                gtin: null, category: null, image_link: null, additional_image_link_1: null,
                additional_image_link_2: null, condition: null, availability: null,
                quantity: null, brand: null, google_product_category: null, price: null, adult: null, is_bundle: null,
            }];

            const tsv = feedService.generateTsvContent(products);
            expect(tsv.split('\n')).toHaveLength(2);
        });
    });

    // ==================== saveTsvFile ====================
    describe('saveTsvFile', () => {
        test('saves content to output/feeds directory', async () => {
            const path = await feedService.saveTsvFile('header\nrow1', 'test-feed.tsv');
            expect(fs.mkdir).toHaveBeenCalled();
            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('test-feed.tsv'),
                'header\nrow1',
                'utf8'
            );
            expect(path).toContain('test-feed.tsv');
        });

        test('uses default filename', async () => {
            await feedService.saveTsvFile('data');
            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('gmc-feed.tsv'),
                'data',
                'utf8'
            );
        });
    });

    // ==================== importBrands ====================
    describe('importBrands', () => {
        test('imports valid brand names', async () => {
            db.query.mockResolvedValue({});
            const count = await feedService.importBrands(['ACANA', 'Orijen', 'Fromm']);
            expect(count).toBe(3);
            expect(db.query).toHaveBeenCalledTimes(3);
        });

        test('skips null and empty brand names', async () => {
            db.query.mockResolvedValue({});
            const count = await feedService.importBrands([null, '', 'ACANA', undefined]);
            expect(count).toBe(1);
        });

        test('skips non-string values', async () => {
            db.query.mockResolvedValue({});
            const count = await feedService.importBrands([123, 'ACANA']);
            expect(count).toBe(1);
        });

        test('continues on individual brand insert failure', async () => {
            db.query
                .mockRejectedValueOnce(new Error('duplicate'))
                .mockResolvedValueOnce({});

            const count = await feedService.importBrands(['DupBrand', 'GoodBrand']);
            expect(count).toBe(1);
        });
    });

    // ==================== importGoogleTaxonomy ====================
    describe('importGoogleTaxonomy', () => {
        test('imports taxonomy items with level calculation', async () => {
            db.query.mockResolvedValue({});
            const items = [
                { id: 1, name: 'Animals & Pet Supplies' },
                { id: 2, name: 'Animals & Pet Supplies > Pet Food' },
            ];
            const count = await feedService.importGoogleTaxonomy(items);
            expect(count).toBe(2);
            // Level 1 for "Animals & Pet Supplies" (no >)
            expect(db.query.mock.calls[0][1]).toEqual([1, 'Animals & Pet Supplies', 1]);
            // Level 2 for "Animals & Pet Supplies > Pet Food" (one >)
            expect(db.query.mock.calls[1][1]).toEqual([2, 'Animals & Pet Supplies > Pet Food', 2]);
        });

        test('skips items without id or name', async () => {
            const items = [
                { id: null, name: 'Test' },
                { id: 1, name: null },
                { id: 2, name: 'Valid' },
            ];
            db.query.mockResolvedValue({});
            const count = await feedService.importGoogleTaxonomy(items);
            expect(count).toBe(1);
        });
    });

    // ==================== getLocationSettings ====================
    describe('getLocationSettings', () => {
        test('returns empty array without merchantId', async () => {
            const result = await feedService.getLocationSettings(null);
            expect(result).toEqual([]);
        });

        test('returns location settings rows', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, location_id: 'LOC1', google_store_code: 'STORE1', enabled: true }],
            });
            const result = await feedService.getLocationSettings(1);
            expect(result).toHaveLength(1);
        });
    });

    // ==================== saveLocationSettings ====================
    describe('saveLocationSettings', () => {
        test('upserts location settings', async () => {
            db.query.mockResolvedValue({});
            await feedService.saveLocationSettings(1, 'LOC1', { google_store_code: 'STORE1', enabled: true });
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO gmc_location_settings'),
                [1, 'LOC1', 'STORE1', true]
            );
        });

        test('defaults enabled to true', async () => {
            db.query.mockResolvedValue({});
            await feedService.saveLocationSettings(1, 'LOC1', { google_store_code: 'STORE1' });
            expect(db.query.mock.calls[0][1][3]).toBe(true);
        });
    });

    // ==================== generateLocalInventoryFeed ====================
    describe('generateLocalInventoryFeed', () => {
        test('throws if merchantId is missing', async () => {
            await expect(feedService.generateLocalInventoryFeed({}))
                .rejects.toThrow('merchantId is required');
        });

        test('throws if locationId is missing', async () => {
            await expect(feedService.generateLocalInventoryFeed({ merchantId: 1 }))
                .rejects.toThrow('locationId is required');
        });

        test('throws if location not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(feedService.generateLocalInventoryFeed({ merchantId: 1, locationId: 'MISSING' }))
                .rejects.toThrow('Location MISSING not found');
        });

        test('generates local inventory feed data', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 'LOC1', location_name: 'Store 1', store_code: 'S1', enabled: true }],
                })
                .mockResolvedValueOnce({
                    rows: [{
                        variation_id: 'v1', sku: 'SK1', upc: null, item_id: 'i1',
                        item_name: 'Dog Food', variation_name: 'Small',
                        location_quantity: 10, total_quantity: 25,
                    }],
                });

            const result = await feedService.generateLocalInventoryFeed({ merchantId: 1, locationId: 'LOC1' });
            expect(result.items).toHaveLength(1);
            expect(result.items[0].store_code).toBe('S1');
            expect(result.items[0].quantity).toBe(10);
            expect(result.location.location_name).toBe('Store 1');
        });
    });

    // ==================== generateLocalInventoryTsvContent ====================
    describe('generateLocalInventoryTsvContent', () => {
        test('generates 3-column TSV', () => {
            const items = [
                { store_code: 'S1', itemid: 'v1', quantity: 10 },
                { store_code: 'S1', itemid: 'v2', quantity: 0 },
            ];
            const tsv = feedService.generateLocalInventoryTsvContent(items);
            const lines = tsv.split('\n');
            expect(lines[0]).toBe('store_code\titemid\tquantity');
            expect(lines).toHaveLength(3);
        });
    });

    // ==================== saveSettings ====================
    describe('saveSettings', () => {
        test('throws if merchantId is missing', async () => {
            await expect(feedService.saveSettings(null, {}))
                .rejects.toThrow('merchantId is required');
        });

        test('upserts each setting key-value pair', async () => {
            db.query.mockResolvedValue({});
            await feedService.saveSettings(1, { currency: 'USD', website_base_url: 'https://shop.com' });
            expect(db.query).toHaveBeenCalledTimes(2);
        });
    });
});
