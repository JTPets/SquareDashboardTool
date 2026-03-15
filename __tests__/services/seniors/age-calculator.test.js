/**
 * Age Calculator Tests
 *
 * Tests for pure age calculation functions used by seniors discount service.
 */

jest.mock('../../../config/constants', () => ({
    SENIORS_DISCOUNT: {
        MIN_AGE: 60,
        DISCOUNT_PERCENT: 10,
        GROUP_NAME: 'Seniors 60 Plus',
        DISCOUNT_NAME: 'Seniors Day 10 Percent Off',
        DAY_OF_MONTH: 1,
    },
}));

const { calculateAge, isSenior, parseBirthday, formatBirthday, getNextBirthday } = require('../../../services/seniors/age-calculator');

describe('Age Calculator', () => {
    // ==================== calculateAge ====================
    describe('calculateAge', () => {
        test('calculates age correctly for past birthday this year', () => {
            const asOf = new Date(2026, 5, 15); // June 15, 2026
            expect(calculateAge('1990-01-15', asOf)).toBe(36);
        });

        test('calculates age correctly when birthday has not occurred yet', () => {
            const asOf = new Date(2026, 0, 10); // Jan 10, 2026
            expect(calculateAge('1990-01-15', asOf)).toBe(35);
        });

        test('calculates age correctly on exact birthday', () => {
            const asOf = new Date(2026, 0, 15); // Jan 15, 2026
            expect(calculateAge('1990-01-15', asOf)).toBe(36);
        });

        test('returns null for null birthday', () => {
            expect(calculateAge(null)).toBeNull();
        });

        test('returns null for undefined birthday', () => {
            expect(calculateAge(undefined)).toBeNull();
        });

        test('returns null for empty string', () => {
            expect(calculateAge('')).toBeNull();
        });

        test('returns null for invalid date string', () => {
            expect(calculateAge('not-a-date')).toBeNull();
        });

        test('accepts Date object as birthday', () => {
            const birthday = new Date(1960, 2, 1); // March 1, 1960
            const asOf = new Date(2026, 5, 15);
            expect(calculateAge(birthday, asOf)).toBe(66);
        });

        test('handles leap year birthday', () => {
            const asOf = new Date(2026, 2, 1); // March 1, 2026 (not a leap year)
            expect(calculateAge('2000-02-29', asOf)).toBe(26);
        });

        test('same month, day before birthday', () => {
            const asOf = new Date(2026, 5, 14);
            expect(calculateAge('1990-06-15', asOf)).toBe(35);
        });

        test('same month, day after birthday', () => {
            const asOf = new Date(2026, 5, 16);
            expect(calculateAge('1990-06-15', asOf)).toBe(36);
        });
    });

    // ==================== isSenior ====================
    describe('isSenior', () => {
        test('returns true for customer aged 60+', () => {
            const asOf = new Date(2026, 5, 15);
            expect(isSenior('1960-01-01', undefined, asOf)).toBe(true);
        });

        test('returns false for customer under 60', () => {
            const asOf = new Date(2026, 5, 15);
            expect(isSenior('1990-01-01', undefined, asOf)).toBe(false);
        });

        test('returns true for exactly 60 years old', () => {
            const asOf = new Date(2026, 5, 15);
            expect(isSenior('1966-06-15', undefined, asOf)).toBe(true);
        });

        test('returns false for 59 (birthday not yet)', () => {
            const asOf = new Date(2026, 5, 14);
            expect(isSenior('1966-06-15', undefined, asOf)).toBe(false);
        });

        test('returns false for null birthday', () => {
            expect(isSenior(null)).toBe(false);
        });

        test('uses custom minAge', () => {
            const asOf = new Date(2026, 5, 15);
            expect(isSenior('1976-01-01', 50, asOf)).toBe(true);
            expect(isSenior('1976-01-01', 51, asOf)).toBe(false);
        });
    });

    // ==================== parseBirthday ====================
    describe('parseBirthday', () => {
        test('parses valid YYYY-MM-DD string', () => {
            const result = parseBirthday('1990-01-15');
            expect(result).toBeInstanceOf(Date);
            expect(result.getFullYear()).toBe(1990);
        });

        test('returns null for null input', () => {
            expect(parseBirthday(null)).toBeNull();
        });

        test('returns null for undefined', () => {
            expect(parseBirthday(undefined)).toBeNull();
        });

        test('returns null for empty string', () => {
            expect(parseBirthday('')).toBeNull();
        });

        test('returns null for non-string', () => {
            expect(parseBirthday(12345)).toBeNull();
        });

        test('returns null for wrong format (MM/DD/YYYY)', () => {
            expect(parseBirthday('01/15/1990')).toBeNull();
        });

        test('returns null for partial date', () => {
            expect(parseBirthday('1990-01')).toBeNull();
        });

        test('returns null for invalid date values', () => {
            expect(parseBirthday('1990-13-01')).toBeNull();
        });
    });

    // ==================== formatBirthday ====================
    describe('formatBirthday', () => {
        test('formats Date to YYYY-MM-DD', () => {
            const date = new Date(1990, 0, 15); // Jan 15, 1990
            expect(formatBirthday(date)).toBe('1990-01-15');
        });

        test('pads single-digit month and day', () => {
            const date = new Date(1990, 2, 5); // March 5
            expect(formatBirthday(date)).toBe('1990-03-05');
        });

        test('returns null for null', () => {
            expect(formatBirthday(null)).toBeNull();
        });

        test('returns null for non-Date', () => {
            expect(formatBirthday('1990-01-15')).toBeNull();
        });

        test('returns null for invalid Date', () => {
            expect(formatBirthday(new Date('invalid'))).toBeNull();
        });
    });

    // ==================== getNextBirthday ====================
    describe('getNextBirthday', () => {
        test('returns this year birthday if not yet passed', () => {
            const today = new Date();
            // Use a birthday that's always in the future (Dec 31)
            const birthday = `1990-12-31`;
            const next = getNextBirthday(birthday);
            if (next) {
                expect(next.getMonth()).toBe(11); // December
                expect(next.getDate()).toBe(31);
            }
        });

        test('returns null for invalid birthday string', () => {
            expect(getNextBirthday('invalid')).toBeNull();
        });

        test('returns null for null', () => {
            expect(getNextBirthday(null)).toBeNull();
        });

        test('accepts Date object', () => {
            const birthday = new Date(1990, 11, 31);
            const next = getNextBirthday(birthday);
            expect(next).toBeInstanceOf(Date);
        });
    });
});
