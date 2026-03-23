/**
 * Tests for utils/escape-like.js
 *
 * Verifies that LIKE wildcard characters (%, _) are properly escaped
 * so user input is treated as literal text in SQL LIKE/ILIKE patterns.
 */

const { escapeLikePattern } = require('../../utils/escape-like');

describe('escapeLikePattern', () => {
    it('should return normal strings unchanged', () => {
        expect(escapeLikePattern('hello')).toBe('hello');
        expect(escapeLikePattern('test search')).toBe('test search');
        expect(escapeLikePattern('')).toBe('');
    });

    it('should escape % wildcard', () => {
        expect(escapeLikePattern('%')).toBe('\\%');
        expect(escapeLikePattern('100%')).toBe('100\\%');
        expect(escapeLikePattern('%match%')).toBe('\\%match\\%');
    });

    it('should escape _ wildcard', () => {
        expect(escapeLikePattern('_')).toBe('\\_');
        expect(escapeLikePattern('a_b')).toBe('a\\_b');
        expect(escapeLikePattern('__test__')).toBe('\\_\\_test\\_\\_');
    });

    it('should escape backslash', () => {
        expect(escapeLikePattern('\\')).toBe('\\\\');
        expect(escapeLikePattern('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('should escape all special characters together', () => {
        expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
        expect(escapeLikePattern('100% off_sale\\promo')).toBe('100\\% off\\_sale\\\\promo');
    });

    it('should handle non-string input gracefully', () => {
        expect(escapeLikePattern(null)).toBe(null);
        expect(escapeLikePattern(undefined)).toBe(undefined);
        expect(escapeLikePattern(123)).toBe(123);
    });

    it('should not match everything when % is searched', () => {
        // This is the core security test: searching for "%" should not
        // become a wildcard that matches all rows
        const escaped = escapeLikePattern('%');
        expect(escaped).not.toBe('%');
        expect(escaped).toBe('\\%');
    });

    it('should not match single characters when _ is searched', () => {
        const escaped = escapeLikePattern('_');
        expect(escaped).not.toBe('_');
        expect(escaped).toBe('\\_');
    });
});
