/**
 * Tests for utils/image-utils.js
 *
 * Covers: resolveImageUrls, batchResolveImageUrls
 * Verifies merchant_id tenant isolation (SEC-14)
 */

const db = require('../../utils/database');

jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn()
}));

const { resolveImageUrls, batchResolveImageUrls } = require('../../utils/image-utils');

describe('image-utils', () => {
    const merchantId = 42;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('resolveImageUrls', () => {
        it('includes merchant_id in the query', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 'img1', url: 'https://cdn.example.com/img1.jpg' }] });

            await resolveImageUrls(['img1'], null, merchantId);

            expect(db.query).toHaveBeenCalledTimes(1);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('merchant_id = $2');
            expect(params).toEqual(['img1', merchantId]);
        });

        it('uses correct merchant_id param index with multiple image IDs', async () => {
            db.query.mockResolvedValue({ rows: [
                { id: 'img1', url: 'https://cdn.example.com/img1.jpg' },
                { id: 'img2', url: 'https://cdn.example.com/img2.jpg' }
            ] });

            await resolveImageUrls(['img1', 'img2'], null, merchantId);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('merchant_id = $3');
            expect(params).toEqual(['img1', 'img2', merchantId]);
        });

        it('returns URLs in order of input image IDs', async () => {
            db.query.mockResolvedValue({ rows: [
                { id: 'img2', url: 'https://cdn.example.com/img2.jpg' },
                { id: 'img1', url: 'https://cdn.example.com/img1.jpg' }
            ] });

            const result = await resolveImageUrls(['img1', 'img2'], null, merchantId);

            expect(result).toEqual([
                'https://cdn.example.com/img1.jpg',
                'https://cdn.example.com/img2.jpg'
            ]);
        });

        it('falls back to item images when variation images are empty', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 'item_img', url: 'https://cdn.example.com/item.jpg' }] });

            await resolveImageUrls([], ['item_img'], merchantId);

            const [, params] = db.query.mock.calls[0];
            expect(params).toEqual(['item_img', merchantId]);
        });

        it('returns empty array when no image IDs provided', async () => {
            const result = await resolveImageUrls(null, null, merchantId);
            expect(result).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('returns empty array on database error', async () => {
            db.query.mockRejectedValue(new Error('connection refused'));

            const result = await resolveImageUrls(['img1'], null, merchantId);
            expect(result).toEqual([]);
        });
    });

    describe('batchResolveImageUrls', () => {
        it('includes merchant_id in the query', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 'img1', url: 'https://cdn.example.com/img1.jpg' }] });

            const items = [{ images: ['img1'] }];
            await batchResolveImageUrls(items, merchantId);

            expect(db.query).toHaveBeenCalledTimes(1);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('merchant_id');
            expect(params).toContain(merchantId);
        });

        it('passes merchant_id as last parameter after all image IDs', async () => {
            db.query.mockResolvedValue({ rows: [
                { id: 'img1', url: 'https://cdn.example.com/img1.jpg' },
                { id: 'img2', url: 'https://cdn.example.com/img2.jpg' }
            ] });

            const items = [
                { images: ['img1'] },
                { images: ['img2'] }
            ];
            await batchResolveImageUrls(items, merchantId);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('merchant_id = $3');
            expect(params[params.length - 1]).toBe(merchantId);
        });

        it('returns empty map when items have no images', async () => {
            const items = [{ images: [] }, { images: null }];
            const result = await batchResolveImageUrls(items, merchantId);

            expect(db.query).not.toHaveBeenCalled();
            expect(result.get(0)).toEqual([]);
            expect(result.get(1)).toEqual([]);
        });

        it('falls back to item_images when images is empty', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 'item_img', url: 'https://cdn.example.com/item.jpg' }] });

            const items = [{ images: [], item_images: ['item_img'] }];
            await batchResolveImageUrls(items, merchantId);

            const [, params] = db.query.mock.calls[0];
            expect(params).toContain('item_img');
            expect(params).toContain(merchantId);
        });

        it('deduplicates image IDs across items', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 'img1', url: 'https://cdn.example.com/img1.jpg' }] });

            const items = [
                { images: ['img1'] },
                { images: ['img1'] }
            ];
            await batchResolveImageUrls(items, merchantId);

            const [sql, params] = db.query.mock.calls[0];
            // Only one placeholder for the deduplicated image ID, plus merchant_id
            expect(sql).toContain('merchant_id = $2');
            expect(params).toEqual(['img1', merchantId]);
        });

        it('maps resolved URLs back to correct items', async () => {
            db.query.mockResolvedValue({ rows: [
                { id: 'img1', url: 'https://cdn.example.com/img1.jpg' },
                { id: 'img2', url: 'https://cdn.example.com/img2.jpg' }
            ] });

            const items = [
                { images: ['img1'] },
                { images: ['img2'] }
            ];
            const result = await batchResolveImageUrls(items, merchantId);

            expect(result.get(0)).toEqual(['https://cdn.example.com/img1.jpg']);
            expect(result.get(1)).toEqual(['https://cdn.example.com/img2.jpg']);
        });
    });
});
