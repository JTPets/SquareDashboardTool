/**
 * ZPL Generator Service Tests
 *
 * Tests for ZPL label generation, template management, and field substitution.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

const db = require('../../../utils/database');
const zplGenerator = require('../../../services/label/zpl-generator');

describe('ZPL Generator Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== getTemplates ====================
    describe('getTemplates', () => {
        test('returns templates for a merchant', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: 1, name: '2x1 Label', is_default: true },
                    { id: 2, name: '3x2 Label', is_default: false },
                ],
            });

            const result = await zplGenerator.getTemplates(1);
            expect(result).toHaveLength(2);
            expect(db.query.mock.calls[0][1]).toEqual([1]);
        });
    });

    // ==================== getTemplate ====================
    describe('getTemplate', () => {
        test('returns specific template by ID', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 5, name: 'Custom', template_zpl: '^XA^FO10,10^FD{{itemName}}^FS^XZ' }],
            });

            const result = await zplGenerator.getTemplate(1, 5);
            expect(result.id).toBe(5);
            expect(db.query.mock.calls[0][1]).toEqual([5, 1]); // templateId, merchantId
        });

        test('returns default template when no templateId', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, name: 'Default', is_default: true }],
            });

            const result = await zplGenerator.getTemplate(1, null);
            expect(result.is_default).toBe(true);
        });

        test('returns null when template not found', async () => {
            db.query.mockResolvedValue({ rows: [] });
            const result = await zplGenerator.getTemplate(1, 999);
            expect(result).toBeNull();
        });
    });

    // ==================== setDefaultTemplate ====================
    describe('setDefaultTemplate', () => {
        test('clears old default and sets new one', async () => {
            db.transaction.mockImplementation(async (fn) => {
                const client = {
                    query: jest.fn()
                        .mockResolvedValueOnce({}) // clear old default
                        .mockResolvedValueOnce({ rows: [{ id: 3, name: 'New Default' }] }), // set new
                };
                return fn(client);
            });

            const result = await zplGenerator.setDefaultTemplate(1, 3);
            expect(result).toEqual({ id: 3, name: 'New Default' });
        });

        test('returns null when template does not exist', async () => {
            db.transaction.mockImplementation(async (fn) => {
                const client = {
                    query: jest.fn()
                        .mockResolvedValueOnce({}) // clear
                        .mockResolvedValueOnce({ rows: [] }), // not found
                };
                return fn(client);
            });

            const result = await zplGenerator.setDefaultTemplate(1, 999);
            expect(result).toBeNull();
        });
    });

    // ==================== generateLabels ====================
    describe('generateLabels', () => {
        const template = {
            id: 1,
            name: 'Test Template',
            template_zpl: '^XA^FO10,10^FD{{itemName}} - {{variationName}}^FS^FO10,50^FD${{price}}^FS^BY2^FO10,100^BC^FD{{barcode}}^FS^XZ',
            label_width_mm: 50,
            label_height_mm: 25,
        };

        test('generates ZPL for variations', async () => {
            // getTemplate
            db.query.mockResolvedValueOnce({ rows: [template] });
            // getVariationLabelData
            db.query.mockResolvedValueOnce({
                rows: [{
                    variation_id: 'v1',
                    variation_name: 'Small',
                    sku: 'SKU001',
                    upc: '123456789',
                    price_money: 1099,
                    currency: 'CAD',
                    item_name: 'Dog Food',
                }],
            });

            const result = await zplGenerator.generateLabels(1, ['v1']);

            expect(result.labelCount).toBe(1);
            expect(result.totalLabels).toBe(1);
            expect(result.zpl).toContain('Dog Food');
            expect(result.zpl).toContain('Small');
            expect(result.zpl).toContain('10.99');
            expect(result.zpl).toContain('123456789'); // UPC used as barcode
            expect(result.template.id).toBe(1);
        });

        test('uses SKU as barcode when no UPC', async () => {
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({
                rows: [{
                    variation_id: 'v1', variation_name: 'Reg', sku: 'SKU002', upc: null,
                    price_money: 500, currency: 'CAD', item_name: 'Cat Toy',
                }],
            });

            const result = await zplGenerator.generateLabels(1, ['v1']);
            expect(result.zpl).toContain('SKU002');
        });

        test('generates multiple copies', async () => {
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({
                rows: [{
                    variation_id: 'v1', variation_name: 'Reg', sku: 'SK1', upc: null,
                    price_money: 100, currency: 'CAD', item_name: 'Item',
                }],
            });

            const result = await zplGenerator.generateLabels(1, ['v1'], { copies: 3 });
            expect(result.totalLabels).toBe(3);
            // ZPL should have 3 label blocks
            const blocks = result.zpl.split('^XZ');
            expect(blocks.length - 1).toBe(3); // 3 ^XZ terminators
        });

        test('throws if no template found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // no template
            await expect(zplGenerator.generateLabels(1, ['v1']))
                .rejects.toThrow('No label template found');
        });

        test('throws if no variations found', async () => {
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(zplGenerator.generateLabels(1, ['v1']))
                .rejects.toThrow('No matching variations found');
        });

        test('logs missing variations', async () => {
            const logger = require('../../../utils/logger');
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({
                rows: [{
                    variation_id: 'v1', variation_name: 'Reg', sku: 'SK1', upc: null,
                    price_money: 100, currency: 'CAD', item_name: 'Item',
                }],
            });

            const result = await zplGenerator.generateLabels(1, ['v1', 'v_missing']);
            expect(result.missingVariations).toEqual(['v_missing']);
            expect(logger.warn).toHaveBeenCalledWith(
                'Some variations not found for label generation',
                expect.objectContaining({ missingCount: 1 })
            );
        });

        test('sanitizes ZPL-breaking characters', async () => {
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({
                rows: [{
                    variation_id: 'v1', variation_name: 'Reg', sku: 'SK^1~test\\', upc: null,
                    price_money: 100, currency: 'CAD', item_name: 'Item^~\\Bad',
                }],
            });

            const result = await zplGenerator.generateLabels(1, ['v1']);
            expect(result.zpl).not.toContain('^~');
            expect(result.zpl).not.toContain('\\Bad');
        });
    });

    // ==================== generateLabelsWithPrices ====================
    describe('generateLabelsWithPrices', () => {
        const template = {
            id: 1, name: 'Price Label',
            template_zpl: '^XA^FD{{itemName}} ${{price}}^FS^XZ',
            label_width_mm: 50, label_height_mm: 25,
        };

        test('uses override prices instead of DB prices', async () => {
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({
                rows: [{
                    variation_id: 'v1', variation_name: 'Reg', sku: 'SK1', upc: null,
                    price_money: 500, currency: 'CAD', item_name: 'Item',
                }],
            });

            const priceChanges = [{ variationId: 'v1', newPriceCents: 999 }];
            const result = await zplGenerator.generateLabelsWithPrices(1, priceChanges);

            expect(result.zpl).toContain('9.99');
            expect(result.zpl).not.toContain('5.00');
        });

        test('throws if no template', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(zplGenerator.generateLabelsWithPrices(1, [{ variationId: 'v1', newPriceCents: 100 }]))
                .rejects.toThrow('No label template found');
        });

        test('tracks missing variations', async () => {
            db.query.mockResolvedValueOnce({ rows: [template] });
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await zplGenerator.generateLabelsWithPrices(1, [
                { variationId: 'v1', newPriceCents: 100 },
            ]);
            expect(result.missingVariations).toEqual(['v1']);
            expect(result.labelCount).toBe(0);
        });
    });
});
