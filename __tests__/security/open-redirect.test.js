/**
 * Open Redirect Prevention Test Suite
 *
 * SECURITY TESTS — validates that redirect URLs after login/OAuth
 * are restricted to local paths only, preventing phishing attacks.
 */

describe('Open Redirect Prevention', () => {

    describe('isLocalPath (Square OAuth)', () => {
        // Extract isLocalPath for direct testing by requiring the module internals
        // Since isLocalPath is not exported, we test it indirectly via the route behavior.
        // Here we test the same regex logic used in the route.

        function isLocalPath(url) {
            if (!url || typeof url !== 'string') return false;
            return /^\/[^/\\]/.test(url) && !url.includes('://') && !/[\x00-\x1f]/.test(url);
        }

        test('accepts valid local paths', () => {
            expect(isLocalPath('/dashboard.html')).toBe(true);
            expect(isLocalPath('/settings')).toBe(true);
            expect(isLocalPath('/inventory.html?filter=test&page=1')).toBe(true);
            expect(isLocalPath('/api/items')).toBe(true);
        });

        test('rejects absolute URLs to external domains', () => {
            expect(isLocalPath('https://evil.com')).toBe(false);
            expect(isLocalPath('http://evil.com')).toBe(false);
            expect(isLocalPath('https://evil.com/fake-login')).toBe(false);
        });

        test('rejects protocol-relative URLs (//evil.com)', () => {
            expect(isLocalPath('//evil.com')).toBe(false);
            expect(isLocalPath('//evil.com/phishing')).toBe(false);
        });

        test('rejects null, undefined, and empty strings', () => {
            expect(isLocalPath(null)).toBe(false);
            expect(isLocalPath(undefined)).toBe(false);
            expect(isLocalPath('')).toBe(false);
        });

        test('rejects non-string values', () => {
            expect(isLocalPath(123)).toBe(false);
            expect(isLocalPath({})).toBe(false);
            expect(isLocalPath([])).toBe(false);
        });

        test('rejects URLs with backslashes (IE path traversal)', () => {
            expect(isLocalPath('/\\evil.com')).toBe(false);
        });

        test('rejects URLs with control characters', () => {
            expect(isLocalPath('/dashboard\x00')).toBe(false);
            expect(isLocalPath('/dashboard\n')).toBe(false);
            expect(isLocalPath('/dashboard\r')).toBe(false);
        });

        test('rejects bare domain names', () => {
            expect(isLocalPath('evil.com')).toBe(false);
            expect(isLocalPath('evil.com/path')).toBe(false);
        });

        test('rejects javascript: protocol', () => {
            expect(isLocalPath('javascript:alert(1)')).toBe(false);
        });

        test('rejects data: protocol', () => {
            expect(isLocalPath('data:text/html,<h1>phishing</h1>')).toBe(false);
        });
    });

    describe('Login returnUrl validation', () => {
        // Test the same validation logic used in login.js

        function validateReturnUrl(rawReturnUrl) {
            return (rawReturnUrl && rawReturnUrl.startsWith('/') && !rawReturnUrl.startsWith('//'))
                ? rawReturnUrl
                : '/dashboard.html';
        }

        test('/dashboard redirect works', () => {
            expect(validateReturnUrl('/dashboard')).toBe('/dashboard');
        });

        test('/inventory.html?page=1 redirect works', () => {
            expect(validateReturnUrl('/inventory.html?page=1')).toBe('/inventory.html?page=1');
        });

        test('https://evil.com redirect is rejected', () => {
            expect(validateReturnUrl('https://evil.com')).toBe('/dashboard.html');
        });

        test('//evil.com redirect is rejected', () => {
            expect(validateReturnUrl('//evil.com')).toBe('/dashboard.html');
        });

        test('empty redirect defaults to /dashboard.html', () => {
            expect(validateReturnUrl('')).toBe('/dashboard.html');
            expect(validateReturnUrl(null)).toBe('/dashboard.html');
            expect(validateReturnUrl(undefined)).toBe('/dashboard.html');
        });

        test('http://evil.com redirect is rejected', () => {
            expect(validateReturnUrl('http://evil.com')).toBe('/dashboard.html');
        });

        test('javascript: URL is rejected', () => {
            expect(validateReturnUrl('javascript:alert(1)')).toBe('/dashboard.html');
        });

        test('bare domain is rejected', () => {
            expect(validateReturnUrl('evil.com')).toBe('/dashboard.html');
        });
    });
});
