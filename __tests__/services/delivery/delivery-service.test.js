/**
 * Tests for services/delivery/delivery-service.js
 *
 * Covers: order CRUD, route generation/finishing, geocoding, POD handling,
 * Square order ingestion, route sharing tokens, customer backfill,
 * state transitions, BigInt safety, ORS key encryption.
 */

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const path = require('path');

// Mock token encryption
const mockEncryptToken = jest.fn(val => `encrypted:${val}`);
const mockDecryptToken = jest.fn(val => val.replace('encrypted:', ''));
const mockIsEncryptedToken = jest.fn(val => val?.startsWith('encrypted:'));
jest.mock('../../../utils/token-encryption', () => ({
    encryptToken: mockEncryptToken,
    decryptToken: mockDecryptToken,
    isEncryptedToken: mockIsEncryptedToken
}));

// Mock customer details service
const mockGetCustomerDetails = jest.fn();
jest.mock('../../../services/loyalty-admin/customer-details-service', () => ({
    getCustomerDetails: mockGetCustomerDetails
}));

// Mock fs.promises
const mockFs = {
    mkdir: jest.fn().mockResolvedValue(),
    writeFile: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    access: jest.fn().mockResolvedValue()
};
jest.mock('fs', () => ({ promises: mockFs }));

// Mock global fetch for geocoding/route optimization
const mockFetch = jest.fn();
global.fetch = mockFetch;

const deliveryService = require('../../../services/delivery/delivery-service');

const MERCHANT_ID = 1;
const UUID = '12345678-1234-1234-1234-123456789abc';
const UUID2 = '22345678-1234-1234-1234-123456789abc';

beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.OPENROUTESERVICE_API_KEY;
    // Re-apply default mock behavior (restoreMocks: true in jest.config clears between tests)
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    db.transaction.mockImplementation(async (fn) => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        return fn(mockClient);
    });
    db.getClient.mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
    });
    // Re-apply token encryption mocks
    mockEncryptToken.mockImplementation(val => `encrypted:${val}`);
    mockDecryptToken.mockImplementation(val => val.replace('encrypted:', ''));
    mockIsEncryptedToken.mockImplementation(val => val?.startsWith('encrypted:'));
    // Re-apply fs mocks
    mockFs.mkdir.mockResolvedValue();
    mockFs.writeFile.mockResolvedValue();
    mockFs.unlink.mockResolvedValue();
    // Re-apply customer details and fetch mocks
    mockGetCustomerDetails.mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

describe('safeJsonStringify (via createOrder)', () => {
    it('handles BigInt values in Square order data', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                _inserted: true,
                square_order_data: null
            }]
        });

        // The function should not throw when squareOrderData contains BigInt
        await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Test Customer',
            address: '123 Main St',
            squareOrderData: {
                totalMoney: { amount: BigInt(1500), currency: 'CAD' }
            }
        });

        // Verify the serialized data doesn't contain BigInt
        const insertCall = db.query.mock.calls[0];
        const serializedData = insertCall[1][12]; // squareOrderData param
        expect(serializedData).toContain('1500');
        expect(() => JSON.parse(serializedData)).not.toThrow();
    });
});

describe('validateUUID (via getOrderById)', () => {
    it('throws for invalid UUID format', async () => {
        await expect(deliveryService.getOrderById(MERCHANT_ID, 'not-a-uuid'))
            .rejects.toThrow('Invalid order ID format');
    });

    it('throws for empty ID', async () => {
        await expect(deliveryService.getOrderById(MERCHANT_ID, ''))
            .rejects.toThrow('Invalid order ID format');
    });

    it('accepts valid UUID', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const result = await deliveryService.getOrderById(MERCHANT_ID, UUID);
        expect(result).toBeNull();
    });
});

// ============================================================================
// ORDER CRUD
// ============================================================================

describe('getOrders', () => {
    it('returns orders for merchant', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, customer_name: 'Alice', status: 'pending' }]
        });

        const orders = await deliveryService.getOrders(MERCHANT_ID);

        expect(orders).toHaveLength(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('merchant_id = $1'),
            expect.arrayContaining([MERCHANT_ID])
        );
    });

    it('filters by status array', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.getOrders(MERCHANT_ID, {
            status: ['pending', 'active']
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('IN ($2, $3)');
    });

    it('filters by single status', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.getOrders(MERCHANT_ID, { status: 'pending' });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('dord.status = $2');
    });

    it('excludes completed by default', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.getOrders(MERCHANT_ID, {});

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain("status != 'completed'");
    });

    it('includes completed when requested', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.getOrders(MERCHANT_ID, { includeCompleted: true });

        const sql = db.query.mock.calls[0][0];
        expect(sql).not.toContain("status != 'completed'");
    });

    it('filters by date range', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.getOrders(MERCHANT_ID, {
            dateFrom: '2026-03-01',
            dateTo: '2026-03-15',
            includeCompleted: true
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('dord.updated_at >=');
        expect(sql).toContain('dord.updated_at <');
    });
});

describe('createOrder', () => {
    it('creates manual order (no squareOrderId)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                customer_name: 'Alice',
                _inserted: true
            }]
        });

        const order = await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Alice',
            address: '123 Main St',
            phone: '555-0100'
        });

        expect(order.customer_name).toBe('Alice');
        expect(order).not.toHaveProperty('_inserted');
        const sql = db.query.mock.calls[0][0];
        expect(sql).not.toContain('ON CONFLICT');
    });

    it('uses ON CONFLICT for Square-linked orders', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                customer_name: 'Bob',
                _inserted: false
            }]
        });

        await deliveryService.createOrder(MERCHANT_ID, {
            squareOrderId: 'SQ_ORDER_1',
            customerName: 'Bob',
            address: '456 Oak Ave'
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('ON CONFLICT (square_order_id, merchant_id)');
    });

    it('sets geocoded_at when coordinates provided', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true }]
        });

        await deliveryService.createOrder(MERCHANT_ID, {
            customerName: 'Alice',
            address: '123 Main St',
            addressLat: 43.65,
            addressLng: -79.38
        });

        const params = db.query.mock.calls[0][1];
        expect(params[11]).not.toBeNull(); // geocodedAt
    });
});

describe('updateOrder', () => {
    it('converts camelCase to snake_case', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, customer_name: 'Updated' }]
        });

        await deliveryService.updateOrder(MERCHANT_ID, UUID, {
            customerName: 'Updated',
            addressLat: 43.65
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('customer_name');
        expect(sql).toContain('address_lat');
    });

    it('ignores unknown fields', async () => {
        // When no valid fields, it should call getOrderById instead
        db.query.mockResolvedValueOnce({ rows: [{ id: UUID }] });

        await deliveryService.updateOrder(MERCHANT_ID, UUID, {
            unknownField: 'value'
        });

        // Falls through to getOrderById
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('SELECT');
    });

    it('serializes squareOrderData as JSON', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID }]
        });

        await deliveryService.updateOrder(MERCHANT_ID, UUID, {
            squareOrderData: { lineItems: [{ name: 'Item 1' }] }
        });

        const params = db.query.mock.calls[0][1];
        const jsonParam = params.find(p => typeof p === 'string' && p.includes('lineItems'));
        expect(jsonParam).toBeDefined();
        expect(() => JSON.parse(jsonParam)).not.toThrow();
    });
});

describe('deleteOrder', () => {
    it('only deletes manual non-completed orders', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: UUID }] });

        const result = await deliveryService.deleteOrder(MERCHANT_ID, UUID);

        expect(result).toBe(true);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('square_order_id IS NULL');
        expect(sql).toContain("status NOT IN ('completed', 'delivered')");
    });

    it('returns false when order cannot be deleted', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.deleteOrder(MERCHANT_ID, UUID);

        expect(result).toBe(false);
    });
});

// ============================================================================
// STATE TRANSITIONS
// ============================================================================

describe('order state transitions', () => {
    it('skipOrder sets status to skipped and logs audit', async () => {
        db.query
            // getOrderById (status guard — must be active)
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'active', merchant_id: MERCHANT_ID }] })
            // updateOrder
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'skipped' }] })
            // logAuditEvent
            .mockResolvedValueOnce({ rows: [] });

        const order = await deliveryService.skipOrder(MERCHANT_ID, UUID, 1);

        expect(order.status).toBe('skipped');
    });

    it('markDelivered sets status to delivered', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: UUID, status: 'delivered' }] });

        const order = await deliveryService.markDelivered(MERCHANT_ID, UUID);

        expect(order.status).toBe('delivered');
    });

    it('completeOrder sets status and synced_at', async () => {
        db.query
            // getOrderById (status guard — must be active/delivered/skipped)
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'active', merchant_id: MERCHANT_ID }] })
            // updateOrder
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'completed', square_order_id: 'SQ1' }] })
            // logAuditEvent
            .mockResolvedValueOnce({ rows: [] });

        const order = await deliveryService.completeOrder(MERCHANT_ID, UUID, 1);

        expect(order.status).toBe('completed');
    });
});

// ============================================================================
// ROUTE MANAGEMENT
// ============================================================================

describe('getActiveRoute', () => {
    it('queries for active route on given date', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, route_date: '2026-03-15', status: 'active' }]
        });

        const route = await deliveryService.getActiveRoute(MERCHANT_ID, '2026-03-15');

        expect(route).not.toBeNull();
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("dr.status = 'active'"),
            [MERCHANT_ID, '2026-03-15']
        );
    });

    it('returns null when no active route', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const route = await deliveryService.getActiveRoute(MERCHANT_ID);

        expect(route).toBeNull();
    });
});

describe('generateRoute', () => {
    it('throws when no start address configured', async () => {
        // getActiveRoute
        db.query.mockResolvedValueOnce({ rows: [] });
        // getSettings returns null start_address
        db.query.mockResolvedValueOnce({ rows: [{ start_address: null }] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, 1, {})
        ).rejects.toThrow('Start address not configured');
    });

    it('throws when no geocoded pending orders', async () => {
        // getActiveRoute
        db.query.mockResolvedValueOnce({ rows: [] });
        // getSettings
        db.query.mockResolvedValueOnce({
            rows: [{
                start_address: '100 Queen St',
                start_address_lat: '43.65',
                start_address_lng: '-79.38'
            }]
        });
        // Reset stale skipped orders (no stale skipped orders)
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // No pending orders
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, 1, {})
        ).rejects.toThrow('No geocoded pending orders');
    });

    it('includes skipped orders from non-active routes in next route generation', async () => {
        // getActiveRoute — no active route today
        db.query.mockResolvedValueOnce({ rows: [] });
        // getSettings
        db.query.mockResolvedValueOnce({
            rows: [{
                start_address: '100 Queen St',
                start_address_lat: '43.65',
                start_address_lng: '-79.38',
                openrouteservice_api_key: null
            }]
        });
        // Reset stale skipped orders — 1 order reset (was skipped on yesterday's finished route)
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // Pending orders query — now returns the previously-skipped order (after reset)
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                status: 'pending',
                address_lat: '43.70',
                address_lng: '-79.42',
                geocoded_at: new Date()
            }]
        });

        // Transaction client
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: UUID2, status: 'finished' }] }) // no existing active route to cancel (route result for INSERT)
                .mockResolvedValueOnce({ rows: [{ id: UUID2, route_date: '2026-04-02', status: 'active', total_stops: 1 }] }) // INSERT route
                .mockResolvedValueOnce({ rows: [] }) // UPDATE order → active
                .mockResolvedValueOnce({ rows: [] }), // COMMIT
            release: jest.fn()
        };
        db.getClient.mockResolvedValueOnce(mockClient);

        // getOrders (called after route creation to return route with orders)
        db.query.mockResolvedValueOnce({ rows: [{ id: UUID, status: 'active', route_id: UUID2 }] });
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });

        // Should not throw — the previously-skipped order is now available
        await expect(
            deliveryService.generateRoute(MERCHANT_ID, 1, {})
        ).resolves.toBeDefined();

        // Verify the reset query was called with the right merchant
        const resetCall = db.query.mock.calls.find(call =>
            typeof call[0] === 'string' && call[0].includes("status = 'skipped'") && call[0].includes('NOT IN')
        );
        expect(resetCall).toBeDefined();
        expect(resetCall[1]).toEqual([MERCHANT_ID]);
    });

    it('throws when active route exists without force', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, status: 'active' }]
        });
        // getSettings
        db.query.mockResolvedValueOnce({
            rows: [{ start_address: '100 Queen St' }]
        });

        await expect(
            deliveryService.generateRoute(MERCHANT_ID, 1, {})
        ).rejects.toThrow('An active route already exists');
    });
});

describe('finishRoute', () => {
    it('rolls skipped orders back to pending', async () => {
        const mockClient = {
            query: jest.fn()
                // BEGIN
                .mockResolvedValueOnce({ rows: [] })
                // Get route
                .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'active' }] })
                // Stats
                .mockResolvedValueOnce({
                    rows: [{ completed: '3', skipped: '2', delivered: '1', still_active: '1' }]
                })
                // Auto-complete delivered (BUG-002 fix)
                .mockResolvedValueOnce({ rows: [] })
                // Roll back skipped/active
                .mockResolvedValueOnce({ rows: [] })
                // Mark finished
                .mockResolvedValueOnce({ rows: [] })
                // COMMIT
                .mockResolvedValueOnce({ rows: [] }),
            release: jest.fn()
        };
        db.getClient.mockResolvedValueOnce(mockClient);
        // logAuditEvent
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.finishRoute(MERCHANT_ID, UUID, 1);

        expect(result.completed).toBe(3);
        expect(result.skipped).toBe(2);
        expect(result.rolledBack).toBe(3); // 2 skipped + 1 still_active
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('throws for non-existent route', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] }) // BEGIN
                .mockResolvedValueOnce({ rows: [] }), // Route not found
            release: jest.fn()
        };
        db.getClient.mockResolvedValueOnce(mockClient);

        await expect(deliveryService.finishRoute(MERCHANT_ID, UUID, 1))
            .rejects.toThrow('Route not found');
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('throws for non-active route', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'finished' }] }),
            release: jest.fn()
        };
        db.getClient.mockResolvedValueOnce(mockClient);

        await expect(deliveryService.finishRoute(MERCHANT_ID, UUID, 1))
            .rejects.toThrow('Route is not active');
    });
});

// ============================================================================
// GEOCODING
// ============================================================================

describe('geocodeAddress', () => {
    it('returns null when no API key', async () => {
        const result = await deliveryService.geocodeAddress('123 Main St');
        expect(result).toBeNull();
    });

    it('returns coordinates on success', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                features: [{
                    geometry: { coordinates: [-79.38, 43.65] },
                    properties: { confidence: 0.95 }
                }]
            })
        });

        const result = await deliveryService.geocodeAddress('123 Main St', 'test-key');

        expect(result.lat).toBe(43.65);
        expect(result.lng).toBe(-79.38);
        expect(result.confidence).toBe(0.95);
    });

    it('returns null on API error', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

        const result = await deliveryService.geocodeAddress('Bad Address', 'test-key');

        expect(result).toBeNull();
    });

    it('returns null when no features', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ features: [] })
        });

        const result = await deliveryService.geocodeAddress('Unknown', 'test-key');

        expect(result).toBeNull();
    });

    it('returns null on fetch error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        const result = await deliveryService.geocodeAddress('123 Main St', 'test-key');

        expect(result).toBeNull();
    });
});

// ============================================================================
// PROOF OF DELIVERY
// ============================================================================

describe('savePodPhoto', () => {
    // JPEG magic bytes
    const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // PNG magic bytes
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('rejects non-image files', async () => {
        const textBuffer = Buffer.from('Not an image file contents here');

        await expect(deliveryService.savePodPhoto(MERCHANT_ID, UUID, textBuffer))
            .rejects.toThrow('Invalid image file');
    });

    it('validates UUID format', async () => {
        await expect(deliveryService.savePodPhoto(MERCHANT_ID, 'bad-id', jpegBuffer))
            .rejects.toThrow('Invalid order ID format');
    });

    it('saves JPEG photo and creates POD record', async () => {
        // getOrderById (must be active for status transition)
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, merchant_id: MERCHANT_ID, status: 'active' }]
        });
        // getSettings
        db.query.mockResolvedValueOnce({
            rows: [{ pod_retention_days: 90 }]
        });
        // INSERT pod record
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'pod-uuid', photo_path: `${MERCHANT_ID}/${UUID}/file.jpg` }]
        });
        // updateOrder (mark delivered — only for active orders)
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, status: 'delivered' }]
        });

        const result = await deliveryService.savePodPhoto(MERCHANT_ID, UUID, jpegBuffer);

        expect(result.id).toBe('pod-uuid');
        expect(mockFs.mkdir).toHaveBeenCalled();
        expect(mockFs.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('.jpg'),
            jpegBuffer
        );
    });

    it('saves PNG photo with correct extension', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: UUID, merchant_id: MERCHANT_ID, status: 'active' }] })
            .mockResolvedValueOnce({ rows: [{ pod_retention_days: 180 }] })
            .mockResolvedValueOnce({ rows: [{ id: 'pod-uuid' }] })
            .mockResolvedValueOnce({ rows: [{ id: UUID }] });

        await deliveryService.savePodPhoto(MERCHANT_ID, UUID, pngBuffer);

        expect(mockFs.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('.png'),
            pngBuffer
        );
    });

    it('throws when order not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no order

        await expect(deliveryService.savePodPhoto(MERCHANT_ID, UUID, jpegBuffer))
            .rejects.toThrow('Order not found');
    });
});

describe('getPodPhoto', () => {
    it('validates UUID', async () => {
        await expect(deliveryService.getPodPhoto(MERCHANT_ID, 'bad'))
            .rejects.toThrow('Invalid POD ID format');
    });

    it('returns null for path traversal attempts', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                photo_path: '../../../etc/passwd',
                merchant_id: MERCHANT_ID
            }]
        });

        const result = await deliveryService.getPodPhoto(MERCHANT_ID, UUID);

        expect(result).toBeNull();
    });

    it('returns POD with full path', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                photo_path: `${MERCHANT_ID}/${UUID}/photo.jpg`,
                merchant_id: MERCHANT_ID
            }]
        });

        const result = await deliveryService.getPodPhoto(MERCHANT_ID, UUID);

        expect(result).not.toBeNull();
        expect(result.full_path).toContain('storage/pod');
    });
});

describe('cleanupExpiredPods', () => {
    it('deletes expired POD files and records', async () => {
        db.query
            // Query expired
            .mockResolvedValueOnce({
                rows: [{
                    id: UUID,
                    photo_path: '1/order1/photo.jpg',
                    merchant_id: MERCHANT_ID
                }]
            })
            // DELETE record
            .mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.cleanupExpiredPods();

        expect(result.deleted).toBe(1);
        expect(result.errors).toBe(0);
        expect(mockFs.unlink).toHaveBeenCalled();
    });

    it('handles missing files (ENOENT) gracefully', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: UUID,
                    photo_path: '1/order1/photo.jpg',
                    merchant_id: MERCHANT_ID
                }]
            })
            .mockResolvedValueOnce({ rows: [] });

        mockFs.unlink.mockRejectedValueOnce({ code: 'ENOENT' });

        const result = await deliveryService.cleanupExpiredPods();

        // File already gone - should still clean DB record
        expect(result.deleted).toBe(1);
    });
});

// ============================================================================
// SETTINGS
// ============================================================================

describe('getSettings / updateSettings', () => {
    it('decrypts ORS key from encrypted column', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                merchant_id: MERCHANT_ID,
                start_address: '100 Queen St',
                ors_api_key_encrypted: 'encrypted:my-api-key',
                openrouteservice_api_key: null
            }]
        });

        const settings = await deliveryService.getSettings(MERCHANT_ID);

        expect(settings.openrouteservice_api_key).toBe('my-api-key');
    });

    it('migrates plaintext key to encrypted on read', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    merchant_id: MERCHANT_ID,
                    ors_api_key_encrypted: null,
                    openrouteservice_api_key: 'plaintext-key'
                }]
            })
            // fire-and-forget migration UPDATE
            .mockResolvedValueOnce({ rows: [] });

        const settings = await deliveryService.getSettings(MERCHANT_ID);

        expect(settings.openrouteservice_api_key).toBe('plaintext-key');
    });

    it('logs geocoding-impact warning when ORS key decryption fails', async () => {
        mockDecryptToken.mockImplementationOnce(() => { throw new Error('bad cipher'); });
        db.query.mockResolvedValueOnce({
            rows: [{
                merchant_id: MERCHANT_ID,
                start_address: '100 Queen St',
                ors_api_key_encrypted: 'encrypted:corrupt',
                openrouteservice_api_key: null
            }]
        });

        const settings = await deliveryService.getSettings(MERCHANT_ID);

        // Key should be null since decryption failed
        expect(settings.openrouteservice_api_key).toBeFalsy();
        // LOGIC CHANGE: verify improved error log mentions geocoding impact
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('geocoding'),
            expect.objectContaining({ impact: 'geocoding_disabled' })
        );
    });

    it('updateSettings encrypts ORS key', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                merchant_id: MERCHANT_ID,
                ors_api_key_encrypted: 'encrypted:new-key'
            }]
        });

        await deliveryService.updateSettings(MERCHANT_ID, {
            startAddress: '200 King St',
            openrouteserviceApiKey: 'new-key'
        });

        const params = db.query.mock.calls[0][1];
        expect(params).toContain('encrypted:new-key');
    });
});

// ============================================================================
// SQUARE INTEGRATION
// ============================================================================

describe('ingestSquareOrder', () => {
    it('skips orders with no delivery address', async () => {
        // getOrderBySquareId returns null (new order)
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_ORDER_1',
            state: 'OPEN',
            fulfillments: [{ type: 'PICKUP' }]
        });

        expect(result).toBeNull();
    });

    it('extracts delivery address from fulfillment (camelCase)', async () => {
        // getOrderBySquareId returns null
        db.query.mockResolvedValueOnce({ rows: [] });
        // enrichLineItemsWithGtin skips DB (empty lineItems)
        // createOrder
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true, customer_name: 'Alice Smith' }]
        });
        // getSettings for geocoding
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_ORDER_1',
            state: 'OPEN',
            customerId: 'CUST_1',
            fulfillments: [{
                type: 'DELIVERY',
                deliveryDetails: {
                    recipient: {
                        displayName: 'Alice Smith',
                        phoneNumber: '555-0100',
                        address: {
                            addressLine1: '123 Main St',
                            locality: 'Toronto',
                            administrativeDistrictLevel1: 'ON',
                            postalCode: 'M5V 1A1',
                            country: 'CA'
                        }
                    }
                }
            }],
            lineItems: []
        });

        expect(result).not.toBeNull();
    });

    it('extracts delivery address from fulfillment (snake_case)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getOrderBySquareId
        // enrichLineItemsWithGtin skips DB (empty line_items)
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true, customer_name: 'Bob' }]
        }); // createOrder
        db.query.mockResolvedValueOnce({ rows: [] }); // getSettings

        await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_ORDER_2',
            state: 'OPEN',
            customer_id: 'CUST_2',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: {
                        display_name: 'Bob',
                        phone_number: '555-0200',
                        address: {
                            address_line_1: '456 Oak Ave',
                            locality: 'Toronto',
                            administrative_district_level_1: 'ON',
                            postal_code: 'M5V 2B2'
                        }
                    }
                }
            }],
            line_items: []
        });

        expect(db.query).toHaveBeenCalledTimes(3);
    });

    it('sets completed status for COMPLETED Square orders', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getOrderBySquareId
        // enrichLineItemsWithGtin skips DB (empty lineItems)
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true, status: 'completed' }]
        }); // createOrder
        db.query.mockResolvedValueOnce({ rows: [] }); // getSettings

        const result = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_ORDER_3',
            state: 'COMPLETED',
            fulfillments: [{
                type: 'DELIVERY',
                deliveryDetails: {
                    recipient: {
                        displayName: 'Charlie',
                        address: { addressLine1: '789 Pine Rd', locality: 'Toronto' }
                    }
                }
            }],
            lineItems: []
        });

        // createOrder should be called with status 'completed'
        const createCall = db.query.mock.calls[1];
        const params = createCall[1];
        expect(params[10]).toBe('completed'); // status param
    });

    it('falls back to Square customer lookup for Unknown Customer', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getOrderBySquareId

        mockGetCustomerDetails.mockResolvedValueOnce({
            displayName: 'Resolved Name',
            phone: '555-9999'
        });

        // enrichLineItemsWithGtin skips DB (empty lineItems)
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true }]
        }); // createOrder
        db.query.mockResolvedValueOnce({ rows: [] }); // getSettings

        await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_ORDER_4',
            state: 'OPEN',
            customerId: 'CUST_4',
            fulfillments: [{
                type: 'DELIVERY',
                deliveryDetails: {
                    recipient: {
                        address: { addressLine1: '100 Test Rd', locality: 'Toronto' }
                    }
                }
            }],
            lineItems: []
        });

        expect(mockGetCustomerDetails).toHaveBeenCalledWith('CUST_4', MERCHANT_ID);
    });

    it('updates existing order when Square order already ingested', async () => {
        // Already exists with incomplete data
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                status: 'pending',
                square_order_data: null
            }]
        });
        // enrichLineItemsWithGtin
        db.query.mockResolvedValueOnce({ rows: [] });
        // updateOrder
        db.query.mockResolvedValueOnce({ rows: [{ id: UUID }] });

        const result = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_ORDER_5',
            state: 'COMPLETED',
            lineItems: [{ name: 'Dog Food', quantity: '1' }]
        });

        expect(result).not.toBeNull();
    });

    it('flags DRAFT orders for customer refresh', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getOrderBySquareId
        // enrichLineItemsWithGtin skips DB (empty lineItems)
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true }]
        }); // createOrder
        db.query.mockResolvedValueOnce({ rows: [] }); // getSettings

        await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_DRAFT',
            state: 'DRAFT',
            fulfillments: [{
                type: 'DELIVERY',
                deliveryDetails: {
                    recipient: {
                        displayName: 'Test',
                        address: { addressLine1: '100 Draft St', locality: 'Toronto' }
                    }
                }
            }],
            lineItems: []
        });

        // createOrder should have needsCustomerRefresh=true
        const params = db.query.mock.calls[1][1];
        expect(params[14]).toBe(true); // needsCustomerRefresh param
    });
});

describe('handleSquareOrderUpdate', () => {
    it('marks order completed when Square order completes', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'active' }] })
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'completed' }] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'COMPLETED');

        expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('deletes pending order when Square order cancelled', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'pending' }] })
            .mockResolvedValueOnce({ rows: [{ id: UUID }] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        const deleteSql = db.query.mock.calls[1][0];
        expect(deleteSql).toContain('DELETE FROM delivery_orders');
    });

    it('does not delete delivered/completed orders on cancel', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, status: 'completed' }]
        });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_1', 'CANCELED');

        // Only one query (the lookup), no delete
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('does nothing for unknown square order', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.handleSquareOrderUpdate(MERCHANT_ID, 'SQ_UNKNOWN', 'COMPLETED');

        expect(db.query).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// ROUTE SHARING TOKENS
// ============================================================================

describe('generateRouteToken', () => {
    it('throws for non-existent route', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(deliveryService.generateRouteToken(MERCHANT_ID, UUID, 1))
            .rejects.toThrow('Route not found');
    });

    it('throws for non-active route', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, status: 'finished' }]
        });

        await expect(deliveryService.generateRouteToken(MERCHANT_ID, UUID, 1))
            .rejects.toThrow('Can only share active routes');
    });

    it('revokes existing tokens and creates new one', async () => {
        db.query
            // Route exists
            .mockResolvedValueOnce({ rows: [{ id: UUID, status: 'active' }] })
            // Revoke existing
            .mockResolvedValueOnce({ rows: [] })
            // Create new token
            .mockResolvedValueOnce({
                rows: [{ id: 'token-uuid', token: 'abc123', expires_at: new Date() }]
            });

        const result = await deliveryService.generateRouteToken(MERCHANT_ID, UUID, 1);

        expect(result.id).toBe('token-uuid');
        // Verify revoke was called
        const revokeSql = db.query.mock.calls[1][0];
        expect(revokeSql).toContain("status = 'revoked'");
    });
});

describe('getRouteByToken', () => {
    it('returns null for short/empty token', async () => {
        expect(await deliveryService.getRouteByToken(null)).toBeNull();
        expect(await deliveryService.getRouteByToken('short')).toBeNull();
    });

    it('returns null for unknown token', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.getRouteByToken('a'.repeat(64));

        expect(result).toBeNull();
    });

    it('marks expired token', async () => {
        const pastDate = new Date();
        pastDate.setHours(pastDate.getHours() - 1);

        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: UUID,
                    status: 'active',
                    expires_at: pastDate,
                    route_status: 'active'
                }]
            })
            .mockResolvedValueOnce({ rows: [] }); // UPDATE status

        const result = await deliveryService.getRouteByToken('a'.repeat(64));

        expect(result.valid).toBe(false);
        expect(result.reason).toContain('expired');
    });

    it('returns valid for active non-expired token', async () => {
        const futureDate = new Date();
        futureDate.setHours(futureDate.getHours() + 24);

        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: UUID,
                    status: 'active',
                    expires_at: futureDate,
                    route_status: 'active',
                    used_at: null
                }]
            })
            .mockResolvedValueOnce({ rows: [] }); // UPDATE used_at

        const result = await deliveryService.getRouteByToken('a'.repeat(64));

        expect(result.valid).toBe(true);
    });
});

// ============================================================================
// GTIN ENRICHMENT
// ============================================================================

describe('enrichLineItemsWithGtin (via ingestSquareOrder)', () => {
    it('enriches line items with GTIN from catalog', async () => {
        // getOrderBySquareId
        db.query.mockResolvedValueOnce({ rows: [] });
        // enrichLineItemsWithGtin - UPC lookup
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'VAR_1', upc: '012345678901' }]
        });
        // createOrder
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, _inserted: true }]
        });
        // getSettings
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.ingestSquareOrder(MERCHANT_ID, {
            id: 'SQ_GTIN',
            state: 'OPEN',
            fulfillments: [{
                type: 'DELIVERY',
                deliveryDetails: {
                    recipient: {
                        displayName: 'Test',
                        address: { addressLine1: '100 Test St', locality: 'Toronto' }
                    }
                }
            }],
            lineItems: [{
                name: 'Dog Food',
                quantity: '1',
                catalogObjectId: 'VAR_1',
                variationName: 'Large Bag'
            }]
        });

        // The createOrder call should contain serialized order data with GTIN
        const createParams = db.query.mock.calls[2][1];
        const serializedData = createParams[12]; // squareOrderData
        const parsed = JSON.parse(serializedData);
        expect(parsed.lineItems[0].gtin).toBe('012345678901');
    });
});

// ============================================================================
// CUSTOMER BACKFILL
// ============================================================================

describe('backfillUnknownCustomers', () => {
    it('updates orders with resolved customer data', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                square_customer_id: 'CUST_1',
                customer_name: 'Unknown Customer',
                phone: null
            }]
        });

        mockGetCustomerDetails.mockResolvedValueOnce({
            displayName: 'Alice Smith',
            phone: '555-0100'
        });

        // updateOrder
        db.query.mockResolvedValueOnce({
            rows: [{ id: UUID, customer_name: 'Alice Smith' }]
        });

        const result = await deliveryService.backfillUnknownCustomers(MERCHANT_ID);

        expect(result.updated).toBe(1);
        expect(result.failed).toBe(0);
    });

    it('returns empty result with consistent shape when no orders to fix', async () => {
        // LOGIC CHANGE: empty path now includes `total` field for consistent response shape
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deliveryService.backfillUnknownCustomers(MERCHANT_ID);

        expect(result.updated).toBe(0);
        expect(result.total).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.message).toContain('No orders');
    });

    it('handles lookup failures gracefully', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: UUID,
                square_customer_id: 'CUST_1',
                customer_name: 'Unknown Customer',
                phone: null
            }]
        });

        mockGetCustomerDetails.mockRejectedValueOnce(new Error('API error'));

        const result = await deliveryService.backfillUnknownCustomers(MERCHANT_ID);

        expect(result.updated).toBe(0);
        expect(result.failed).toBe(1);
    });
});

// ============================================================================
// AUDIT LOG
// ============================================================================

describe('logAuditEvent', () => {
    it('inserts audit event', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.logAuditEvent(MERCHANT_ID, 1, 'order_created', UUID);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('delivery_audit_log'),
            [MERCHANT_ID, 1, 'order_created', UUID, null, '{}', null, null]
        );
    });

    it('swallows errors silently', async () => {
        db.query.mockRejectedValueOnce(new Error('DB error'));

        // Should not throw
        await deliveryService.logAuditEvent(MERCHANT_ID, 1, 'test_action');
    });
});

describe('getAuditLog', () => {
    it('filters by action and orderId', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await deliveryService.getAuditLog(MERCHANT_ID, {
            action: 'order_completed',
            orderId: UUID
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('dal.action =');
        expect(sql).toContain('dal.delivery_order_id =');
    });
});
