/**
 * Tests for services/catalog/item-service.js
 *
 * Covers: getLocations, getCategories, getItems
 */

const db = require('../../../utils/database');
const { getLocations, getCategories, getItems } = require('../../../services/catalog/item-service');

describe('item-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const merchantId = 1;

    // ==================== getLocations ====================
    describe('getLocations', () => {
        it('returns locations for a merchant', async () => {
            const mockRows = [
                { id: 'LOC1', name: 'Main Store', active: true, address: '123 Main St', timezone: 'America/Toronto' },
                { id: 'LOC2', name: 'Warehouse', active: false, address: '456 Oak Ave', timezone: 'America/Toronto' }
            ];
            db.query.mockResolvedValueOnce({ rows: mockRows });

            const result = await getLocations(merchantId);

            expect(result.count).toBe(2);
            expect(result.locations).toEqual(mockRows);
            expect(db.query.mock.calls[0][1]).toEqual([merchantId]);
        });

        it('returns empty array when no locations', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getLocations(merchantId);

            expect(result.count).toBe(0);
            expect(result.locations).toEqual([]);
        });

        it('throws when merchantId is missing', async () => {
            await expect(getLocations(null)).rejects.toThrow('merchantId is required');
            await expect(getLocations(undefined)).rejects.toThrow('merchantId is required');
            await expect(getLocations(0)).rejects.toThrow('merchantId is required');
        });
    });

    // ==================== getCategories ====================
    describe('getCategories', () => {
        it('returns array of category names', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { category_name: 'Cat Food' },
                    { category_name: 'Dog Food' },
                    { category_name: 'Treats' }
                ]
            });

            const result = await getCategories(merchantId);

            expect(result).toEqual(['Cat Food', 'Dog Food', 'Treats']);
            expect(db.query.mock.calls[0][1]).toEqual([merchantId]);
        });

        it('returns empty array when no categories', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getCategories(merchantId);

            expect(result).toEqual([]);
        });

        it('throws when merchantId is missing', async () => {
            await expect(getCategories(null)).rejects.toThrow('merchantId is required');
        });

        it('filters out null and empty category names via SQL', async () => {
            // SQL already filters, but verify the query includes those conditions
            db.query.mockResolvedValueOnce({ rows: [{ category_name: 'Valid' }] });

            await getCategories(merchantId);

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('category_name IS NOT NULL');
            expect(sql).toContain("category_name != ''");
        });
    });

    // ==================== getItems ====================
    describe('getItems', () => {
        it('returns items for a merchant', async () => {
            const mockRows = [
                { id: 'ITEM1', name: 'Premium Cat Food', category_name: 'Cat Food' },
                { id: 'ITEM2', name: 'Dog Treats', category_name: 'Dog Food' }
            ];
            db.query.mockResolvedValueOnce({ rows: mockRows });

            const result = await getItems(merchantId);

            expect(result.count).toBe(2);
            expect(result.items).toEqual(mockRows);
            expect(db.query.mock.calls[0][1]).toEqual([merchantId]);
        });

        it('filters by name', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'ITEM1', name: 'Premium Cat Food' }] });

            await getItems(merchantId, { name: 'Cat' });

            expect(db.query.mock.calls[0][1]).toEqual([merchantId, '%Cat%']);
            expect(db.query.mock.calls[0][0]).toContain('ILIKE');
        });

        it('filters by category', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getItems(merchantId, { category: 'Dog' });

            expect(db.query.mock.calls[0][1]).toEqual([merchantId, '%Dog%']);
        });

        it('filters by both name and category', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getItems(merchantId, { name: 'Treat', category: 'Dog' });

            expect(db.query.mock.calls[0][1]).toEqual([merchantId, '%Treat%', '%Dog%']);
        });

        it('returns empty items array when no results', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getItems(merchantId);

            expect(result.count).toBe(0);
            expect(result.items).toEqual([]);
        });

        it('throws when merchantId is missing', async () => {
            await expect(getItems(null)).rejects.toThrow('merchantId is required');
        });

        it('always includes merchant_id filter in query', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getItems(merchantId);

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('merchant_id = $1');
        });
    });
});
