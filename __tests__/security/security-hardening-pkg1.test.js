/**
 * Security Hardening Package 1 Tests
 *
 * Tests for all S-1 through S-11 security fixes:
 * - S-1: Parameterized INTERVAL queries (no SQL injection)
 * - S-2: /output directory requires authentication
 * - S-3: OAuth callback verifies session user matches state
 * - S-4: CSP does not contain 'unsafe-inline'
 * - S-5: Dev token exposure uses positive opt-in
 * - S-6: Admin user listing scoped by merchant
 * - S-7: OAuth revoke uses standard requireMerchant middleware
 * - S-8: Public health endpoint returns minimal info
 * - S-9: CSRF assessment (documented decision — no code test)
 * - S-10: Vendor catalog validation errors are HTML-escaped
 * - S-11: Session regeneration on OAuth callback
 */

const db = require('../../utils/database');

// ==================== S-1: Parameterized INTERVAL Queries ====================

describe('S-1: SQL Injection Prevention in INTERVAL Clauses', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    const cartActivityService = require('../../services/cart/cart-activity-service');

    test('markAbandoned uses parameterized INTERVAL (no string interpolation)', async () => {
        await cartActivityService.markAbandoned(1, 7);

        const query = db.query.mock.calls[0][0];
        const params = db.query.mock.calls[0][1];

        // Must NOT contain ${...} interpolation in INTERVAL
        expect(query).not.toMatch(/INTERVAL '\$\{/);
        // Must use parameterized pattern
        expect(query).toContain("INTERVAL '1 day' * $2");
        expect(params).toEqual([1, 7]);
    });

    test('purgeOld uses parameterized INTERVAL', async () => {
        await cartActivityService.purgeOld(1, 30);

        const query = db.query.mock.calls[0][0];
        const params = db.query.mock.calls[0][1];

        expect(query).not.toMatch(/INTERVAL '\$\{/);
        expect(query).toContain("INTERVAL '1 day' * $2");
        expect(params).toEqual([1, 30]);
    });

    test('getStats uses parameterized INTERVAL', async () => {
        db.query.mockResolvedValue({
            rows: [{
                pending: '0', converted: '0', abandoned: '0', canceled: '0',
                total_resolved: '0', avg_pending_cart: null, avg_converted_cart: null
            }]
        });

        await cartActivityService.getStats(1, 14);

        const query = db.query.mock.calls[0][0];
        const params = db.query.mock.calls[0][1];

        expect(query).not.toMatch(/INTERVAL '\$\{/);
        expect(query).toContain("INTERVAL '1 day' * $2");
        expect(params).toEqual([1, 14]);
    });
});

// ==================== S-1: No INTERVAL Interpolation Remaining ====================

describe('S-1: Codebase grep verification', () => {
    const fs = require('fs');
    const path = require('path');

    function findInterpolatedIntervals(dir, results = []) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'output', '__tests__'].includes(entry.name)) continue;
                findInterpolatedIntervals(fullPath, results);
            } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
                const content = fs.readFileSync(fullPath, 'utf8');
                // Match INTERVAL '${...}' pattern (SQL injection risk)
                const matches = content.match(/INTERVAL\s+'\$\{[^}]+\}/g);
                if (matches) {
                    results.push({ file: fullPath, matches });
                }
            }
        }
        return results;
    }

    test('no INTERVAL interpolation patterns remain in codebase', () => {
        const projectRoot = path.join(__dirname, '..', '..');
        const results = findInterpolatedIntervals(projectRoot);

        if (results.length > 0) {
            const details = results.map(r =>
                `${r.file}: ${r.matches.join(', ')}`
            ).join('\n');
            throw new Error('Found INTERVAL interpolation patterns:\n' + details);
        }

        expect(results).toHaveLength(0);
    });
});

// ==================== S-4: CSP Configuration ====================

describe('S-4: CSP unsafe-inline removed', () => {
    test('CSP scriptSrc does not contain unsafe-inline', () => {
        const fs = require('fs');
        const path = require('path');
        const securitySource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'middleware', 'security.js'),
            'utf8'
        );

        // Extract the scriptSrc array content
        const scriptSrcMatch = securitySource.match(/scriptSrc:\s*\[([\s\S]*?)\]/);
        expect(scriptSrcMatch).toBeTruthy();

        const scriptSrcContent = scriptSrcMatch[1];
        expect(scriptSrcContent).not.toContain("'unsafe-inline'");
    });
});

// ==================== S-5: Dev Token Positive Opt-In ====================

describe('S-5: Password reset token not exposed unless NODE_ENV=development', () => {
    test('source code uses positive opt-in check', () => {
        const fs = require('fs');
        const path = require('path');
        const authSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'routes', 'auth.js'),
            'utf8'
        );

        // Should use === 'development' (positive opt-in)
        expect(authSource).toContain("process.env.NODE_ENV === 'development'");
        // Should NOT use !== 'production' (negative check)
        expect(authSource).not.toContain("process.env.NODE_ENV !== 'production'");
    });
});

// ==================== S-6: Admin User Listing Scoped by Merchant ====================

describe('S-6: Admin user listing scoped by merchant', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('user listing query joins user_merchants and filters by merchant_id', () => {
        const fs = require('fs');
        const path = require('path');
        const authSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'routes', 'auth.js'),
            'utf8'
        );

        // The GET /users query must join user_merchants
        expect(authSource).toMatch(/JOIN\s+user_merchants\s+um\s+ON\s+um\.user_id\s*=\s*u\.id/);
        // And filter by merchant_id
        expect(authSource).toMatch(/WHERE\s+um\.merchant_id\s*=\s*\$1/);
    });
});

// ==================== S-8: Health Endpoint Split ====================

describe('S-8: Public health endpoint returns minimal info', () => {
    test('public health endpoint source does not expose memory, nodeVersion, or webhooks', () => {
        const fs = require('fs');
        const path = require('path');
        const serverSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'server.js'),
            'utf8'
        );

        // Find the public /api/health handler (not /api/health/detailed)
        // The public handler should only return status, timestamp, version
        const publicHealthMatch = serverSource.match(
            /app\.get\('\/api\/health',\s*async.*?\n([\s\S]*?)(?=app\.get\('\/api\/health\/detailed')/
        );
        expect(publicHealthMatch).toBeTruthy();

        const publicHealthBody = publicHealthMatch[1];
        // Should NOT include memory, nodeVersion, webhooks, uptime, square details
        expect(publicHealthBody).not.toContain('heapUsed');
        expect(publicHealthBody).not.toContain('nodeVersion');
        expect(publicHealthBody).not.toContain('webhookHealth');
    });

    test('detailed health endpoint requires authentication', () => {
        const fs = require('fs');
        const path = require('path');
        const serverSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'server.js'),
            'utf8'
        );

        // /api/health/detailed must have requireAuth and requireAdmin
        expect(serverSource).toMatch(
            /app\.get\('\/api\/health\/detailed',\s*requireAuth,\s*requireAdmin/
        );
    });
});

// ==================== S-10: XSS in Vendor Catalog Validation ====================

describe('S-10: Vendor catalog validation errors are HTML-escaped', () => {
    test('validation error rendering uses escapeHtml()', () => {
        const fs = require('fs');
        const path = require('path');
        const vendorCatalogSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'public', 'js', 'vendor-catalog.js'),
            'utf8'
        );

        // The validation error loop must use escapeHtml on error messages
        expect(vendorCatalogSource).toContain('err.errors.map(e => escapeHtml(e)).join');
        // Should NOT have unescaped err.errors.join directly
        expect(vendorCatalogSource).not.toMatch(/err\.errors\.join\(',\s*'\)\s*<\/li>/);
    });
});

// ==================== S-2: /output Directory Auth ====================

describe('S-2: /output directory requires authentication', () => {
    test('server.js protects /output with auth check', () => {
        const fs = require('fs');
        const path = require('path');
        const serverSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'server.js'),
            'utf8'
        );

        // /output route must have auth middleware before express.static
        expect(serverSource).toMatch(/app\.use\('\/output'/);
        // The auth check should come before express.static
        const outputSection = serverSource.match(/app\.use\('\/output'[\s\S]*?express\.static/);
        expect(outputSection).toBeTruthy();
        expect(outputSection[0]).toContain('req.session');
    });
});

// ==================== S-3: OAuth Callback Session Verification ====================

describe('S-3: OAuth callback verifies session user', () => {
    test('callback route checks session user matches state record', () => {
        const fs = require('fs');
        const path = require('path');
        const oauthSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'routes', 'square-oauth.js'),
            'utf8'
        );

        // Must verify session user ID against state record user_id
        expect(oauthSource).toContain('req.session.user.id !== stateRecord.user_id');
    });
});

// ==================== S-11: Session Regeneration on OAuth ====================

describe('S-11: Session regeneration on OAuth callback', () => {
    test('callback calls session.regenerate after OAuth success', () => {
        const fs = require('fs');
        const path = require('path');
        const oauthSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'routes', 'square-oauth.js'),
            'utf8'
        );

        // Must call req.session.regenerate in the callback
        expect(oauthSource).toContain('req.session.regenerate');
    });
});

// ==================== S-7: OAuth Revoke Uses Standard Middleware ====================

describe('S-7: OAuth revoke uses standard requireMerchant middleware', () => {
    test('revoke route uses loadMerchantContext, requireMerchant, and requireMerchantRole', () => {
        const fs = require('fs');
        const path = require('path');
        const oauthSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'routes', 'square-oauth.js'),
            'utf8'
        );

        // The revoke route must use the standard middleware chain
        expect(oauthSource).toMatch(
            /router\.post\('\/revoke'.*loadMerchantContext.*requireMerchant.*requireMerchantRole/s
        );
    });
});

// ==================== S-4: No Inline Scripts in HTML ====================

describe('S-4: No inline script blocks in HTML files', () => {
    test('no HTML files contain inline <script> blocks (without src)', () => {
        const fs = require('fs');
        const path = require('path');
        const publicDir = path.join(__dirname, '..', '..', 'public');

        function findInlineScripts(dir, results = []) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    findInlineScripts(fullPath, results);
                } else if (entry.name.endsWith('.html')) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    // Match <script> tags that don't have a src attribute
                    const scriptTags = content.match(/<script(?![^>]*\bsrc\b)[^>]*>/gi);
                    if (scriptTags && scriptTags.length > 0) {
                        results.push({ file: fullPath, count: scriptTags.length });
                    }
                }
            }
            return results;
        }

        const results = findInlineScripts(publicDir);

        if (results.length > 0) {
            const details = results.map(r =>
                `${r.file}: ${r.count} inline <script> block(s)`
            ).join('\n');
            throw new Error('Found inline <script> blocks:\n' + details);
        }

        expect(results).toHaveLength(0);
    });
});
