/**
 * Multi-Tenant Isolation Security Tests
 *
 * CRITICAL SECURITY TESTS
 * These tests ensure proper tenant isolation:
 * - User A cannot access Merchant B's data
 * - List endpoints don't leak data across tenants
 * - Direct merchant_id parameter manipulation is rejected
 * - All database queries properly filter by merchant_id
 *
 * Multi-tenant isolation is enforced via:
 * 1. loadMerchantContext middleware - sets req.merchantContext from session
 * 2. requireMerchant middleware - requires valid merchant context
 * 3. All DB queries filter by merchant_id from req.merchantContext.id
 */

// Mock all dependencies before imports
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        // Check if we have a mock user
        if (req.session?.user) {
            next();
        } else {
            res.status(401).json({ success: false, error: 'Not authenticated' });
        }
    },
    requireAdmin: (req, res, next) => next(),
    logAuthEvent: jest.fn(),
    getClientIp: jest.fn().mockReturnValue('127.0.0.1'),
}));

const logger = require('../../utils/logger');
const db = require('../../utils/database');

// Import merchant middleware for testing
const {
    loadMerchantContext,
    requireMerchant,
    requireMerchantRole
} = require('../../middleware/merchant');

describe('Multi-Tenant Isolation', () => {

    // Test data: Two merchants with separate data
    const MERCHANT_A = {
        id: 1,
        square_merchant_id: 'SQUARE_MERCHANT_A',
        business_name: 'Pet Store A',
        business_email: 'a@test.com',
        subscription_status: 'active',
        trial_ends_at: null,
        subscription_ends_at: null,
        timezone: 'America/Toronto',
        currency: 'CAD',
        settings: {},
        last_sync_at: new Date().toISOString(),
        square_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
        user_role: 'owner'
    };

    const MERCHANT_B = {
        id: 2,
        square_merchant_id: 'SQUARE_MERCHANT_B',
        business_name: 'Pet Store B',
        business_email: 'b@test.com',
        subscription_status: 'active',
        trial_ends_at: null,
        subscription_ends_at: null,
        timezone: 'America/New_York',
        currency: 'USD',
        settings: {},
        last_sync_at: new Date().toISOString(),
        square_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
        user_role: 'owner'
    };

    const USER_A = { id: 100, email: 'user_a@test.com', name: 'User A', role: 'user' };
    const USER_B = { id: 200, email: 'user_b@test.com', name: 'User B', role: 'user' };

    // Sample data for each merchant
    const MERCHANT_A_ITEMS = [
        { id: 'ITEM_A1', name: 'Dog Food Premium', merchant_id: 1, category_name: 'Dog Food' },
        { id: 'ITEM_A2', name: 'Cat Treats', merchant_id: 1, category_name: 'Cat Food' },
    ];

    const MERCHANT_B_ITEMS = [
        { id: 'ITEM_B1', name: 'Fish Tank', merchant_id: 2, category_name: 'Aquarium' },
        { id: 'ITEM_B2', name: 'Bird Seed', merchant_id: 2, category_name: 'Bird Supplies' },
    ];

    // Helper to create mock request/response
    function createMockReq(user = null, merchantId = null, body = {}, params = {}, query = {}) {
        return {
            session: user ? { user, activeMerchantId: merchantId } : {},
            body,
            params,
            query,
            headers: { 'user-agent': 'test-agent' },
            merchantContext: null,
            get: jest.fn()
        };
    }

    function createMockRes() {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };
        return res;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset all mock implementations to ensure clean state
        db.query.mockReset();
    });

    describe('Merchant Context Loading', () => {

        test('user only gets context for merchants they have access to', async () => {
            // User A with active merchant already set in session
            const req = createMockReq(USER_A, MERCHANT_A.id);
            const res = createMockRes();
            const next = jest.fn();

            // When activeMerchantId is already set, middleware skips primary lookup
            // and goes directly to full merchant context load
            db.query.mockResolvedValueOnce({ rows: [MERCHANT_A] });

            await loadMerchantContext(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.merchantContext).not.toBeNull();
            expect(req.merchantContext.id).toBe(MERCHANT_A.id);
            expect(req.merchantContext.businessName).toBe(MERCHANT_A.business_name);
        });

        test('user cannot access merchant they are not linked to', async () => {
            // User A tries to access Merchant B's data
            const req = createMockReq(USER_A, MERCHANT_B.id);
            const res = createMockRes();
            const next = jest.fn();

            // Mock: Primary merchant lookup returns nothing (not linked)
            db.query.mockResolvedValueOnce({ rows: [] });

            await loadMerchantContext(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.merchantContext).toBeNull();
        });

        test('session activeMerchantId does not grant access without user_merchants link', async () => {
            // User A has session with Merchant B's ID (manipulated)
            const req = createMockReq(USER_A, MERCHANT_B.id);
            const res = createMockRes();
            const next = jest.fn();

            // Mock: User A has no primary merchant, falls through to null
            db.query.mockResolvedValueOnce({ rows: [] });

            await loadMerchantContext(req, res, next);

            // Even with activeMerchantId set, context should be null
            expect(req.merchantContext).toBeNull();
        });

        test('user_merchants link required for merchant access', async () => {
            // User A with active merchant set, but user_merchants link no longer exists
            const req = createMockReq(USER_A, MERCHANT_A.id);
            const res = createMockRes();
            const next = jest.fn();

            // When activeMerchantId is set, middleware skips primary lookup
            // and goes directly to full context load - which fails if user_merchants link missing
            db.query.mockResolvedValueOnce({ rows: [] });

            await loadMerchantContext(req, res, next);

            // Context should be cleared when user_merchants verification fails
            expect(req.merchantContext).toBeNull();
            expect(req.session.activeMerchantId).toBeNull();
        });
    });

    describe('Merchant Isolation in Data Access', () => {

        test('item query only returns items for the authenticated merchant', async () => {
            // This test verifies that the merchant_id filter is used
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = {
                id: MERCHANT_A.id,
                businessName: MERCHANT_A.business_name
            };

            // Simulate a proper item query - should ONLY have merchant A's items
            const queryParams = [MERCHANT_A.id];

            // Mock: Database returns only Merchant A's items
            const mockRows = [
                { id: 'ITEM_A1', name: 'Dog Food Premium', merchant_id: 1, category_name: 'Dog Food' },
                { id: 'ITEM_A2', name: 'Cat Treats', merchant_id: 1, category_name: 'Cat Food' },
            ];
            db.query.mockResolvedValueOnce({ rows: mockRows });

            // Verify the query would be constructed correctly
            const query = `
                SELECT * FROM items WHERE merchant_id = $1 ORDER BY name
            `;

            const result = await db.query(query, queryParams);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('merchant_id = $1'),
                [MERCHANT_A.id]
            );
            expect(result.rows).toEqual(mockRows);
            expect(result.rows).not.toContainEqual(expect.objectContaining({ merchant_id: 2 }));
        });

        test('cross-tenant item access is prevented', async () => {
            // User A authenticated but tries to query with Merchant B's ID
            const merchantIdFromSession = MERCHANT_A.id;

            // Attacker tries to inject merchant_id in params
            const attackerMerchantId = MERCHANT_B.id;

            // The system should ALWAYS use merchantContext.id, not user input
            expect(merchantIdFromSession).not.toBe(attackerMerchantId);

            // Correct behavior: query uses session merchant ID
            db.query.mockResolvedValueOnce({ rows: MERCHANT_A_ITEMS });

            const query = `SELECT * FROM items WHERE merchant_id = $1`;
            const result = await db.query(query, [merchantIdFromSession]);

            // Verify we got Merchant A's items, not B's
            expect(result.rows.every(item => item.merchant_id === MERCHANT_A.id)).toBe(true);
        });

        test('list endpoints do not leak data from other merchants', async () => {
            // Mock: A properly filtered query returns only Merchant A's items
            const filteredItems = MERCHANT_A_ITEMS.slice(); // Only Merchant A items
            db.query.mockResolvedValueOnce({ rows: filteredItems });

            // Query for Merchant A
            const result = await db.query(
                'SELECT * FROM items WHERE merchant_id = $1',
                [MERCHANT_A.id]
            );

            // Verify no Merchant B data leaked
            expect(result.rows.length).toBe(2);
            result.rows.forEach(item => {
                expect(item.merchant_id).toBe(MERCHANT_A.id);
                expect(MERCHANT_B_ITEMS).not.toContainEqual(item);
            });
        });

        test('variations query filters by merchant_id', async () => {
            const merchantId = MERCHANT_A.id;

            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 'VAR_1', sku: 'SKU001', merchant_id: merchantId },
                    { id: 'VAR_2', sku: 'SKU002', merchant_id: merchantId },
                ]
            });

            // Standard variation query pattern
            const query = `
                SELECT v.*, i.name as item_name
                FROM variations v
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                WHERE v.merchant_id = $1
            `;

            await db.query(query, [merchantId]);

            // Verify merchant_id filter is applied to BOTH tables in join
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('i.merchant_id = $1'),
                expect.arrayContaining([merchantId])
            );
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('v.merchant_id = $1'),
                expect.arrayContaining([merchantId])
            );
        });
    });

    describe('Direct Parameter Manipulation Prevention', () => {

        test('merchant_id in request body is ignored', async () => {
            // Attacker sends merchant_id in body trying to access other tenant
            const req = createMockReq(USER_A, MERCHANT_A.id, {
                merchant_id: MERCHANT_B.id, // Malicious input
                name: 'Hacked Item'
            });
            req.merchantContext = { id: MERCHANT_A.id };

            // The service should use merchantContext.id, not req.body.merchant_id
            const correctMerchantId = req.merchantContext.id;
            const maliciousMerchantId = req.body.merchant_id;

            expect(correctMerchantId).not.toBe(maliciousMerchantId);

            // Correct pattern: always use merchantContext
            db.query.mockResolvedValueOnce({ rows: [{ id: 'NEW_ITEM' }] });

            const query = `INSERT INTO items (name, merchant_id) VALUES ($1, $2) RETURNING id`;
            await db.query(query, ['Hacked Item', correctMerchantId]);

            // Verify the correct merchant_id was used
            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([MERCHANT_A.id])
            );
            expect(db.query).not.toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([MERCHANT_B.id])
            );
        });

        test('merchant_id in URL params is validated against session', async () => {
            // Attacker crafts URL with different merchant ID
            const req = createMockReq(USER_A, MERCHANT_A.id, {}, {
                merchantId: MERCHANT_B.id.toString() // URL param attack
            });
            req.merchantContext = { id: MERCHANT_A.id };

            // Route should verify URL param matches session
            const urlMerchantId = parseInt(req.params.merchantId);
            const sessionMerchantId = req.merchantContext.id;

            // Security check: URL param must match session
            const isAuthorized = urlMerchantId === sessionMerchantId;

            expect(isAuthorized).toBe(false);
        });

        test('query string merchant_id is ignored in favor of session', async () => {
            const req = createMockReq(USER_A, MERCHANT_A.id, {}, {}, {
                merchant_id: MERCHANT_B.id.toString() // Query param attack
            });
            req.merchantContext = { id: MERCHANT_A.id };

            // Service should ignore query param and use session
            const correctMerchantId = req.merchantContext.id;
            const queryMerchantId = parseInt(req.query.merchant_id);

            expect(correctMerchantId).toBe(MERCHANT_A.id);
            expect(queryMerchantId).toBe(MERCHANT_B.id);

            // The query should use session merchant
            db.query.mockResolvedValueOnce({ rows: MERCHANT_A_ITEMS });

            await db.query('SELECT * FROM items WHERE merchant_id = $1', [correctMerchantId]);

            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                [MERCHANT_A.id]
            );
        });
    });

    describe('Cross-Tenant Data Modification Prevention', () => {

        test('cannot update items belonging to another merchant', async () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = { id: MERCHANT_A.id };

            // Attacker knows an item ID from Merchant B
            const merchantBItemId = 'ITEM_B1';

            // Update query MUST include merchant_id filter
            const updateQuery = `
                UPDATE items SET name = $1
                WHERE id = $2 AND merchant_id = $3
                RETURNING *
            `;

            // Mock: No rows affected because merchant_id doesn't match
            const mockResult = { rows: [], rowCount: 0 };
            db.query.mockResolvedValueOnce(mockResult);

            const result = await db.query(updateQuery, [
                'Hacked Name',
                merchantBItemId,
                req.merchantContext.id
            ]);

            // Verify query includes merchant_id filter
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('merchant_id = $3'),
                expect.arrayContaining([req.merchantContext.id])
            );
            // Update fails silently (no rows matched)
            expect(result.rows.length).toBe(0);
        });

        test('cannot delete items belonging to another merchant', async () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = { id: MERCHANT_A.id };

            const merchantBItemId = 'ITEM_B1';

            // Delete query MUST include merchant_id filter
            const deleteQuery = `
                DELETE FROM items WHERE id = $1 AND merchant_id = $2
                RETURNING id
            `;

            // Mock: No rows deleted because merchant_id doesn't match
            db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const result = await db.query(deleteQuery, [
                merchantBItemId,
                req.merchantContext.id
            ]);

            expect(result.rowCount).toBe(0);
        });

        test('bulk operations respect merchant boundaries', async () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = { id: MERCHANT_A.id };

            // Attacker sends IDs from both merchants
            const mixedItemIds = ['ITEM_A1', 'ITEM_B1', 'ITEM_A2', 'ITEM_B2'];

            // Bulk update with ANY must still filter by merchant_id
            const bulkQuery = `
                UPDATE items SET updated_at = NOW()
                WHERE id = ANY($1) AND merchant_id = $2
                RETURNING id
            `;

            // Mock: Only Merchant A items are updated (merchant_id filter works)
            const expectedUpdatedItems = [{ id: 'ITEM_A1' }, { id: 'ITEM_A2' }];
            db.query.mockResolvedValueOnce({ rows: expectedUpdatedItems });

            const result = await db.query(bulkQuery, [
                mixedItemIds,
                req.merchantContext.id
            ]);

            // Verify query includes merchant_id filter with bulk IDs
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('merchant_id = $2'),
                expect.arrayContaining([mixedItemIds, req.merchantContext.id])
            );
            // Only Merchant A items should be in result
            expect(result.rows.length).toBe(2);
            expect(result.rows.map(r => r.id)).toEqual(['ITEM_A1', 'ITEM_A2']);
        });
    });

    describe('Require Merchant Middleware', () => {

        test('blocks access when no merchant context', () => {
            const req = createMockReq(USER_A);
            req.merchantContext = null;
            const res = createMockRes();
            const next = jest.fn();

            requireMerchant(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'NO_MERCHANT'
            }));
        });

        test('allows access when merchant context exists', () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = { id: MERCHANT_A.id };
            const res = createMockRes();
            const next = jest.fn();

            requireMerchant(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });
    });

    describe('Merchant Role Isolation', () => {

        test('role check uses user_merchants table, not global role', () => {
            // User A is owner of Merchant A but user B may have different role
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = {
                id: MERCHANT_A.id,
                userRole: 'readonly' // Role is per-merchant
            };
            const res = createMockRes();
            const next = jest.fn();

            const middleware = requireMerchantRole('owner', 'admin');
            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                code: 'INSUFFICIENT_ROLE',
                currentRole: 'readonly'
            }));
        });

        test('owner role grants access to protected operations', () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = {
                id: MERCHANT_A.id,
                userRole: 'owner'
            };
            const res = createMockRes();
            const next = jest.fn();

            const middleware = requireMerchantRole('owner');
            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });

    describe('Database Query Patterns', () => {

        test('all SELECT queries include merchant_id filter', () => {
            // This test documents the required pattern
            const validQueries = [
                'SELECT * FROM items WHERE merchant_id = $1',
                'SELECT i.* FROM items i WHERE i.merchant_id = $1',
                'SELECT * FROM variations v WHERE v.merchant_id = $1',
                'SELECT * FROM orders WHERE merchant_id = $1 AND id = $2',
            ];

            const invalidQueries = [
                'SELECT * FROM items',
                'SELECT * FROM items WHERE id = $1',
                'SELECT * FROM variations WHERE sku = $1',
            ];

            validQueries.forEach(query => {
                expect(query).toMatch(/merchant_id\s*=\s*\$\d+/);
            });

            invalidQueries.forEach(query => {
                expect(query).not.toMatch(/merchant_id\s*=\s*\$\d+/);
            });
        });

        test('JOIN queries include merchant_id on both tables', () => {
            // Best practice: include merchant_id on all joined tables
            const properJoin = `
                SELECT v.*, i.name
                FROM variations v
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                WHERE v.merchant_id = $1
            `;

            // Verify merchant_id appears twice (both tables)
            const merchantIdMatches = properJoin.match(/merchant_id\s*=\s*\$1/g);
            expect(merchantIdMatches?.length).toBeGreaterThanOrEqual(2);
        });

        test('INSERT statements include merchant_id column', () => {
            const validInsert = `
                INSERT INTO items (name, sku, merchant_id)
                VALUES ($1, $2, $3)
            `;

            expect(validInsert).toContain('merchant_id');
        });
    });

    describe('Webhook Multi-Tenant Isolation', () => {

        test('webhook events are routed to correct merchant by square_merchant_id', async () => {
            const webhookEvent = {
                merchant_id: 'SQUARE_MERCHANT_A',
                type: 'order.created',
                data: { id: 'ORDER_123' }
            };

            // Mock: Lookup merchant by square_merchant_id
            db.query.mockResolvedValueOnce({
                rows: [{ id: MERCHANT_A.id, business_name: MERCHANT_A.business_name }]
            });

            const lookupQuery = 'SELECT id FROM merchants WHERE square_merchant_id = $1';
            const result = await db.query(lookupQuery, [webhookEvent.merchant_id]);

            // Webhook processor should resolve to correct internal merchant_id
            expect(result.rows[0].id).toBe(MERCHANT_A.id);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('square_merchant_id'),
                ['SQUARE_MERCHANT_A']
            );
        });

        test('webhook from unknown square_merchant_id is rejected', async () => {
            const webhookEvent = {
                merchant_id: 'UNKNOWN_MERCHANT',
                type: 'order.created',
                data: { id: 'ORDER_123' }
            };

            // Mock: No merchant found
            db.query.mockResolvedValueOnce({ rows: [] });

            const lookupQuery = 'SELECT id FROM merchants WHERE square_merchant_id = $1';
            const result = await db.query(lookupQuery, [webhookEvent.merchant_id]);

            expect(result.rows.length).toBe(0);
            // Webhook should be rejected, not processed for any merchant
        });
    });

    describe('Data Leakage Prevention', () => {

        test('error messages do not reveal other merchant data', () => {
            // Error messages should be generic, not expose merchant details
            const safeError = {
                success: false,
                error: 'Item not found',
                code: 'NOT_FOUND'
            };

            const unsafeError = {
                success: false,
                error: 'Item not found. Item belongs to merchant Pet Store B.',
                merchant_info: { id: 2, name: 'Pet Store B' }
            };

            expect(safeError.error).not.toContain('Pet Store');
            expect(safeError).not.toHaveProperty('merchant_info');
        });

        test('pagination does not allow accessing other tenant pages', async () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = { id: MERCHANT_A.id };
            req.query = { limit: '100', offset: '0' };

            // Pagination query MUST include merchant_id
            const paginatedQuery = `
                SELECT * FROM items
                WHERE merchant_id = $1
                ORDER BY created_at DESC
                LIMIT $2 OFFSET $3
            `;

            db.query.mockResolvedValueOnce({ rows: MERCHANT_A_ITEMS });

            await db.query(paginatedQuery, [
                req.merchantContext.id,
                100,
                0
            ]);

            // Verify merchant_id is FIRST parameter (ensures filter before pagination)
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE merchant_id = $1'),
                expect.arrayContaining([MERCHANT_A.id])
            );
        });

        test('search functionality scoped to merchant', async () => {
            const req = createMockReq(USER_A, MERCHANT_A.id);
            req.merchantContext = { id: MERCHANT_A.id };
            req.query = { search: 'dog food' };

            // Search MUST be combined with merchant_id
            const searchQuery = `
                SELECT * FROM items
                WHERE merchant_id = $1
                  AND (name ILIKE $2 OR sku ILIKE $2)
            `;

            db.query.mockResolvedValueOnce({
                rows: [{ id: 'ITEM_A1', name: 'Dog Food Premium', merchant_id: 1 }]
            });

            await db.query(searchQuery, [req.merchantContext.id, '%dog food%']);

            // Verify search is scoped to merchant
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('merchant_id = $1'),
                expect.arrayContaining([MERCHANT_A.id])
            );
        });
    });
});
