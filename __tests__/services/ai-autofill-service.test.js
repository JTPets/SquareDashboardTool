/**
 * AI Autofill Service Tests
 *
 * Tests for AI-powered catalog content generation service.
 * Covers readiness assessment, prompt building, message content building,
 * Claude API interaction, batch processing, and validation.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

// Mock global fetch
global.fetch = jest.fn();

const db = require('../../utils/database');
const service = require('../../services/ai-autofill-service');

describe('AI Autofill Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== getItemsWithReadiness ====================
    describe('getItemsWithReadiness', () => {
        test('throws if merchantId is missing', async () => {
            await expect(service.getItemsWithReadiness(null))
                .rejects.toThrow('merchantId is required');
        });

        test('groups items by readiness phase', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: '1', name: 'Item A', image_url: null, category_name: 'Cat', description: null, seo_title: null, seo_description: null, variations: null },
                    { id: '2', name: 'Item B', image_url: 'http://img.com/b.jpg', category_name: 'Cat', description: null, seo_title: null, seo_description: null, variations: null },
                    { id: '3', name: 'Item C', image_url: 'http://img.com/c.jpg', category_name: 'Cat', description: 'Desc', seo_title: null, seo_description: null, variations: null },
                    { id: '4', name: 'Item D', image_url: 'http://img.com/d.jpg', category_name: 'Cat', description: 'Desc', seo_title: 'SEO', seo_description: null, variations: null },
                    { id: '5', name: 'Item E', image_url: 'http://img.com/e.jpg', category_name: 'Cat', description: 'Desc', seo_title: 'SEO', seo_description: 'Meta', variations: null },
                ],
            });

            const result = await service.getItemsWithReadiness(1);

            expect(result.notReady).toHaveLength(1);
            expect(result.notReady[0].missingPrereqs).toContain('image');
            expect(result.needsDescription).toHaveLength(1);
            expect(result.needsSeoTitle).toHaveLength(1);
            expect(result.needsSeoDescription).toHaveLength(1);
            expect(result.complete).toHaveLength(1);
        });

        test('item missing both image and category goes to notReady with both prereqs', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: '1', name: 'Item', image_url: null, category_name: null, description: null, seo_title: null, seo_description: null, variations: null },
                ],
            });

            const result = await service.getItemsWithReadiness(1);
            expect(result.notReady[0].missingPrereqs).toEqual(['image', 'category']);
        });

        test('whitespace-only description treated as missing', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: '1', name: 'Item', image_url: 'http://img.com/a.jpg', category_name: 'Cat', description: '   ', seo_title: null, seo_description: null, variations: null },
                ],
            });

            const result = await service.getItemsWithReadiness(1);
            expect(result.needsDescription).toHaveLength(1);
        });

        test('null variations defaulted to empty array', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: '1', name: 'Item', image_url: 'http://img.com/a.jpg', category_name: 'Cat', description: 'D', seo_title: 'S', seo_description: 'M', variations: null },
                ],
            });

            const result = await service.getItemsWithReadiness(1);
            expect(result.complete[0].variations).toEqual([]);
        });
    });

    // ==================== getItemsForGeneration ====================
    describe('getItemsForGeneration', () => {
        test('throws if merchantId is missing', async () => {
            await expect(service.getItemsForGeneration(null, ['id1']))
                .rejects.toThrow('merchantId is required');
        });

        test('returns empty array for empty itemIds', async () => {
            const result = await service.getItemsForGeneration(1, []);
            expect(result).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('returns items with variations defaulted', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: '1', name: 'Test', variations: null, image_url: 'http://img.com/a.jpg' },
                ],
            });

            const result = await service.getItemsForGeneration(1, ['1']);
            expect(result[0].variations).toEqual([]);
        });

        test('preserves existing variations', async () => {
            const vars = [{ id: 'v1', name: 'Small', sku: 'SM' }];
            db.query.mockResolvedValue({
                rows: [{ id: '1', name: 'Test', variations: vars }],
            });

            const result = await service.getItemsForGeneration(1, ['1']);
            expect(result[0].variations).toEqual(vars);
        });
    });

    // ==================== generateContent ====================
    describe('generateContent', () => {
        test('returns empty array for no items', async () => {
            const result = await service.generateContent([], 'description', {}, 'key');
            expect(result).toEqual([]);
        });

        test('throws if API key is missing', async () => {
            await expect(service.generateContent([{ id: '1' }], 'description', {}, null))
                .rejects.toThrow('API key is required');
        });

        test('calls Claude API and maps results', async () => {
            const items = [
                { id: 'item1', name: 'Cat Food', image_url: 'http://img.com/cat.jpg', category_name: 'Pet Food', variations: [], description: null },
            ];

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    content: [{ type: 'text', text: JSON.stringify([{ itemId: 'item1', generated: 'Great cat food!' }]) }],
                }),
            });

            const result = await service.generateContent(items, 'description', {}, 'test-key');

            expect(result).toHaveLength(1);
            expect(result[0].itemId).toBe('item1');
            expect(result[0].generated).toBe('Great cat food!');
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('handles JSON wrapped in code blocks', async () => {
            const items = [{ id: 'item1', name: 'Test', image_url: null, category_name: 'Cat', variations: [] }];

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    content: [{ type: 'text', text: '```json\n[{"itemId": "item1", "generated": "desc"}]\n```' }],
                }),
            });

            const result = await service.generateContent(items, 'description', {}, 'test-key');
            expect(result[0].generated).toBe('desc');
        });

        test('throws on invalid API key (401)', async () => {
            const items = [{ id: '1', name: 'Test', image_url: null, category_name: 'Cat', variations: [] }];

            global.fetch.mockResolvedValue({
                ok: false,
                status: 401,
                text: () => Promise.resolve('Unauthorized'),
            });

            await expect(service.generateContent(items, 'description', {}, 'bad-key'))
                .rejects.toThrow('Invalid Claude API key');
        });

        test('throws when Claude response has no text content', async () => {
            const items = [{ id: '1', name: 'Test', image_url: null, category_name: 'Cat', variations: [] }];

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ content: [] }),
            });

            await expect(service.generateContent(items, 'description', {}, 'key'))
                .rejects.toThrow('No text content in Claude response');
        });

        test('throws when response is not JSON array', async () => {
            const items = [{ id: '1', name: 'Test', image_url: null, category_name: 'Cat', variations: [] }];

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    content: [{ type: 'text', text: '{"not": "an array"}' }],
                }),
            });

            await expect(service.generateContent(items, 'description', {}, 'key'))
                .rejects.toThrow('Claude response is not an array');
        });

        test('retries on 429 rate limit', async () => {
            jest.useFakeTimers();
            const items = [{ id: '1', name: 'Test', image_url: null, category_name: 'Cat', variations: [] }];

            global.fetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    text: () => Promise.resolve('Rate limited'),
                    headers: { get: () => '1' },
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        content: [{ type: 'text', text: '[{"itemId":"1","generated":"ok"}]' }],
                    }),
                });

            const promise = service.generateContent(items, 'description', {}, 'key');
            // Advance past the rate limit delay
            await jest.advanceTimersByTimeAsync(60000);
            const result = await promise;

            expect(result[0].generated).toBe('ok');
            expect(global.fetch).toHaveBeenCalledTimes(2);
            jest.useRealTimers();
        });

        test('item with no matching result gets null generated', async () => {
            const items = [
                { id: 'item1', name: 'Test', image_url: null, category_name: 'Cat', variations: [], description: 'old' },
            ];

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    content: [{ type: 'text', text: '[{"itemId":"other","generated":"wrong"}]' }],
                }),
            });

            const result = await service.generateContent(items, 'description', {}, 'key');
            expect(result[0].generated).toBeNull();
            expect(result[0].original).toBe('old');
        });
    });

    // ==================== generateContentBatched ====================
    describe('generateContentBatched', () => {
        test('returns empty for no items', async () => {
            const result = await service.generateContentBatched([], 'description', {}, 'key', null);
            expect(result).toEqual([]);
        });

        test('throws if API key is missing', async () => {
            await expect(service.generateContentBatched([{ id: '1' }], 'description', {}, null))
                .rejects.toThrow('API key is required');
        });

        test('processes single batch without delay', async () => {
            const items = Array.from({ length: 3 }, (_, i) => ({
                id: `item${i}`, name: `Item ${i}`, image_url: null, category_name: 'Cat', variations: [],
            }));

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    content: [{ type: 'text', text: JSON.stringify(items.map(i => ({ itemId: i.id, generated: 'gen' }))) }],
                }),
            });

            const onBatch = jest.fn();
            const result = await service.generateContentBatched(items, 'description', {}, 'key', onBatch);

            expect(result).toHaveLength(3);
            expect(onBatch).toHaveBeenCalledTimes(1);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('aborts on cancellation signal', async () => {
            const items = Array.from({ length: 15 }, (_, i) => ({
                id: `item${i}`, name: `Item ${i}`, image_url: null, category_name: 'Cat', variations: [],
            }));

            const signal = { cancelled: true };
            const result = await service.generateContentBatched(items, 'description', {}, 'key', null, signal);

            expect(result).toEqual([]);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('marks items as failed on chunk error', async () => {
            const items = Array.from({ length: 3 }, (_, i) => ({
                id: `item${i}`, name: `Item ${i}`, image_url: null, category_name: 'Cat', variations: [],
            }));

            global.fetch.mockResolvedValue({
                ok: false,
                status: 500,
                text: () => Promise.resolve('Server error'),
                headers: { get: () => null },
            });

            const onBatch = jest.fn();
            const result = await service.generateContentBatched(items, 'description', {}, 'key', onBatch);

            expect(result).toHaveLength(3);
            expect(result[0].generated).toBeNull();
            expect(result[0].error).toBeDefined();
            expect(onBatch).toHaveBeenCalledTimes(1);
        });

        test('re-throws on auth error', async () => {
            const items = [{ id: '1', name: 'Test', image_url: null, category_name: 'Cat', variations: [] }];

            global.fetch.mockResolvedValue({
                ok: false,
                status: 401,
                text: () => Promise.resolve('Unauthorized'),
            });

            await expect(service.generateContentBatched(items, 'description', {}, 'key', null))
                .rejects.toThrow('Invalid Claude API key');
        });
    });

    // ==================== validateReadiness ====================
    describe('validateReadiness', () => {
        test('returns valid for items ready for description', () => {
            const items = [
                { name: 'Test', image_url: 'http://img.com/a.jpg', category_name: 'Cat' },
            ];
            const result = service.validateReadiness(items, 'description');
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        test('flags missing image', () => {
            const items = [{ name: 'Test', image_url: null, category_name: 'Cat' }];
            const result = service.validateReadiness(items, 'description');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('"Test" is missing an image');
        });

        test('flags missing category', () => {
            const items = [{ name: 'Test', image_url: 'http://img.com/a.jpg', category_name: null }];
            const result = service.validateReadiness(items, 'description');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('"Test" is missing a category');
        });

        test('seo_title requires description', () => {
            const items = [{ name: 'Test', image_url: 'http://img.com/a.jpg', category_name: 'Cat', description: null }];
            const result = service.validateReadiness(items, 'seo_title');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('"Test" needs a description before generating SEO title');
        });

        test('seo_description requires description and seo_title', () => {
            const items = [{ name: 'Test', image_url: 'http://img.com/a.jpg', category_name: 'Cat', description: null, seo_title: null }];
            const result = service.validateReadiness(items, 'seo_description');
            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(2); // missing description + seo_title
        });

        test('seo_description valid when all prereqs present', () => {
            const items = [{ name: 'Test', image_url: 'img.jpg', category_name: 'Cat', description: 'desc', seo_title: 'title' }];
            const result = service.validateReadiness(items, 'seo_description');
            expect(result.valid).toBe(true);
        });

        test('whitespace-only description treated as missing', () => {
            const items = [{ name: 'Test', image_url: 'img.jpg', category_name: 'Cat', description: '  ' }];
            const result = service.validateReadiness(items, 'seo_title');
            expect(result.valid).toBe(false);
        });
    });

    // ==================== BATCH_SIZE export ====================
    describe('BATCH_SIZE', () => {
        test('exports BATCH_SIZE constant', () => {
            expect(service.BATCH_SIZE).toBe(10);
        });
    });
});
