/**
 * Tests for Catalog Audit Service
 *
 * Covers:
 * - getCatalogAudit
 * - fixLocationMismatches
 */

const mockDbQuery = jest.fn();

jest.mock('../../../utils/database', () => ({
    query: mockDbQuery
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../utils/square-api', () => ({
    fixLocationMismatches: jest.fn().mockResolvedValue({
        success: true,
        itemsFixed: 5,
        variationsFixed: 12,
        details: []
    })
}));

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map())
}));

const auditService = require('../../../services/catalog/audit-service');
const squareApi = require('../../../utils/square-api');

describe('Catalog Audit Service', () => {
    const merchantId = 1;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getCatalogAudit', () => {
        const createMockItem = (overrides = {}) => {
            // Base item with all required flags calculated
            const base = {
                variation_id: 'var-1',
                sku: 'SKU001',
                upc: '123456789012',
                item_name: 'Test Item',
                variation_name: 'Size M',
                category_id: 'cat-1',
                category_name: 'Dog Food',
                taxable: true,
                price_money: 1000,
                description: 'A test item',
                item_images: JSON.stringify(['img-1']),
                variation_images: JSON.stringify([]),
                track_inventory: true,
                inventory_alert_type: 'LOW_QUANTITY',
                inventory_alert_threshold: 5,
                stock_alert_min: 5,
                location_stock_alert_min: 5,
                vendor_count: 1,
                unit_cost_cents: 500,
                seo_title: 'Test SEO',
                seo_description: 'SEO Description',
                tax_ids: JSON.stringify(['tax-1']),
                variation_present_at_all: true,
                item_present_at_all: true,
                item_present_at_location_ids: JSON.stringify(['loc-1']),
                available_online: true,
                current_stock: 10,
                daily_velocity: 2,
                product_type: 'REGULAR',
                ...overrides
            };

            // Calculate audit flags the same way the service does
            base.missing_category = base.category_id === null || base.category_name === null || base.category_name === '';
            base.not_taxable = base.taxable === false || base.taxable === null;
            base.missing_price = base.price_money === null || base.price_money === 0;
            base.missing_description = base.description === null || base.description === '';
            base.missing_item_image = base.item_images === null || base.item_images === '[]' || base.item_images === 'null';
            base.missing_variation_image = base.variation_images === null || base.variation_images === '[]' || base.variation_images === 'null';
            base.missing_sku = (base.sku === null || base.sku === '') && (base.product_type === null || base.product_type === 'REGULAR');
            base.missing_upc = (base.upc === null || base.upc === '') && (base.product_type === null || base.product_type === 'REGULAR');
            base.stock_tracking_off = (base.track_inventory === false || base.track_inventory === null) && (base.product_type === null || base.product_type === 'REGULAR');
            base.inventory_alerts_off = (base.inventory_alert_type === null || base.inventory_alert_type !== 'LOW_QUANTITY') &&
                (base.location_stock_alert_min === null || base.location_stock_alert_min === 0) &&
                (base.product_type === null || base.product_type === 'REGULAR');
            base.no_reorder_threshold = base.current_stock <= 0 &&
                (base.inventory_alert_type === null || base.inventory_alert_type !== 'LOW_QUANTITY' || base.inventory_alert_threshold === null || base.inventory_alert_threshold === 0) &&
                (base.stock_alert_min === null || base.stock_alert_min === 0) &&
                (base.location_stock_alert_min === null) &&
                (base.product_type === null || base.product_type === 'REGULAR');
            base.missing_vendor = base.vendor_count === 0 && (base.product_type === null || base.product_type === 'REGULAR');
            base.missing_cost = base.unit_cost_cents === null && !base.variation_name.toUpperCase().includes('SAMPLE') && (base.product_type === null || base.product_type === 'REGULAR');
            base.location_mismatch = base.variation_present_at_all === true && base.item_present_at_all === false;
            const parsedLocationIds = (() => { try { return JSON.parse(base.item_present_at_location_ids || '[]'); } catch { return []; }})();
            base.pos_disabled = (base.item_present_at_all === false || base.item_present_at_all === null) &&
                (base.item_present_at_location_ids === null || parsedLocationIds.length === 0);
            base.online_disabled = base.available_online === false || base.available_online === null;
            base.any_channel_off = base.pos_disabled || base.online_disabled;

            return base;
        };

        it('should return comprehensive audit data', async () => {
            mockDbQuery.mockResolvedValue({ rows: [createMockItem()] });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result).toHaveProperty('stats');
            expect(result).toHaveProperty('count');
            expect(result).toHaveProperty('items');
            expect(result.stats).toHaveProperty('total_items');
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(auditService.getCatalogAudit(null)).rejects.toThrow('merchantId is required');
        });

        it('should calculate missing_category flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ category_id: null, category_name: null })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_category).toBe(1);
            expect(result.items[0].missing_category).toBe(true);
        });

        it('should calculate not_taxable flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ taxable: false })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.not_taxable).toBe(1);
            expect(result.items[0].not_taxable).toBe(true);
        });

        it('should calculate missing_price flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ price_money: null })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_price).toBe(1);
        });

        it('should calculate missing_description flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ description: '' })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_description).toBe(1);
        });

        it('should calculate missing_sku flag for REGULAR products only', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ sku: null, product_type: 'REGULAR' })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_sku).toBe(1);
        });

        it('should NOT flag missing_sku for service products', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ sku: null, product_type: 'APPOINTMENTS_SERVICE' })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_sku).toBe(0);
        });

        it('should calculate stock_tracking_off flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ track_inventory: false })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.stock_tracking_off).toBe(1);
        });

        it('should calculate inventory_alerts_off flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({
                    inventory_alert_type: null,
                    location_stock_alert_min: null
                })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.inventory_alerts_off).toBe(1);
        });

        it('should calculate no_reorder_threshold flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({
                    current_stock: 0,
                    inventory_alert_type: null,
                    inventory_alert_threshold: null,
                    stock_alert_min: null,
                    location_stock_alert_min: null
                })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.no_reorder_threshold).toBe(1);
        });

        it('should calculate missing_vendor flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ vendor_count: 0 })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_vendor).toBe(1);
        });

        it('should calculate missing_cost flag (excluding SAMPLE variations)', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ unit_cost_cents: null, variation_name: 'Size M' })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_cost).toBe(1);
        });

        it('should NOT flag missing_cost for SAMPLE variations', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ unit_cost_cents: null, variation_name: 'SAMPLE' })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.missing_cost).toBe(0);
        });

        it('should calculate location_mismatch flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({
                    variation_present_at_all: true,
                    item_present_at_all: false
                })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.location_mismatch).toBe(1);
        });

        it('should calculate pos_disabled flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({
                    item_present_at_all: false,
                    item_present_at_location_ids: null
                })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.pos_disabled).toBe(1);
        });

        it('should calculate online_disabled flag', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ available_online: false })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.online_disabled).toBe(1);
        });

        it('should calculate items_with_issues count', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [
                    createMockItem({ category_id: null }),  // 1 issue
                    createMockItem({ price_money: null, description: '' }),  // 2 issues
                    createMockItem()  // 0 issues
                ]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.stats.items_with_issues).toBe(2);  // 2 items have issues
        });

        it('should filter by location_id with parameterized query', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await auditService.getCatalogAudit(merchantId, { location_id: 'loc-123' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([merchantId, 'loc-123'])
            );
        });

        it('should sanitize invalid location_id', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            // Attempt SQL injection
            await auditService.getCatalogAudit(merchantId, { location_id: "'; DROP TABLE--" });

            // Should pass null for invalid location_id
            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.any(String),
                [merchantId, null]
            );
        });

        it('should filter by issue_type when provided', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [
                    createMockItem({ category_id: null }),
                    createMockItem()  // No issues
                ]
            });

            const result = await auditService.getCatalogAudit(merchantId, { issue_type: 'missing_category' });

            // Should only return items with missing_category = true
            expect(result.items.every(item => item.missing_category)).toBe(true);
        });

        it('should calculate issue_count per item', async () => {
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ category_id: null, price_money: null, description: '' })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            expect(result.items[0].issue_count).toBe(3);
            expect(result.items[0].issues).toContain('No Category');
            expect(result.items[0].issues).toContain('No Price');
            expect(result.items[0].issues).toContain('No Description');
        });

        it('should calculate days_of_stock', async () => {
            // days_of_stock is calculated in SQL, so we include it in the mock data
            mockDbQuery.mockResolvedValue({
                rows: [createMockItem({ current_stock: 100, daily_velocity: 5, days_of_stock: 20 })]
            });

            const result = await auditService.getCatalogAudit(merchantId);

            // days_of_stock is passed through from the SQL result
            expect(result.items[0].days_of_stock).toBe(20);  // 100/5 = 20
        });
    });

    describe('fixLocationMismatches', () => {
        it('should call squareApi.fixLocationMismatches', async () => {
            await auditService.fixLocationMismatches(merchantId);

            expect(squareApi.fixLocationMismatches).toHaveBeenCalledWith(merchantId);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(auditService.fixLocationMismatches(null)).rejects.toThrow('merchantId is required');
        });

        it('should return success result with fix counts', async () => {
            const result = await auditService.fixLocationMismatches(merchantId);

            expect(result.success).toBe(true);
            expect(result.itemsFixed).toBe(5);
            expect(result.variationsFixed).toBe(12);
        });

        it('should handle partial failure from Square API', async () => {
            squareApi.fixLocationMismatches.mockResolvedValueOnce({
                success: false,
                itemsFixed: 3,
                variationsFixed: 8,
                errors: ['Failed to update item-5']
            });

            const result = await auditService.fixLocationMismatches(merchantId);

            expect(result.success).toBe(false);
            expect(result.errors).toContain('Failed to update item-5');
        });

        it('should include details in response', async () => {
            squareApi.fixLocationMismatches.mockResolvedValueOnce({
                success: true,
                itemsFixed: 2,
                variationsFixed: 4,
                details: [
                    { itemId: 'item-1', fixed: true },
                    { itemId: 'item-2', fixed: true }
                ]
            });

            const result = await auditService.fixLocationMismatches(merchantId);

            expect(result.details).toHaveLength(2);
        });
    });
});
