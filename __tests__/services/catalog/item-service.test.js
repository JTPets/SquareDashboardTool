/**
 * Tests for Catalog Item Service
 *
 * Covers:
 * - getLocations
 * - getCategories
 * - getItems
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

const itemService = require('../../../services/catalog/item-service');

describe('Catalog Item Service', () => {
    const merchantId = 1;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getLocations', () => {
        it('should return locations for a merchant', async () => {
            const mockLocations = [
                { id: 'loc-1', name: 'Main Store', active: true, address: '123 Main St', timezone: 'America/Toronto' },
                { id: 'loc-2', name: 'Warehouse', active: true, address: '456 Oak Ave', timezone: 'America/Toronto' }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockLocations });

            const result = await itemService.getLocations(merchantId);

            expect(result).toEqual({
                count: 2,
                locations: mockLocations
            });

            // Verify query includes merchant_id filter
            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('WHERE merchant_id = $1'),
                [merchantId]
            );
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(itemService.getLocations(null)).rejects.toThrow('merchantId is required');
            await expect(itemService.getLocations(undefined)).rejects.toThrow('merchantId is required');
        });

        it('should return empty array if no locations found', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            const result = await itemService.getLocations(merchantId);

            expect(result).toEqual({
                count: 0,
                locations: []
            });
        });

        it('should order locations by name', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getLocations(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ORDER BY name'),
                [merchantId]
            );
        });
    });

    describe('getCategories', () => {
        it('should return distinct category names', async () => {
            const mockCategories = [
                { category_name: 'Dog Food' },
                { category_name: 'Cat Food' },
                { category_name: 'Toys' }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockCategories });

            const result = await itemService.getCategories(merchantId);

            expect(result).toEqual(['Dog Food', 'Cat Food', 'Toys']);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(itemService.getCategories(null)).rejects.toThrow('merchantId is required');
        });

        it('should exclude null and empty category names', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getCategories(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("category_name IS NOT NULL"),
                [merchantId]
            );
            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("category_name != ''"),
                [merchantId]
            );
        });

        it('should exclude deleted items', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getCategories(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining("COALESCE(i.is_deleted, FALSE) = FALSE"),
                [merchantId]
            );
        });

        it('should return empty array if no categories found', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            const result = await itemService.getCategories(merchantId);

            expect(result).toEqual([]);
        });
    });

    describe('getItems', () => {
        it('should return items for a merchant', async () => {
            const mockItems = [
                { id: 'item-1', name: 'Dog Food Premium', category_name: 'Dog Food' },
                { id: 'item-2', name: 'Cat Treats', category_name: 'Cat Food' }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockItems });

            const result = await itemService.getItems(merchantId);

            expect(result).toEqual({
                count: 2,
                items: mockItems
            });
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(itemService.getItems(null)).rejects.toThrow('merchantId is required');
        });

        it('should filter by name when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getItems(merchantId, { name: 'Premium' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('i.name ILIKE'),
                expect.arrayContaining([merchantId, '%Premium%'])
            );
        });

        it('should filter by category when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getItems(merchantId, { category: 'Dog' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('c.name ILIKE'),
                expect.arrayContaining([merchantId, '%Dog%'])
            );
        });

        it('should filter by both name and category when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getItems(merchantId, { name: 'Premium', category: 'Dog' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('i.name ILIKE'),
                expect.arrayContaining(['%Premium%'])
            );
            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('c.name ILIKE'),
                expect.arrayContaining(['%Dog%'])
            );
        });

        it('should return empty items array if no items found', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            const result = await itemService.getItems(merchantId);

            expect(result).toEqual({
                count: 0,
                items: []
            });
        });

        it('should order items by name', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getItems(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('ORDER BY i.name'),
                [merchantId]
            );
        });

        it('should include merchant_id filter in category join', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await itemService.getItems(merchantId);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('c.merchant_id = $1'),
                [merchantId]
            );
        });
    });
});
