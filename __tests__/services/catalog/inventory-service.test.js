/**
 * Tests for Catalog Inventory Service
 *
 * Covers:
 * - getInventory
 * - getLowStock
 * - getDeletedItems
 * - getExpirations
 * - saveExpirations
 * - markExpirationsReviewed
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
    updateCustomAttributeValues: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map())
}));

jest.mock('../../../utils/expiry-discount', () => ({
    calculateDaysUntilExpiry: jest.fn().mockReturnValue(30),
    getActiveTiers: jest.fn().mockResolvedValue([]),
    determineTier: jest.fn().mockReturnValue(null)
}));

const inventoryService = require('../../../services/catalog/inventory-service');
const squareApi = require('../../../utils/square-api');
const expiryDiscount = require('../../../utils/expiry-discount');

describe('Catalog Inventory Service', () => {
    const merchantId = 1;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getInventory', () => {
        it('should return inventory levels with velocity data', async () => {
            const mockInventory = [
                {
                    variation_id: 'var-1',
                    quantity: 50,
                    location_id: 'loc-1',
                    sku: 'SKU001',
                    item_name: 'Dog Food',
                    daily_avg_quantity: 2.5,
                    days_until_stockout: 20,
                    images: null,
                    item_images: null
                }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockInventory });

            const result = await inventoryService.getInventory(merchantId);

            expect(result.count).toBe(1);
            expect(result.inventory).toHaveLength(1);
            expect(result.inventory[0]).toHaveProperty('variation_id');
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(inventoryService.getInventory(null)).rejects.toThrow('merchantId is required');
        });

        it('should filter by location_id when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getInventory(merchantId, { location_id: 'loc-123' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ic.location_id = '),
                expect.arrayContaining(['loc-123'])
            );
        });

        it('should filter by low_stock when true', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getInventory(merchantId, { low_stock: 'true' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ic.quantity < v.stock_alert_min'),
                expect.any(Array)
            );
        });

        it('should exclude deleted items', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getInventory(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("COALESCE(v.is_deleted, FALSE) = FALSE"),
                expect.any(Array)
            );
        });

        it('should include sales velocity data for multiple periods', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getInventory(merchantId);

            const queryCall = mockDbQuery.mock.calls[0][0];
            expect(queryCall).toContain('sv91');
            expect(queryCall).toContain('sv182');
            expect(queryCall).toContain('sv365');
        });
    });

    describe('getLowStock', () => {
        it('should return items below minimum stock threshold', async () => {
            const mockLowStock = [
                {
                    id: 'var-1',
                    sku: 'SKU001',
                    item_name: 'Dog Food',
                    current_stock: 3,
                    stock_alert_min: 10,
                    units_below_min: 7,
                    images: null,
                    item_images: null
                }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockLowStock });

            const result = await inventoryService.getLowStock(merchantId);

            expect(result.count).toBe(1);
            expect(result.low_stock_items).toHaveLength(1);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(inventoryService.getLowStock(null)).rejects.toThrow('merchantId is required');
        });

        it('should only include non-discontinued items', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getLowStock(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('v.discontinued = FALSE'),
                [merchantId]
            );
        });

        it('should order by units below minimum descending', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getLowStock(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ORDER BY (v.stock_alert_min - ic.quantity) DESC'),
                [merchantId]
            );
        });
    });

    describe('getDeletedItems', () => {
        it('should return deleted and archived items', async () => {
            const mockDeleted = [
                {
                    id: 'var-1',
                    sku: 'SKU001',
                    item_name: 'Old Product',
                    status: 'deleted',
                    is_deleted: true,
                    is_archived: false,
                    images: null,
                    item_images: null
                }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockDeleted });

            const result = await inventoryService.getDeletedItems(merchantId);

            expect(result.count).toBe(1);
            expect(result.deleted_count).toBe(1);
            expect(result.archived_count).toBe(0);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(inventoryService.getDeletedItems(null)).rejects.toThrow('merchantId is required');
        });

        it('should filter by status=deleted', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getDeletedItems(merchantId, { status: 'deleted' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('v.is_deleted = TRUE'),
                expect.any(Array)
            );
        });

        it('should filter by status=archived', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getDeletedItems(merchantId, { status: 'archived' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("i.is_archived, FALSE) = TRUE"),
                expect.any(Array)
            );
        });

        it('should filter by age_months with parameterized query', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getDeletedItems(merchantId, { age_months: '3' });

            // Should use parameterized query (not string interpolation)
            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("$2 || ' months'"),
                expect.arrayContaining([merchantId, 3])
            );
        });

        it('should reject invalid age_months values', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            // Invalid (>120 months)
            await inventoryService.getDeletedItems(merchantId, { age_months: '999' });

            // Should not include age filter for invalid values
            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.not.stringContaining("' months'"),
                [merchantId]
            );
        });
    });

    describe('getExpirations', () => {
        it('should return variations with expiration data', async () => {
            const mockExpirations = [
                {
                    identifier: 'var-1',
                    name: 'Dog Food',
                    sku: 'SKU001',
                    expiration_date: '2024-06-01',
                    does_not_expire: false,
                    quantity: 25,
                    images: null,
                    item_images: null
                }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockExpirations });

            const result = await inventoryService.getExpirations(merchantId);

            expect(result.count).toBe(1);
            expect(result.items).toHaveLength(1);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(inventoryService.getExpirations(null)).rejects.toThrow('merchantId is required');
        });

        it('should filter by category when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getExpirations(merchantId, { category: 'Dog' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('i.category_name ILIKE'),
                expect.arrayContaining(['%Dog%'])
            );
        });

        it('should filter by expiry=no-expiry', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getExpirations(merchantId, { expiry: 'no-expiry' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ve.expiration_date IS NULL'),
                expect.any(Array)
            );
        });

        it('should filter by expiry=never-expires', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getExpirations(merchantId, { expiry: 'never-expires' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ve.does_not_expire = TRUE'),
                expect.any(Array)
            );
        });

        it('should filter by expiry=review (90-120 days)', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getExpirations(merchantId, { expiry: 'review' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("INTERVAL '90 days'"),
                expect.any(Array)
            );
        });

        it('should filter by numeric expiry days', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await inventoryService.getExpirations(merchantId, { expiry: '30' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("$2 || ' days'"),
                expect.arrayContaining([merchantId, 30])
            );
        });
    });

    describe('saveExpirations', () => {
        beforeEach(() => {
            mockDbQuery.mockResolvedValue({ rows: [{ id: 'var-1' }] });
        });

        it('should save expiration data for multiple variations', async () => {
            const changes = [
                { variation_id: 'var-1', expiration_date: '2024-06-01', does_not_expire: false },
                { variation_id: 'var-2', expiration_date: null, does_not_expire: true }
            ];

            const result = await inventoryService.saveExpirations(merchantId, changes);

            expect(result.success).toBe(true);
            expect(result.message).toContain('Updated');
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(
                inventoryService.saveExpirations(null, [])
            ).rejects.toThrow('merchantId is required');
        });

        it('should return 400 if changes is not an array', async () => {
            const result = await inventoryService.saveExpirations(merchantId, 'not-array');

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should skip changes without variation_id', async () => {
            const changes = [
                { expiration_date: '2024-06-01' }  // No variation_id
            ];

            const result = await inventoryService.saveExpirations(merchantId, changes);

            expect(result.success).toBe(true);
            expect(result.message).toContain('0');
        });

        it('should verify variation belongs to merchant', async () => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValueOnce({ rows: [] });  // Variation not found

            const changes = [
                { variation_id: 'var-other-merchant', expiration_date: '2024-06-01' }
            ];

            await inventoryService.saveExpirations(merchantId, changes);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('SELECT id FROM variations'),
                expect.arrayContaining(['var-other-merchant', merchantId])
            );
        });

        it('should push expiration to Square', async () => {
            const changes = [
                { variation_id: 'var-1', expiration_date: '2024-06-01' }
            ];

            await inventoryService.saveExpirations(merchantId, changes);

            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalled();
        });

        it('should clear reviewed_at when entering discount tier', async () => {
            expiryDiscount.calculateDaysUntilExpiry.mockReturnValue(10);
            expiryDiscount.determineTier.mockReturnValue({ tier_code: 'AUTO25' });

            const changes = [
                { variation_id: 'var-1', expiration_date: '2024-03-01' }
            ];

            await inventoryService.saveExpirations(merchantId, changes);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('SET reviewed_at = NULL'),
                expect.arrayContaining(['var-1', merchantId])
            );
        });

        it('should track Square push successes and failures', async () => {
            squareApi.updateCustomAttributeValues
                .mockResolvedValueOnce({})
                .mockRejectedValueOnce(new Error('API Error'));

            mockDbQuery.mockResolvedValue({ rows: [{ id: 'var-1' }] });

            const changes = [
                { variation_id: 'var-1', expiration_date: '2024-06-01' },
                { variation_id: 'var-2', expiration_date: '2024-07-01' }
            ];

            const result = await inventoryService.saveExpirations(merchantId, changes);

            expect(result.squarePush.success).toBe(1);
            expect(result.squarePush.failed).toBe(1);
        });
    });

    describe('markExpirationsReviewed', () => {
        beforeEach(() => {
            mockDbQuery.mockResolvedValue({ rows: [{ id: 'var-1' }, { id: 'var-2' }] });
        });

        it('should mark variations as reviewed', async () => {
            const variationIds = ['var-1', 'var-2'];

            const result = await inventoryService.markExpirationsReviewed(merchantId, variationIds);

            expect(result.success).toBe(true);
            expect(result.reviewed_count).toBe(2);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(
                inventoryService.markExpirationsReviewed(null, ['var-1'])
            ).rejects.toThrow('merchantId is required');
        });

        it('should return 400 if variationIds is empty', async () => {
            const result = await inventoryService.markExpirationsReviewed(merchantId, []);

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should return 400 if variationIds is not an array', async () => {
            const result = await inventoryService.markExpirationsReviewed(merchantId, 'not-array');

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should batch verify variations belong to merchant', async () => {
            const variationIds = ['var-1', 'var-2', 'var-3'];

            await inventoryService.markExpirationsReviewed(merchantId, variationIds);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('SELECT id FROM variations WHERE id = ANY'),
                expect.arrayContaining([variationIds, merchantId])
            );
        });

        it('should return 400 if no valid variations found', async () => {
            mockDbQuery.mockResolvedValueOnce({ rows: [] });

            const result = await inventoryService.markExpirationsReviewed(merchantId, ['invalid-var']);

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should push reviewed_at to Square', async () => {
            await inventoryService.markExpirationsReviewed(merchantId, ['var-1', 'var-2'], 'John');

            // Should call Square for each valid variation
            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledTimes(2);
        });

        it('should accept optional reviewedBy parameter', async () => {
            await inventoryService.markExpirationsReviewed(merchantId, ['var-1'], 'Jane');

            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
                'var-1',
                expect.objectContaining({
                    expiry_reviewed_by: { string_value: 'Jane' }
                }),
                { merchantId }
            );
        });

        it('should track Square sync results', async () => {
            squareApi.updateCustomAttributeValues
                .mockResolvedValueOnce({})
                .mockRejectedValueOnce(new Error('API Error'));

            const result = await inventoryService.markExpirationsReviewed(merchantId, ['var-1', 'var-2']);

            expect(result.squarePush.success).toBe(1);
            expect(result.squarePush.failed).toBe(1);
        });
    });
});
