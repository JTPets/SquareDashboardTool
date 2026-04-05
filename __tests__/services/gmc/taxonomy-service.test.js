jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../utils/escape-like', () => ({ escapeLikePattern: (s) => s }));

const db = require('../../../utils/database');
const {
    listTaxonomies,
    getMappings,
    setMapping,
    deleteMapping,
    fetchGoogleTaxonomy,
    setMappingByName,
    deleteMappingByName,
} = require('../../../services/gmc/taxonomy-service');

beforeEach(() => jest.clearAllMocks());

// ── listTaxonomies ────────────────────────────────────────────────────────────

describe('listTaxonomies', () => {
    it('returns all rows without a search term', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1, name: 'Animals & Pet Supplies' }] });
        const result = await listTaxonomies({});
        expect(result.count).toBe(1);
        expect(db.query.mock.calls[0][0]).not.toContain('ILIKE');
    });

    it('adds ILIKE clause when search is provided', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await listTaxonomies({ search: 'pet' });
        expect(db.query.mock.calls[0][0]).toContain('ILIKE');
        expect(db.query.mock.calls[0][1][0]).toContain('pet');
    });

    it('adds LIMIT clause when limit is provided', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await listTaxonomies({ limit: '10' });
        expect(db.query.mock.calls[0][0]).toContain('LIMIT');
    });
});

// ── getMappings ───────────────────────────────────────────────────────────────

describe('getMappings', () => {
    it('queries with merchantId and returns mappings', async () => {
        db.query.mockResolvedValue({ rows: [{ category_id: 'cat-1', google_taxonomy_name: 'Dogs' }] });
        const result = await getMappings(10);
        expect(result.count).toBe(1);
        expect(db.query.mock.calls[0][1]).toContain(10);
    });
});

// ── setMapping ────────────────────────────────────────────────────────────────

describe('setMapping', () => {
    it('returns { notFound: "category" } when category missing', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // category check
        expect(await setMapping(10, 'cat-x', 5)).toEqual({ notFound: 'category' });
    });

    it('deletes mapping and returns { removed: true } when taxonomyId is falsy', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 'cat-1' }] }); // category check
        db.query.mockResolvedValueOnce({ rows: [] });                  // DELETE
        expect(await setMapping(10, 'cat-1', null)).toEqual({ removed: true });
        expect(db.query.mock.calls[1][0]).toContain('DELETE');
    });

    it('upserts mapping and returns {} on success', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 'cat-1' }] }); // category check
        db.query.mockResolvedValueOnce({ rows: [] });                  // upsert
        expect(await setMapping(10, 'cat-1', 42)).toEqual({});
        expect(db.query.mock.calls[1][0]).toContain('INSERT');
    });

    it('passes merchantId to every query', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 'cat-1' }] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await setMapping(99, 'cat-1', 5);
        for (const call of db.query.mock.calls) {
            expect(call[1]).toContain(99);
        }
    });
});

// ── deleteMapping ─────────────────────────────────────────────────────────────

describe('deleteMapping', () => {
    it('executes DELETE with correct merchantId and categoryId', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await deleteMapping(10, 'cat-1');
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('DELETE');
        expect(params).toEqual(['cat-1', 10]);
    });
});

// ── fetchGoogleTaxonomy ───────────────────────────────────────────────────────

describe('fetchGoogleTaxonomy', () => {
    afterEach(() => { delete global.fetch; });

    it('parses taxonomy file and returns imported count', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => '# Google_Product_Taxonomy_Version: 2021-09-23\n5 - Animals & Pet Supplies\n6 - Animals & Pet Supplies > Live Animals\n',
        });
        db.query.mockResolvedValue({ rows: [] });
        const result = await fetchGoogleTaxonomy();
        expect(result.imported).toBe(2);
        expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('throws when HTTP response is not ok', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
        await expect(fetchGoogleTaxonomy()).rejects.toThrow('503');
    });

    it('skips blank lines and header line', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => '# header\n\n5 - Animals\n\n',
        });
        db.query.mockResolvedValue({ rows: [] });
        const result = await fetchGoogleTaxonomy();
        expect(result.imported).toBe(1);
    });
});

// ── setMappingByName ──────────────────────────────────────────────────────────

describe('setMappingByName', () => {
    it('finds existing category and upserts mapping', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'cat-dogs' }] }) // find category
            .mockResolvedValueOnce({ rows: [] });                    // upsert
        const result = await setMappingByName(10, 'Dogs', 5);
        expect(result.category_id).toBe('cat-dogs');
    });

    it('creates category when not found', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })                              // category not found
            .mockResolvedValueOnce({ rows: [{ id: 'Dogs' }] })               // INSERT category
            .mockResolvedValueOnce({ rows: [] });                              // upsert mapping
        const result = await setMappingByName(10, 'Dogs', 5);
        expect(result.category_id).toBe('Dogs');
        expect(db.query.mock.calls[1][0]).toContain('INSERT INTO categories');
    });
});

// ── deleteMappingByName ───────────────────────────────────────────────────────

describe('deleteMappingByName', () => {
    it('returns { notFound: "category" } when category missing', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await deleteMappingByName(10, 'Unknown')).toEqual({ notFound: 'category' });
    });

    it('deletes mapping and returns {} on success', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'cat-1' }] }) // find category
            .mockResolvedValueOnce({ rows: [] });                 // DELETE
        expect(await deleteMappingByName(10, 'Dogs')).toEqual({});
        expect(db.query.mock.calls[1][0]).toContain('DELETE');
    });
});
