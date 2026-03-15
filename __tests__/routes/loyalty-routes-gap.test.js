/**
 * Gap coverage tests for loyalty routes not covered in loyalty.test.js
 *
 * Covers 5 route modules with zero existing test coverage:
 * - audit.js: 5 routes (audit logs, stats, audit findings, missed redemptions)
 * - reports.js: 8 routes (vendor receipt, brand redemptions, CSV exports)
 * - variations.js: 4 routes (add, list, assignments, remove)
 * - discounts.js: 2 routes (validate, validate-and-fix)
 * - settings.js: 2 routes (get, update)
 */

// Mocks must be declared before requires (no babel-jest hoisting: transform: {})
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const mockLoyaltyService = {
    // Existing mocks needed for route loading
    getOffers: jest.fn(),
    createOffer: jest.fn(),
    getOfferById: jest.fn(),
    getQualifyingVariations: jest.fn(),
    updateOffer: jest.fn(),
    deleteOffer: jest.fn(),
    redeemReward: jest.fn(),
    updateVendorCreditStatus: jest.fn(),
    getRewards: jest.fn(),
    getRedemptions: jest.fn(),
    processOrderManually: jest.fn(),
    runBackfill: jest.fn(),
    runLoyaltyCatchup: jest.fn(),
    refreshCustomersWithMissingData: jest.fn(),
    processManualEntry: jest.fn(),
    processExpiredWindowEntries: jest.fn(),
    processExpiredEarnedRewards: jest.fn(),
    getCustomerDetails: jest.fn(),
    getCustomerLoyaltyStatus: jest.fn(),
    getCustomerOfferProgress: jest.fn(),
    getCustomerLoyaltyHistory: jest.fn(),
    getCustomerEarnedRewards: jest.fn(),
    getCustomerOrderHistoryForAudit: jest.fn(),
    addOrdersToLoyaltyTracking: jest.fn(),
    searchCustomers: jest.fn(),
    getSquareLoyaltyProgram: jest.fn(),
    linkOfferToSquareTier: jest.fn(),
    createSquareReward: jest.fn(),
    syncRewardsToPOS: jest.fn(),
    getPendingSyncCounts: jest.fn(),

    // ---- Gap coverage mocks ----
    // Audit
    getAuditLogs: jest.fn(),
    getLoyaltyStats: jest.fn(),
    getAuditFindings: jest.fn(),
    resolveAuditFinding: jest.fn(),
    auditMissedRedemptions: jest.fn(),
    // Variations
    addQualifyingVariations: jest.fn(),
    getVariationAssignments: jest.fn(),
    removeQualifyingVariation: jest.fn(),
    // Discounts
    validateEarnedRewardsDiscounts: jest.fn(),
    // Settings
    getSettings: jest.fn(),
    updateSetting: jest.fn(),
};

jest.mock('../../services/loyalty-admin', () => mockLoyaltyService);

// Reports service mocks
const mockLoyaltyReports = {
    generateVendorReceipt: jest.fn(),
    generateRedemptionsCSV: jest.fn(),
    generateAuditCSV: jest.fn(),
    generateSummaryCSV: jest.fn(),
    generateCustomerActivityCSV: jest.fn(),
    getRedemptionDetails: jest.fn(),
};
jest.mock('../../services/reports', () => mockLoyaltyReports);

const mockBrandRedemptionReport = {
    generateBrandRedemptionHTML: jest.fn(),
    generateBrandRedemptionCSV: jest.fn(),
    buildBrandRedemptionReport: jest.fn(),
};
jest.mock('../../services/reports/brand-redemption-report', () => mockBrandRedemptionReport);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
    requireWriteAccess: (req, res, next) => {
        if (req.session?.user?.role === 'viewer') {
            return res.status(403).json({ error: 'Write access required' });
        }
        next();
    },
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(400).json({ error: 'Merchant context required' });
        }
        next();
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');

const OFFER_UUID = '54de3dd3-0870-469a-9063-677c39b52917';
const REWARD_UUID = '616f80d8-5bb9-4882-8165-ec32b6d395d7';

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true, role = 'admin' } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, email: 'test@test.com', role };
        if (hasMerchant) req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    const loyaltyRoutes = require('../../routes/loyalty');
    app.use('/api/loyalty', loyaltyRoutes);
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ============================================================================
// TESTS — AUDIT (routes/loyalty/audit.js)
// ============================================================================

describe('Loyalty Audit Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/loyalty/audit', () => {
        it('should return audit log entries', async () => {
            mockLoyaltyService.getAuditLogs.mockResolvedValueOnce([
                { id: 1, action: 'PURCHASE_RECORDED', created_at: '2026-03-01' }
            ]);
            const res = await request(app).get('/api/loyalty/audit');
            expect(res.status).toBe(200);
            expect(res.body.entries).toHaveLength(1);
            expect(mockLoyaltyService.getAuditLogs).toHaveBeenCalledWith(1, {
                action: undefined,
                squareCustomerId: undefined,
                offerId: undefined,
                limit: 100,
                offset: 0
            });
        });

        it('should pass filter params', async () => {
            mockLoyaltyService.getAuditLogs.mockResolvedValueOnce([]);
            await request(app).get('/api/loyalty/audit?action=PURCHASE_RECORDED&squareCustomerId=CUST_1&limit=25&offset=10');
            expect(mockLoyaltyService.getAuditLogs).toHaveBeenCalledWith(1, {
                action: 'PURCHASE_RECORDED',
                squareCustomerId: 'CUST_1',
                offerId: undefined,
                limit: 25,
                offset: 10
            });
        });

        it('should require authentication', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/loyalty/audit');
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/loyalty/stats', () => {
        it('should return loyalty stats', async () => {
            mockLoyaltyService.getLoyaltyStats.mockResolvedValueOnce({
                totalOffers: 5,
                totalRewards: 25,
                activeCustomers: 100
            });
            const res = await request(app).get('/api/loyalty/stats');
            expect(res.status).toBe(200);
            expect(res.body.stats.totalOffers).toBe(5);
            expect(mockLoyaltyService.getLoyaltyStats).toHaveBeenCalledWith(1);
        });

        it('should require merchant context', async () => {
            app = createTestApp({ hasMerchant: false });
            const res = await request(app).get('/api/loyalty/stats');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/loyalty/audit-findings', () => {
        it('should list unresolved audit findings', async () => {
            mockLoyaltyService.getAuditFindings.mockResolvedValueOnce({
                findings: [{ id: 1, issue_type: 'ORPHANED_DISCOUNT' }],
                total: 1
            });
            const res = await request(app).get('/api/loyalty/audit-findings');
            expect(res.status).toBe(200);
            expect(res.body.findings).toHaveLength(1);
            expect(mockLoyaltyService.getAuditFindings).toHaveBeenCalledWith({
                merchantId: 1,
                resolved: false,
                issueType: undefined,
                limit: 50,
                offset: 0
            });
        });

        it('should pass resolved=true filter', async () => {
            mockLoyaltyService.getAuditFindings.mockResolvedValueOnce({ findings: [], total: 0 });
            await request(app).get('/api/loyalty/audit-findings?resolved=true&issueType=MISSING_REDEMPTION');
            expect(mockLoyaltyService.getAuditFindings).toHaveBeenCalledWith(
                expect.objectContaining({
                    resolved: true,
                    issueType: 'MISSING_REDEMPTION'
                })
            );
        });

        it('should pass limit and offset', async () => {
            mockLoyaltyService.getAuditFindings.mockResolvedValueOnce({ findings: [], total: 0 });
            await request(app).get('/api/loyalty/audit-findings?limit=10&offset=20');
            expect(mockLoyaltyService.getAuditFindings).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 10, offset: 20 })
            );
        });
    });

    describe('POST /api/loyalty/audit-findings/resolve/:id', () => {
        const FINDING_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

        it('should resolve an audit finding', async () => {
            mockLoyaltyService.resolveAuditFinding.mockResolvedValueOnce({
                id: FINDING_UUID, resolved: true
            });
            const res = await request(app)
                .post(`/api/loyalty/audit-findings/resolve/${FINDING_UUID}`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.finding.resolved).toBe(true);
            expect(mockLoyaltyService.resolveAuditFinding).toHaveBeenCalledWith({
                merchantId: 1,
                findingId: FINDING_UUID
            });
        });

        it('should return 404 when finding not found', async () => {
            mockLoyaltyService.resolveAuditFinding.mockResolvedValueOnce(null);
            const res = await request(app)
                .post(`/api/loyalty/audit-findings/resolve/${FINDING_UUID}`);
            expect(res.status).toBe(404);
            expect(res.body.code).toBe('NOT_FOUND');
        });

        it('should reject non-UUID id', async () => {
            const res = await request(app)
                .post('/api/loyalty/audit-findings/resolve/not-uuid');
            expect(res.status).toBe(400);
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post(`/api/loyalty/audit-findings/resolve/${FINDING_UUID}`);
            expect(res.status).toBe(403);
        });
    });

    describe('POST /api/loyalty/audit-missed-redemptions', () => {
        it('should run missed redemption audit with defaults', async () => {
            mockLoyaltyService.auditMissedRedemptions.mockResolvedValueOnce({
                scannedOrders: 50,
                missedRedemptions: 2,
                dryRun: true
            });
            const res = await request(app)
                .post('/api/loyalty/audit-missed-redemptions');
            expect(res.status).toBe(200);
            expect(res.body.scannedOrders).toBe(50);
            expect(mockLoyaltyService.auditMissedRedemptions).toHaveBeenCalledWith({
                merchantId: 1,
                days: 7,
                dryRun: true
            });
        });

        it('should pass custom days and dryRun=false', async () => {
            mockLoyaltyService.auditMissedRedemptions.mockResolvedValueOnce({});
            await request(app)
                .post('/api/loyalty/audit-missed-redemptions?days=30&dryRun=false');
            expect(mockLoyaltyService.auditMissedRedemptions).toHaveBeenCalledWith({
                merchantId: 1,
                days: 30,
                dryRun: false
            });
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post('/api/loyalty/audit-missed-redemptions');
            expect(res.status).toBe(403);
        });
    });
});

// ============================================================================
// TESTS — REPORTS (routes/loyalty/reports.js)
// ============================================================================

describe('Loyalty Report Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/loyalty/reports', () => {
        it('should list available report endpoints', async () => {
            const res = await request(app).get('/api/loyalty/reports');
            expect(res.status).toBe(200);
            expect(res.body.endpoints).toBeDefined();
            expect(res.body.message).toBe('Loyalty Reports API');
        });
    });

    describe('GET /api/loyalty/reports/vendor-receipt/:rewardId', () => {
        it('should return HTML receipt by default', async () => {
            mockLoyaltyReports.generateVendorReceipt.mockResolvedValueOnce({
                html: '<html><body>Receipt</body></html>',
                filename: 'receipt-test.html',
                data: { reward_id: REWARD_UUID }
            });
            const res = await request(app)
                .get(`/api/loyalty/reports/vendor-receipt/${REWARD_UUID}?format=html`);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(res.text).toContain('Receipt');
        });

        it('should return JSON when format is not html', async () => {
            mockLoyaltyReports.generateVendorReceipt.mockResolvedValueOnce({
                html: '<html>test</html>',
                data: { id: 1 },
                filename: 'receipt.html'
            });
            const res = await request(app)
                .get(`/api/loyalty/reports/vendor-receipt/${REWARD_UUID}?format=json`);
            expect(res.status).toBe(200);
            expect(res.body.html).toContain('test');
            expect(res.body.data).toBeDefined();
            expect(res.body.filename).toBeDefined();
        });

        it('should reject non-UUID rewardId', async () => {
            const res = await request(app)
                .get('/api/loyalty/reports/vendor-receipt/not-uuid');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/loyalty/reports/brand-redemptions', () => {
        it('should return JSON report by default', async () => {
            mockBrandRedemptionReport.buildBrandRedemptionReport.mockResolvedValueOnce({
                redemptions: [{ rewardId: 1 }],
                summary: { totalRedemptions: 1 }
            });
            const res = await request(app)
                .get('/api/loyalty/reports/brand-redemptions');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.report.redemptions).toHaveLength(1);
            expect(mockBrandRedemptionReport.buildBrandRedemptionReport).toHaveBeenCalledWith(1, expect.objectContaining({
                includeFullOrders: true
            }));
        });

        it('should return HTML when format=html', async () => {
            mockBrandRedemptionReport.generateBrandRedemptionHTML.mockResolvedValueOnce({
                html: '<html>Brand Report</html>',
                filename: 'brand-report.html'
            });
            const res = await request(app)
                .get('/api/loyalty/reports/brand-redemptions?format=html');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(res.text).toContain('Brand Report');
        });

        it('should return CSV when format=csv', async () => {
            mockBrandRedemptionReport.generateBrandRedemptionCSV.mockResolvedValueOnce({
                csv: 'header1,header2\nval1,val2',
                filename: 'brand-report.csv'
            });
            const res = await request(app)
                .get('/api/loyalty/reports/brand-redemptions?format=csv');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toContain('attachment');
            expect(res.text).toContain('header1');
        });

        it('should pass filter options to all formats', async () => {
            mockBrandRedemptionReport.buildBrandRedemptionReport.mockResolvedValueOnce({
                redemptions: [], summary: null
            });
            await request(app)
                .get(`/api/loyalty/reports/brand-redemptions?startDate=2026-01-01&endDate=2026-03-01&offerId=${OFFER_UUID}&brandName=Acana`);
            expect(mockBrandRedemptionReport.buildBrandRedemptionReport).toHaveBeenCalledWith(1, expect.objectContaining({
                startDate: '2026-01-01',
                endDate: '2026-03-01',
                offerId: OFFER_UUID,
                brandName: 'Acana'
            }));
        });
    });

    describe('GET /api/loyalty/reports/redemptions/csv', () => {
        it('should return CSV with correct headers', async () => {
            mockLoyaltyReports.generateRedemptionsCSV.mockResolvedValueOnce({
                csv: 'col1,col2\ndata',
                filename: 'redemptions.csv'
            });
            const res = await request(app)
                .get('/api/loyalty/reports/redemptions/csv');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toContain('redemptions.csv');
        });

        it('should pass filter params', async () => {
            mockLoyaltyReports.generateRedemptionsCSV.mockResolvedValueOnce({
                csv: '', filename: 'r.csv'
            });
            await request(app)
                .get('/api/loyalty/reports/redemptions/csv?startDate=2026-01-01&brandName=Acana');
            expect(mockLoyaltyReports.generateRedemptionsCSV).toHaveBeenCalledWith(1, {
                startDate: '2026-01-01',
                endDate: undefined,
                offerId: undefined,
                brandName: 'Acana'
            });
        });
    });

    describe('GET /api/loyalty/reports/audit/csv', () => {
        it('should return audit CSV', async () => {
            mockLoyaltyReports.generateAuditCSV.mockResolvedValueOnce({
                csv: 'audit,data', filename: 'audit.csv'
            });
            const res = await request(app)
                .get('/api/loyalty/reports/audit/csv');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
        });

        it('should pass squareCustomerId filter', async () => {
            mockLoyaltyReports.generateAuditCSV.mockResolvedValueOnce({
                csv: '', filename: 'a.csv'
            });
            await request(app)
                .get('/api/loyalty/reports/audit/csv?squareCustomerId=CUST_1');
            expect(mockLoyaltyReports.generateAuditCSV).toHaveBeenCalledWith(1, expect.objectContaining({
                squareCustomerId: 'CUST_1'
            }));
        });
    });

    describe('GET /api/loyalty/reports/summary/csv', () => {
        it('should return summary CSV', async () => {
            mockLoyaltyReports.generateSummaryCSV.mockResolvedValueOnce({
                csv: 'summary,data', filename: 'summary.csv'
            });
            const res = await request(app)
                .get('/api/loyalty/reports/summary/csv');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
        });

        it('should pass date range', async () => {
            mockLoyaltyReports.generateSummaryCSV.mockResolvedValueOnce({
                csv: '', filename: 's.csv'
            });
            await request(app)
                .get('/api/loyalty/reports/summary/csv?startDate=2026-01-01&endDate=2026-03-01');
            expect(mockLoyaltyReports.generateSummaryCSV).toHaveBeenCalledWith(1, {
                startDate: '2026-01-01',
                endDate: '2026-03-01'
            });
        });
    });

    describe('GET /api/loyalty/reports/customers/csv', () => {
        it('should return customer activity CSV', async () => {
            mockLoyaltyReports.generateCustomerActivityCSV.mockResolvedValueOnce({
                csv: 'customers', filename: 'customers.csv'
            });
            const res = await request(app)
                .get('/api/loyalty/reports/customers/csv');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
        });

        it('should default minPurchases to 1', async () => {
            mockLoyaltyReports.generateCustomerActivityCSV.mockResolvedValueOnce({
                csv: '', filename: 'c.csv'
            });
            await request(app).get('/api/loyalty/reports/customers/csv');
            expect(mockLoyaltyReports.generateCustomerActivityCSV).toHaveBeenCalledWith(1, {
                offerId: undefined,
                minPurchases: 1
            });
        });

        it('should pass custom minPurchases', async () => {
            mockLoyaltyReports.generateCustomerActivityCSV.mockResolvedValueOnce({
                csv: '', filename: 'c.csv'
            });
            await request(app).get('/api/loyalty/reports/customers/csv?minPurchases=5');
            expect(mockLoyaltyReports.generateCustomerActivityCSV).toHaveBeenCalledWith(1, expect.objectContaining({
                minPurchases: 5
            }));
        });
    });

    describe('GET /api/loyalty/reports/redemption/:rewardId', () => {
        it('should return redemption details', async () => {
            mockLoyaltyReports.getRedemptionDetails.mockResolvedValueOnce({
                rewardId: REWARD_UUID,
                offerName: 'Buy 12 Get 1 Free',
                contributingPurchases: []
            });
            const res = await request(app)
                .get(`/api/loyalty/reports/redemption/${REWARD_UUID}`);
            expect(res.status).toBe(200);
            expect(res.body.redemption.offerName).toBe('Buy 12 Get 1 Free');
        });

        it('should return 404 when redemption not found', async () => {
            mockLoyaltyReports.getRedemptionDetails.mockResolvedValueOnce(null);
            const res = await request(app)
                .get(`/api/loyalty/reports/redemption/${REWARD_UUID}`);
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Redemption not found');
        });

        it('should reject non-UUID rewardId', async () => {
            const res = await request(app)
                .get('/api/loyalty/reports/redemption/not-a-uuid');
            expect(res.status).toBe(400);
        });
    });

    describe('Report routes — auth', () => {
        it('should return 401 on all report endpoints without auth', async () => {
            app = createTestApp({ authenticated: false });
            const endpoints = [
                '/api/loyalty/reports',
                `/api/loyalty/reports/vendor-receipt/${REWARD_UUID}`,
                '/api/loyalty/reports/brand-redemptions',
                '/api/loyalty/reports/redemptions/csv',
                '/api/loyalty/reports/audit/csv',
                '/api/loyalty/reports/summary/csv',
                '/api/loyalty/reports/customers/csv',
                `/api/loyalty/reports/redemption/${REWARD_UUID}`,
            ];
            for (const path of endpoints) {
                const res = await request(app).get(path);
                expect(res.status).toBe(401);
            }
        });
    });
});

// ============================================================================
// TESTS — VARIATIONS (routes/loyalty/variations.js)
// ============================================================================

describe('Loyalty Variation Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('POST /api/loyalty/offers/:id/variations', () => {
        it('should add qualifying variations', async () => {
            mockLoyaltyService.addQualifyingVariations.mockResolvedValueOnce([
                { variation_id: 'var_1', item_name: 'Acana Large' },
                { variation_id: 'var_2', item_name: 'Acana Medium' }
            ]);
            const res = await request(app)
                .post(`/api/loyalty/offers/${OFFER_UUID}/variations`)
                .send({
                    variations: [
                        { variationId: 'var_1', itemName: 'Acana Large' },
                        { variationId: 'var_2', itemName: 'Acana Medium' }
                    ]
                });
            expect(res.status).toBe(200);
            expect(res.body.added).toHaveLength(2);
            expect(mockLoyaltyService.addQualifyingVariations).toHaveBeenCalledWith(
                OFFER_UUID,
                expect.any(Array),
                1,
                1
            );
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post(`/api/loyalty/offers/${OFFER_UUID}/variations`)
                .send({ variations: [{ variationId: 'var_1' }] });
            expect(res.status).toBe(403);
        });

        it('should reject non-UUID offer ID', async () => {
            const res = await request(app)
                .post('/api/loyalty/offers/not-uuid/variations')
                .send({ variations: [{ variationId: 'var_1' }] });
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/loyalty/offers/:id/variations', () => {
        it('should list qualifying variations for offer', async () => {
            mockLoyaltyService.getQualifyingVariations.mockResolvedValueOnce([
                { variation_id: 'var_1', sku: 'SKU001', item_name: 'Acana Large' }
            ]);
            const res = await request(app)
                .get(`/api/loyalty/offers/${OFFER_UUID}/variations`);
            expect(res.status).toBe(200);
            expect(res.body.variations).toHaveLength(1);
            expect(mockLoyaltyService.getQualifyingVariations).toHaveBeenCalledWith(OFFER_UUID, 1);
        });
    });

    describe('GET /api/loyalty/variations/assignments', () => {
        it('should return all variation assignments', async () => {
            mockLoyaltyService.getVariationAssignments.mockResolvedValueOnce({
                var_1: { offerId: 1, offerName: 'Acana Program' },
                var_2: { offerId: 2, offerName: 'Orijen Program' }
            });
            const res = await request(app)
                .get('/api/loyalty/variations/assignments');
            expect(res.status).toBe(200);
            expect(res.body.assignments).toBeDefined();
            expect(mockLoyaltyService.getVariationAssignments).toHaveBeenCalledWith(1);
        });
    });

    describe('DELETE /api/loyalty/offers/:offerId/variations/:variationId', () => {
        it('should remove a qualifying variation', async () => {
            mockLoyaltyService.removeQualifyingVariation.mockResolvedValueOnce(true);
            const res = await request(app)
                .delete(`/api/loyalty/offers/${OFFER_UUID}/variations/var_123`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockLoyaltyService.removeQualifyingVariation).toHaveBeenCalledWith(
                OFFER_UUID, 'var_123', 1, 1
            );
        });

        it('should return 404 when variation not found', async () => {
            mockLoyaltyService.removeQualifyingVariation.mockResolvedValueOnce(null);
            const res = await request(app)
                .delete(`/api/loyalty/offers/${OFFER_UUID}/variations/var_missing`);
            expect(res.status).toBe(404);
            expect(res.body.error).toContain('not found');
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .delete(`/api/loyalty/offers/${OFFER_UUID}/variations/var_1`);
            expect(res.status).toBe(403);
        });
    });
});

// ============================================================================
// TESTS — DISCOUNTS (routes/loyalty/discounts.js)
// ============================================================================

describe('Loyalty Discount Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/loyalty/discounts/validate', () => {
        it('should validate discounts without fixing', async () => {
            mockLoyaltyService.validateEarnedRewardsDiscounts.mockResolvedValueOnce({
                totalEarned: 10,
                validated: 8,
                issues: [{ rewardId: 1, issue: 'DISCOUNT_NOT_FOUND' }],
                fixed: []
            });
            const res = await request(app)
                .get('/api/loyalty/discounts/validate');
            expect(res.status).toBe(200);
            expect(res.body.totalEarned).toBe(10);
            expect(res.body.issues).toHaveLength(1);
            expect(mockLoyaltyService.validateEarnedRewardsDiscounts).toHaveBeenCalledWith({
                merchantId: 1,
                fixIssues: false
            });
        });

        it('should not require write access (read-only)', async () => {
            app = createTestApp({ role: 'viewer' });
            mockLoyaltyService.validateEarnedRewardsDiscounts.mockResolvedValueOnce({
                totalEarned: 0, validated: 0, issues: [], fixed: []
            });
            const res = await request(app).get('/api/loyalty/discounts/validate');
            expect(res.status).toBe(200);
        });
    });

    describe('POST /api/loyalty/discounts/validate-and-fix', () => {
        it('should validate and fix discount issues', async () => {
            mockLoyaltyService.validateEarnedRewardsDiscounts.mockResolvedValueOnce({
                totalEarned: 10,
                validated: 9,
                issues: [{ rewardId: 1, issue: 'DISCOUNT_NOT_FOUND' }],
                fixed: [{ rewardId: 1, action: 'RECREATED' }]
            });
            const res = await request(app)
                .post('/api/loyalty/discounts/validate-and-fix');
            expect(res.status).toBe(200);
            expect(res.body.fixed).toHaveLength(1);
            expect(mockLoyaltyService.validateEarnedRewardsDiscounts).toHaveBeenCalledWith({
                merchantId: 1,
                fixIssues: true
            });
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .post('/api/loyalty/discounts/validate-and-fix');
            expect(res.status).toBe(403);
        });

        it('should require authentication', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app)
                .post('/api/loyalty/discounts/validate-and-fix');
            expect(res.status).toBe(401);
        });
    });
});

// ============================================================================
// TESTS — SETTINGS (routes/loyalty/settings.js)
// ============================================================================

describe('Loyalty Settings Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/loyalty/settings', () => {
        it('should return loyalty settings', async () => {
            mockLoyaltyService.getSettings.mockResolvedValueOnce({
                auto_sync_enabled: 'true',
                notification_email: 'admin@store.com'
            });
            const res = await request(app).get('/api/loyalty/settings');
            expect(res.status).toBe(200);
            expect(res.body.settings.auto_sync_enabled).toBe('true');
            expect(mockLoyaltyService.getSettings).toHaveBeenCalledWith(1);
        });

        it('should not require write access (read-only)', async () => {
            app = createTestApp({ role: 'viewer' });
            mockLoyaltyService.getSettings.mockResolvedValueOnce({});
            const res = await request(app).get('/api/loyalty/settings');
            expect(res.status).toBe(200);
        });

        it('should require authentication', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/loyalty/settings');
            expect(res.status).toBe(401);
        });
    });

    describe('PUT /api/loyalty/settings', () => {
        it('should update multiple settings', async () => {
            mockLoyaltyService.updateSetting.mockResolvedValue(true);
            const res = await request(app)
                .put('/api/loyalty/settings')
                .send({
                    auto_sync_enabled: true,
                    notification_email: 'new@store.com'
                });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            // Should call updateSetting once per key
            expect(mockLoyaltyService.updateSetting).toHaveBeenCalledTimes(2);
            expect(mockLoyaltyService.updateSetting).toHaveBeenCalledWith('auto_sync_enabled', 'true', 1);
            expect(mockLoyaltyService.updateSetting).toHaveBeenCalledWith('notification_email', 'new@store.com', 1);
        });

        it('should convert values to strings', async () => {
            mockLoyaltyService.updateSetting.mockResolvedValue(true);
            await request(app)
                .put('/api/loyalty/settings')
                .send({ max_rewards: 50 });
            expect(mockLoyaltyService.updateSetting).toHaveBeenCalledWith('max_rewards', '50', 1);
        });

        it('should handle single setting correctly', async () => {
            mockLoyaltyService.updateSetting.mockResolvedValue(true);
            await request(app)
                .put('/api/loyalty/settings')
                .send({ auto_sync_enabled: false });
            expect(mockLoyaltyService.updateSetting).toHaveBeenCalledTimes(1);
            expect(mockLoyaltyService.updateSetting).toHaveBeenCalledWith('auto_sync_enabled', 'false', 1);
        });

        it('should require write access', async () => {
            app = createTestApp({ role: 'viewer' });
            const res = await request(app)
                .put('/api/loyalty/settings')
                .send({ auto_sync_enabled: true });
            expect(res.status).toBe(403);
        });
    });
});

// ============================================================================
// CROSS-CUTTING MIDDLEWARE — GAP ROUTES
// ============================================================================

describe('Gap route middleware enforcement', () => {
    it('should return 401 on gap endpoints without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const endpoints = [
            { method: 'get', path: '/api/loyalty/audit' },
            { method: 'get', path: '/api/loyalty/stats' },
            { method: 'get', path: '/api/loyalty/audit-findings' },
            { method: 'get', path: '/api/loyalty/discounts/validate' },
            { method: 'get', path: '/api/loyalty/settings' },
            { method: 'get', path: '/api/loyalty/variations/assignments' },
        ];
        for (const ep of endpoints) {
            const res = await request(app)[ep.method](ep.path);
            expect(res.status).toBe(401);
        }
    });

    it('should return 400 on gap endpoints without merchant', async () => {
        const app = createTestApp({ hasMerchant: false });
        const endpoints = [
            { method: 'get', path: '/api/loyalty/audit' },
            { method: 'get', path: '/api/loyalty/stats' },
            { method: 'get', path: '/api/loyalty/settings' },
            { method: 'get', path: '/api/loyalty/discounts/validate' },
        ];
        for (const ep of endpoints) {
            const res = await request(app)[ep.method](ep.path);
            expect(res.status).toBe(400);
        }
    });

    it('should return 403 on write gap endpoints for viewer role', async () => {
        const app = createTestApp({ role: 'viewer' });
        const endpoints = [
            { method: 'post', path: '/api/loyalty/audit-findings/resolve/a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
            { method: 'post', path: '/api/loyalty/audit-missed-redemptions' },
            { method: 'post', path: '/api/loyalty/discounts/validate-and-fix' },
            { method: 'put', path: '/api/loyalty/settings', body: { key: 'val' } },
            { method: 'post', path: `/api/loyalty/offers/${OFFER_UUID}/variations`, body: { variations: [] } },
            { method: 'delete', path: `/api/loyalty/offers/${OFFER_UUID}/variations/var_1` },
        ];
        for (const ep of endpoints) {
            const res = await request(app)[ep.method](ep.path).send(ep.body || {});
            expect(res.status).toBe(403);
        }
    });
});
