/**
 * Tests for services/catalog/catalog-health-service.js
 *
 * Covers all 10 check types (7 structural + 3 content quality):
 *   1. location_mismatch        7. pricing_rule_orphan
 *   2. orphaned_variation       8. missing_online_content
 *   3. deleted_parent           9. missing_seo_data
 *   4. category_orphan         10. sellable_not_tracked
 *   5. image_orphan
 *   6. modifier_orphan
 *
 * missing_tax removed — redundant with catalog audit "No Tax IDs" card.
 * Also covers: merchant guard, resolution, idempotency, legacy cleanup, getHealthHistory, getOpenIssues,
 * and constraint string-match guard to prevent DB constraint violations.
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

    test('detects mismatch when item has present_at_all_future_locations but variation omits it', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: true,
            present_at_all_future_locations: true,
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true
                    // present_at_all_future_locations omitted — Square omits when false
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

    test('detects mismatch when variation has present_at_all_future_locations but item omits it', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: true,
            // present_at_all_future_locations omitted
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    present_at_all_future_locations: true
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

    // Array-intersection checks (both present_at_all_locations=false)

    test('detects array mismatch when variation has location not in item (both flags false)', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: false,
            present_at_location_ids: ['LOC_1'],
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: false,
                    present_at_location_ids: ['LOC_1', 'LOC_2']  // LOC_2 not in item
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
                expect.objectContaining({ check_type: 'location_mismatch', object_id: 'VAR_1' })
            ])
        );
        // Verify notes (stored in DB INSERT, not in newIssues return shape) include the orphaned location
        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO catalog_location_health')
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[1][8]).toContain('LOC_2'); // notes is the 9th parameter ($9)
    });

    test('no mismatch when variation location IDs are a subset of item location IDs (both flags false)', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: false,
            present_at_location_ids: ['LOC_1', 'LOC_2'],
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: false,
                    present_at_location_ids: ['LOC_1']  // subset — ok
                }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const locationIssues = result.newIssues.filter(i => i.check_type === 'location_mismatch');
        expect(locationIssues).toHaveLength(0);
    });

    test('no mismatch when both flags false and variation has no location IDs', async () => {
        const item = buildItem('ITEM_1', {
            present_at_all_locations: false,
            present_at_location_ids: ['LOC_1'],
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: false
                    // present_at_location_ids absent — no locations to check
                }],
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
// CHECK 8: missing_online_content
// ============================================================================
describe('CHECK 8: missing_online_content', () => {
    test('detects public item missing description_html and images', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                description_html: null,
                image_ids: [],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    check_type: 'missing_online_content',
                    object_id: 'ITEM_1',
                    object_type: 'ITEM',
                    severity: 'warn'
                })
            ])
        );
    });

    test('detects public item missing only images', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                description_html: '<p>Has content</p>',
                image_ids: [],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_online_content');
        expect(issues).toHaveLength(1);
    });

    test('no issue when item is not public', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'HIDDEN',
                description_html: null,
                image_ids: [],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_online_content');
        expect(issues).toHaveLength(0);
    });

    test('no issue when public item has both description_html and images', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                description_html: '<p>Content</p>',
                image_ids: ['IMG_1'],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_online_content');
        expect(issues).toHaveLength(0);
    });

    test('treats whitespace-only description_html as missing', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                description_html: '   ',
                image_ids: ['IMG_1'],
                categories: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_online_content');
        expect(issues).toHaveLength(1);
    });
});

// ============================================================================
// CHECK 9: missing_seo_data
// ============================================================================
describe('CHECK 9: missing_seo_data', () => {
    test('detects public item missing both seo_title and seo_description', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                ecom_seo_data: {},
                categories: [], variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    check_type: 'missing_seo_data',
                    object_id: 'ITEM_1',
                    object_type: 'ITEM',
                    severity: 'warn'
                })
            ])
        );
    });

    test('detects public item missing only seo_description', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                ecom_seo_data: { page_title: 'Has Title' },
                categories: [], variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_seo_data');
        expect(issues).toHaveLength(1);
    });

    test('no issue when item is not public', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'UNINDEXED',
                ecom_seo_data: {},
                categories: [], variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_seo_data');
        expect(issues).toHaveLength(0);
    });

    test('no issue when public item has both SEO fields', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                ecom_seo_data: { page_title: 'Title', page_description: 'Description' },
                categories: [], variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'missing_seo_data');
        expect(issues).toHaveLength(0);
    });

    test('notes include suggested action for AI autofill', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                ecom_visibility: 'VISIBLE',
                ecom_seo_data: {},
                categories: [], variations: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        await runFullHealthCheck(3);
        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO catalog_location_health') &&
                 c[1] && c[1][4] === 'missing_seo_data'
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[1][8]).toContain('AI autofill'); // notes is $9
    });
});

// ============================================================================
// CHECK 10: sellable_not_tracked
// ============================================================================
describe('CHECK 10: sellable_not_tracked', () => {
    test('detects sellable variation with inventory tracking disabled', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    item_variation_data: { item_id: 'ITEM_1', sellable: true, track_inventory: false }
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
                expect.objectContaining({
                    check_type: 'sellable_not_tracked',
                    object_id: 'VAR_1',
                    object_type: 'ITEM_VARIATION',
                    severity: 'warn'
                })
            ])
        );
    });

    test('detects sellable variation where track_inventory is undefined', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    item_variation_data: { item_id: 'ITEM_1', sellable: true }
                    // track_inventory omitted — should still flag
                }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'sellable_not_tracked');
        expect(issues).toHaveLength(1);
    });

    test('no issue when sellable and tracking enabled', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    item_variation_data: { item_id: 'ITEM_1', sellable: true, track_inventory: true }
                }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'sellable_not_tracked');
        expect(issues).toHaveLength(0);
    });

    test('no issue when not sellable', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    item_variation_data: { item_id: 'ITEM_1', sellable: false, track_inventory: false }
                }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runFullHealthCheck(3);
        const issues = result.newIssues.filter(i => i.check_type === 'sellable_not_tracked');
        expect(issues).toHaveLength(0);
    });

    test('parent_id points to parent item', async () => {
        const item = buildItem('ITEM_PARENT', {
            item_data: {
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: true,
                    item_variation_data: { item_id: 'ITEM_PARENT', sellable: true, track_inventory: false }
                }],
                categories: [], image_ids: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [] });

        await runFullHealthCheck(3);
        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO catalog_location_health') &&
                 c[1] && c[1][4] === 'sellable_not_tracked'
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[1][6]).toBe('ITEM_PARENT'); // parent_id is $7
    });
});

// ============================================================================
// Resolution + idempotency
// ============================================================================
describe('resolution and idempotency', () => {
    test('does not insert duplicate when open issue exists', async () => {
        const item = buildItem('ITEM_1', {
            item_data: {
                categories: [{ id: 'CAT_MISSING' }],
                image_ids: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item]); // No category objects → category_orphan detected
        // Existing open issue for same check_type:object_id
        db.query.mockResolvedValueOnce({
            rows: [{ id: 42, check_type: 'category_orphan', variation_id: 'ITEM_1', item_id: 'ITEM_1' }]
        });
        db.query.mockResolvedValue({ rows: [] }); // legacy cleanup

        const result = await runFullHealthCheck(3);
        expect(result.newIssues).toHaveLength(0);
        expect(result.existingOpen).toBe(1);
    });

    test('resolves previously open issue that is now clean', async () => {
        const cat = { id: 'CAT_1', type: 'CATEGORY' };
        const item = buildItem('ITEM_1', {
            item_data: {
                categories: [{ id: 'CAT_1' }],
                image_ids: [], variations: [], modifier_list_info: [], tax_ids: ['TAX_1']
            }
        });

        setupSquareMocks([item, cat]); // Category exists → no category_orphan
        // Previously open category_orphan issue
        db.query.mockResolvedValueOnce({
            rows: [{ id: 42, check_type: 'category_orphan', variation_id: 'ITEM_1', item_id: 'ITEM_1' }]
        });
        db.query.mockResolvedValue({ rows: [] }); // UPDATE resolved_at + legacy cleanup

        const result = await runFullHealthCheck(3);
        expect(result.resolved).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ check_type: 'category_orphan', object_id: 'ITEM_1' })
            ])
        );
        // Verify UPDATE was called for resolution
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('resolved_at = NOW()'),
            [42]
        );
    });

    test('resolves legacy missing_tax rows on health check run', async () => {
        const item = buildItem('ITEM_1');

        setupSquareMocks([item]);
        db.query.mockResolvedValueOnce({ rows: [] }); // open issues
        db.query.mockResolvedValue({ rows: [] }); // legacy cleanup

        await runFullHealthCheck(3);
        // Verify the legacy cleanup query was called
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("check_type = 'missing_tax'"),
            [3]
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
                { id: 1, check_type: 'category_orphan', status: 'mismatch' },
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

// ============================================================================
// Constraint string-match guard
// Ensures check_type values emitted by the service match the DB CHECK constraint.
// Prevents "violates check constraint" errors from reaching production.
// ============================================================================
describe('check_type values match DB constraint', () => {
    // Allowed values from schema.sql CHECK constraint (source of truth)
    const DB_ALLOWED_CHECK_TYPES = [
        'location_mismatch',
        'orphaned_variation',
        'deleted_parent',
        'category_orphan',
        'image_orphan',
        'modifier_orphan',
        'pricing_rule_orphan',
        'missing_online_content',
        'missing_seo_data',
        'sellable_not_tracked'
    ];

    test('all check_type values in service code are in the DB constraint', async () => {
        // Build a catalog that triggers every check type
        const item = buildItem('ITEM_1', {
            present_at_all_locations: true,
            item_data: {
                ecom_visibility: 'VISIBLE',
                description_html: null,
                image_ids: ['IMG_MISSING'],
                ecom_seo_data: {},
                categories: [{ id: 'CAT_MISSING' }],
                modifier_list_info: [{ modifier_list_id: 'MOD_MISSING' }],
                variations: [{
                    id: 'VAR_1',
                    present_at_all_locations: false,  // location_mismatch
                    item_variation_data: { item_id: 'ITEM_1', sellable: true, track_inventory: false }
                }],
                tax_ids: ['TAX_1']
            }
        });
        // orphaned_variation: variation whose parent is not in the live catalog
        const orphanVar = buildVariation('VAR_ORPHAN', 'ITEM_GONE');
        // deleted_parent: variation whose parent IS in the deleted set
        const deletedParentVar = buildVariation('VAR_DELETED_PARENT', 'ITEM_DELETED');
        const deletedParent = { id: 'ITEM_DELETED', type: 'ITEM', is_deleted: true };
        const rule = {
            id: 'RULE_1', type: 'PRICING_RULE',
            pricing_rule_data: { match_products_id: 'PSET_DEL' }
        };
        const deletedPset = { id: 'PSET_DEL', type: 'PRODUCT_SET', is_deleted: true };

        setupSquareMocks(
            [item, orphanVar, deletedParentVar, rule],
            [deletedParent, deletedPset]
        );
        db.query.mockResolvedValueOnce({ rows: [] }); // open issues
        db.query.mockResolvedValue({ rows: [] }); // INSERTs + legacy cleanup

        const result = await runFullHealthCheck(3);

        // Extract all unique check_type values emitted
        const emittedTypes = new Set(result.newIssues.map(i => i.check_type));

        for (const checkType of emittedTypes) {
            expect(DB_ALLOWED_CHECK_TYPES).toContain(checkType);
        }

        // Verify we actually triggered all 10 check types
        expect(emittedTypes.size).toBe(DB_ALLOWED_CHECK_TYPES.length);
    });

    test('DB constraint list matches schema.sql', () => {
        const fs = require('fs');
        const schemaPath = require('path').join(__dirname, '../../database/schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        // Extract check_type values from the catalog_location_health CHECK constraint
        // The constraint spans multiple lines: CHECK (check_type IN (\n'val1',\n'val2',...\n))
        const match = schema.match(/CHECK\s*\(\s*check_type\s+IN\s*\(([\s\S]*?)\)\s*\)/);
        expect(match).toBeTruthy();

        const constraintValues = match[1]
            .split(',')
            .map(s => s.trim().replace(/'/g, ''))
            .filter(Boolean);

        expect(constraintValues.sort()).toEqual(DB_ALLOWED_CHECK_TYPES.sort());
    });
});
