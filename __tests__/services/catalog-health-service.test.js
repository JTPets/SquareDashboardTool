/**
 * Tests for services/catalog/catalog-health-service.js
 *
 * Covers all 8 check types:
 *   1. location_mismatch
 *   2. orphaned_variation
 *   3. deleted_parent
 *   4. category_orphan
 *   5. image_orphan
 *   6. modifier_orphan
 *   7. pricing_rule_orphan
 *   8. missing_tax (severity=warn)
 *
 * Also covers: merchant guard, resolution, idempotency, getHealthHistory, getOpenIssues
 */

let db;
let makeSquareRequest;
let runFullHealthCheck;
let getHealthHistory;
let getOpenIssues;

function buildItem(id, overrides = {}) {
    return {
        id,
        type: 'ITEM',
        present_at_all_locations: true,
        item_data: {
            variations: [],
            categories: [],
            image_ids: [],
            modifier_list_info: [],
            tax_ids: ['TAX_1'],
            ...overrides
        },
        ...overrides
    };
}

function buildVariation(id, itemId, overrides = {}) {
    return {
        id,
        type: 'ITEM_VARIATION',
        present_at_all_locations: true,
        item_variation_data: {
            item_id: itemId,
            image_ids: [],
            ...overrides
        },
        ...overrides
    };
}

/**
 * Set up makeSquareRequest to return catalog objects for ListCatalog
 * and optionally deleted objects for SearchCatalog
 */
function setupSquareMocks(catalogObjects = [], deletedObjects = []) {
    makeSquareRequest.mockImplementation((endpoint, opts) => {
        if (endpoint.includes('/v2/catalog/list')) {
            return Promise.resolve({ objects: catalogObjects, cursor: null });
        }
        if (endpoint === '/v2/catalog/search') {
            return Promise.resolve({ objects: deletedObjects, cursor: null });
        }
        return Promise.resolve({ objects: [], cursor: null });
    });
}

beforeEach(() => {
    jest.resetModules();

    jest.mock('../../utils/database');
    jest.mock('../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }));
    jest.mock('../../services/square/square-client', () => ({
        getMerchantToken: jest.fn().mockResolvedValue('test-token'),
        makeSquareRequest: jest.fn(),
    }));
    jest.mock('../../config/constants', () => ({
        SQUARE: { MAX_PAGINATION_ITERATIONS: 100 },
    }));

    db = require('../../utils/database');
    makeSquareRequest = require('../../services/square/square-client').makeSquareRequest;
    const service = require('../../services/catalog/catalog-health-service');
    runFullHealthCheck = service.runFullHealthCheck;
    getHealthHistory = service.getHealthHistory;
    getOpenIssues = service.getOpenIssues;
});

// ============================================================================
// Merchant guard
// ============================================================================
describe('merchant guard', () => {
    test('throws if merchantId is not 3', async () => {
        await expect(runFullHealthCheck(1)).rejects.toThrow('debug-only, merchant 3 only');
        await expect(runFullHealthCheck(99)).rejects.toThrow('debug-only, merchant 3 only');
    });
});

// ============================================================================
// CHECK 1: location_mismatch
// ============================================================================
describe('CHECK 1: location_mismatch', () => {
    test('detects variation with mismatched present_at_all_locations', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: true,
            item_data: {
                variations: [{ id: 'VAR_1', present_at_all_locations: false }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] }); // open issues
        db.query.mockResolvedValue({ rows: [] }); // INSERT

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'location_mismatch', object_id: 'VAR_1' })
            ])
        );
    });

    test('detects present_at_all_future_locations mismatch', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: true,
            present_at_all_future_locations: true,
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    present_at_all_future_locations: false
                }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'location_mismatch' })
            ])
        );
    });

    test('no mismatch when flags match', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: true,
            item_data: {
                variations: [{ id: 'VAR_1', present_at_all_locations: true }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const locationIssues = result.newIssues.filter(i => i.check_type === 'location_mismatch');
        expect(locationIssues).toHaveLength(0);
    });
});

// ============================================================================
// CHECK 2: orphaned_variation
// ============================================================================
describe('CHECK 2: orphaned_variation', () => {
    test('detects variation with no matching parent ITEM', async () => {
        const orphanVar = buildVariation('VAR_ORPHAN', 'ITEM_MISSING');

        setupSquareMocks([orphanVar]); // Only variation, no item
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'orphaned_variation', object_id: 'VAR_ORPHAN' })
            ])
        );
    });

    test('no orphan when parent exists', async () => {
        const item = buildItem('ITEM_1');
        const variation = buildVariation('VAR_1', 'ITEM_1');

        setupSquareMocks([item, variation]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const orphanIssues = result.newIssues.filter(i => i.check_type === 'orphaned_variation');
        expect(orphanIssues).toHaveLength(0);
    });
});

// ============================================================================
// CHECK 3: deleted_parent
// ============================================================================
describe('CHECK 3: deleted_parent', () => {
    test('detects variation whose parent ITEM is deleted', async () => {
        const orphanVar = buildVariation('VAR_DEL', 'ITEM_DELETED');
        const deletedItem = { id: 'ITEM_DELETED', type: 'ITEM', is_deleted: true };

        setupSquareMocks([orphanVar], [deletedItem]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'deleted_parent', object_id: 'VAR_DEL' })
            ])
        );
    });
});

// ============================================================================
// CHECK 4: category_orphan
// ============================================================================
describe('CHECK 4: category_orphan', () => {
    test('detects item referencing non-existent category', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                categories: [{ id: 'CAT_MISSING' }],
                variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]); // No category objects
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'category_orphan', object_id: 'ITEM_1' })
            ])
        );
    });

    test('detects item referencing deleted category', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                categories: [{ id: 'CAT_DEL' }],
                variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });
        const cat = { id: 'CAT_DEL', type: 'CATEGORY' };
        const deletedCat = { id: 'CAT_DEL', type: 'CATEGORY', is_deleted: true };

        setupSquareMocks([item, cat], [deletedCat]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'category_orphan', object_id: 'ITEM_1' })
            ])
        );
    });

    test('no orphan when category exists', async () => {
        const cat = { id: 'CAT_1', type: 'CATEGORY' };
        const item = buildItem('ITEM_1', {
            item_data: {
                categories: [{ id: 'CAT_1' }],
                variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item, cat]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const catIssues = result.newIssues.filter(i => i.check_type === 'category_orphan');
        expect(catIssues).toHaveLength(0);
    });
});

// ============================================================================
// CHECK 5: image_orphan
// ============================================================================
describe('CHECK 5: image_orphan', () => {
    test('detects item referencing non-existent image', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                image_ids: ['IMG_MISSING'],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'image_orphan', object_id: 'ITEM_1', object_type: 'ITEM' })
            ])
        );
    });

    test('detects variation referencing deleted image', async () => {
        const item = buildItem('ITEM_1');
        const variation = buildVariation('VAR_1', 'ITEM_1', {
            item_variation_data: { item_id: 'ITEM_1', image_ids: ['IMG_DEL'] }
        });
        const img = { id: 'IMG_DEL', type: 'IMAGE' };
        const deletedImg = { id: 'IMG_DEL', type: 'IMAGE', is_deleted: true };

        setupSquareMocks([item, variation, img], [deletedImg]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'image_orphan', object_id: 'VAR_1', object_type: 'ITEM_VARIATION' })
            ])
        );
    });

    test('no orphan when image exists', async () => {
        const img = { id: 'IMG_1', type: 'IMAGE' };
        const item = buildItem('ITEM_1', {
            item_data: {
                image_ids: ['IMG_1'],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item, img]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const imgIssues = result.newIssues.filter(i => i.check_type === 'image_orphan');
        expect(imgIssues).toHaveLength(0);
    });
});

// ============================================================================
// CHECK 6: modifier_orphan
// ============================================================================
describe('CHECK 6: modifier_orphan', () => {
    test('detects item referencing non-existent modifier list', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                modifier_list_info: [{ modifier_list_id: 'MOD_MISSING' }],
                categories: [], image_ids: [], variations: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'modifier_orphan', object_id: 'ITEM_1' })
            ])
        );
    });

    test('no orphan when modifier exists', async () => {
        const mod = { id: 'MOD_1', type: 'MODIFIER_LIST' };
        const item = buildItem('ITEM_1', {
            item_data: {
                modifier_list_info: [{ modifier_list_id: 'MOD_1' }],
                categories: [], image_ids: [], variations: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item, mod]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const modIssues = result.newIssues.filter(i => i.check_type === 'modifier_orphan');
        expect(modIssues).toHaveLength(0);
    });
});

// ============================================================================
// CHECK 7: pricing_rule_orphan
// ============================================================================
describe('CHECK 7: pricing_rule_orphan', () => {
    test('detects pricing rule referencing deleted object', async () => {
        const rule = {
            id: 'RULE_1',
            type: 'PRICING_RULE',
            pricing_rule_data: {
                match_products_id: 'PSET_DEL',
                discount_id: 'DISC_1'
            }
        };
        const deletedPset = { id: 'PSET_DEL', type: 'PRODUCT_SET', is_deleted: true };

        setupSquareMocks([rule], [deletedPset]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'pricing_rule_orphan', object_id: 'RULE_1' })
            ])
        );
    });

    test('no orphan when referenced objects are not deleted', async () => {
        const rule = {
            id: 'RULE_1',
            type: 'PRICING_RULE',
            pricing_rule_data: {
                match_products_id: 'PSET_1',
                discount_id: 'DISC_1'
            }
        };

        setupSquareMocks([rule]); // No deleted objects
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const ruleIssues = result.newIssues.filter(i => i.check_type === 'pricing_rule_orphan');
        expect(ruleIssues).toHaveLength(0);
    });
});

// ============================================================================
// CHECK 8: missing_tax
// ============================================================================
describe('CHECK 8: missing_tax', () => {
    test('detects item with no tax_ids (severity=warn)', async () => {
        const item = buildItem('ITEM_NOTAX', {
            item_data: {
                tax_ids: [],
                categories: [], image_ids: [], variations: [], modifier_list_info: []
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    check_type: 'missing_tax',
                    object_id: 'ITEM_NOTAX',
                    severity: 'warn'
                })
            ])
        );
    });

    test('detects item with null tax_ids', async () => {
        const item = buildItem('ITEM_NULLTAX', {
            item_data: {
                categories: [], image_ids: [], variations: [], modifier_list_info: []
                // tax_ids intentionally missing
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'missing_tax', severity: 'warn' })
            ])
        );
    });

    test('no issue when tax_ids present', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                tax_ids: ['TAX_1'],
                categories: [], image_ids: [], variations: [], modifier_list_info: []
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const taxIssues = result.newIssues.filter(i => i.check_type === 'missing_tax');
        expect(taxIssues).toHaveLength(0);
    });
});

// ============================================================================
// Resolution + idempotency
// ============================================================================
describe('resolution and idempotency', () => {
    test('does not insert duplicate when open issue exists', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                tax_ids: [],
                categories: [], image_ids: [], variations: [], modifier_list_info: []
            }
        });

        setupSquareMocks([item]);
        // Existing open issue for same check_type:object_id
        db.query.mockResolvedValueOnce({
            rows: [{ id: 42, check_type: 'missing_tax', variation_id: 'ITEM_1', item_id: 'ITEM_1' }]
        });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toHaveLength(0);
        expect(result.existingOpen).toBe(1);
    });

    test('resolves previously open issue that is now clean', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                tax_ids: ['TAX_1'],
                categories: [], image_ids: [], variations: [], modifier_list_info: []
            }
        });

        setupSquareMocks([item]);
        // Previously open missing_tax issue
        db.query.mockResolvedValueOnce({
            rows: [{ id: 42, check_type: 'missing_tax', variation_id: 'ITEM_1', item_id: 'ITEM_1' }]
        });
        db.query.mockResolvedValue({ rows: [] }); // UPDATE resolved_at

        const result = await runFullHealthCheck(3);
        expect(result.resolved).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'missing_tax', object_id: 'ITEM_1' })
            ])
        );
        // Verify UPDATE was called
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('resolved_at = NOW()'),
            [42]
        );
    });
});

// ============================================================================
// Return shape
// ============================================================================
describe('return shape', () => {
    test('returns checked counts, durationMs', async () => {
        const item = buildItem('ITEM_1');
        const cat = { id: 'CAT_1', type: 'CATEGORY' };

        setupSquareMocks([item, cat]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.checked).toHaveProperty('items');
        expect(result.checked).toHaveProperty('variations');
        expect(result.checked).toHaveProperty('categories');
        expect(result.checked).toHaveProperty('images');
        expect(result.checked).toHaveProperty('modifiers');
        expect(result.checked).toHaveProperty('pricingRules');
        expect(typeof result.durationMs).toBe('number');
        expect(Array.isArray(result.newIssues)).toBe(true);
        expect(Array.isArray(result.resolved)).toBe(true);
    });
});

// ============================================================================
// Empty catalog
// ============================================================================
describe('empty catalog', () => {
    test('handles empty catalog gracefully', async () => {
        setupSquareMocks([]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.checked.items).toBe(0);
        expect(result.newIssues).toHaveLength(0);
    });
});

// ============================================================================
// getHealthHistory
// ============================================================================
describe('getHealthHistory', () => {
    test('returns all rows for merchant', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, check_type: 'missing_tax', status: 'mismatch' },
                { id: 2, check_type: 'location_mismatch', status: 'valid' }
            ]
        });

        const rows = await getHealthHistory(3);
        expect(rows).toHaveLength(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('ORDER BY detected_at DESC'),
            [3]
        );
    });

    test('throws without merchantId', async () => {
        await expect(getHealthHistory()).rejects.toThrow('merchantId is required');
    });
});

// ============================================================================
// getOpenIssues
// ============================================================================
describe('getOpenIssues', () => {
    test('returns only open issue rows', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 1, check_type: 'orphaned_variation', status: 'mismatch' }]
        });

        const rows = await getOpenIssues(3);
        expect(rows).toHaveLength(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("status = 'mismatch' AND resolved_at IS NULL"),
            [3]
        );
    });

    test('throws without merchantId', async () => {
        await expect(getOpenIssues()).rejects.toThrow('merchantId is required');
    });
});
