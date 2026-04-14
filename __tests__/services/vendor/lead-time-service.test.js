const { calculateLeadTime } = require('../../../services/vendor/lead-time-service');

describe('calculateLeadTime', () => {
    describe('fixed schedule vendors', () => {
        test('Freedom case: Thursday order → Monday receive = 4 days', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'thursday',
                receive_day: 'monday',
                lead_time_days: 7
            };
            expect(calculateLeadTime(vendor)).toBe(4);
        });

        test('same-day vendor: Monday → Monday = full week (7)', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'monday',
                receive_day: 'monday',
                lead_time_days: 0
            };
            expect(calculateLeadTime(vendor)).toBe(7);
        });

        test('same-week: Monday → Friday = 4', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'monday',
                receive_day: 'friday',
                lead_time_days: 7
            };
            expect(calculateLeadTime(vendor)).toBe(4);
        });

        test('wraps across week: Friday → Tuesday = 4', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'friday',
                receive_day: 'tuesday',
                lead_time_days: 7
            };
            expect(calculateLeadTime(vendor)).toBe(4);
        });

        test('next-day: Monday → Tuesday = 1', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'monday',
                receive_day: 'tuesday',
                lead_time_days: 7
            };
            expect(calculateLeadTime(vendor)).toBe(1);
        });

        test('handles uppercase day names', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'THURSDAY',
                receive_day: 'Monday',
                lead_time_days: 7
            };
            expect(calculateLeadTime(vendor)).toBe(4);
        });

        test('missing order_day falls back to stored lead_time_days', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: null,
                receive_day: 'monday',
                lead_time_days: 5
            };
            expect(calculateLeadTime(vendor)).toBe(5);
        });

        test('missing receive_day falls back to stored lead_time_days', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'monday',
                receive_day: null,
                lead_time_days: 5
            };
            expect(calculateLeadTime(vendor)).toBe(5);
        });

        test('unknown day name falls back to stored lead_time_days', () => {
            const vendor = {
                schedule_type: 'fixed',
                order_day: 'someday',
                receive_day: 'monday',
                lead_time_days: 2
            };
            expect(calculateLeadTime(vendor)).toBe(2);
        });
    });

    describe('anytime schedule vendors', () => {
        test('anytime vendor with lead_time_days 3 returns 3', () => {
            const vendor = {
                schedule_type: 'anytime',
                order_day: null,
                receive_day: null,
                lead_time_days: 3
            };
            expect(calculateLeadTime(vendor)).toBe(3);
        });

        test('anytime vendor ignores order_day/receive_day', () => {
            const vendor = {
                schedule_type: 'anytime',
                order_day: 'thursday',
                receive_day: 'monday',
                lead_time_days: 10
            };
            expect(calculateLeadTime(vendor)).toBe(10);
        });

        test('null schedule_type treated as non-fixed', () => {
            const vendor = {
                schedule_type: null,
                order_day: 'thursday',
                receive_day: 'monday',
                lead_time_days: 5
            };
            expect(calculateLeadTime(vendor)).toBe(5);
        });

        test('null lead_time_days returns null', () => {
            const vendor = {
                schedule_type: 'anytime',
                order_day: null,
                receive_day: null,
                lead_time_days: null
            };
            expect(calculateLeadTime(vendor)).toBeNull();
        });
    });

    describe('edge cases', () => {
        test('null vendor returns null', () => {
            expect(calculateLeadTime(null)).toBeNull();
        });

        test('undefined vendor returns null', () => {
            expect(calculateLeadTime(undefined)).toBeNull();
        });
    });
});
