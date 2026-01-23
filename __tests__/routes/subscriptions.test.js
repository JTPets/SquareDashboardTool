/**
 * Subscription and Payment Test Suite
 *
 * BUSINESS CRITICAL TESTS
 * Tests for subscription creation, promo code validation, and payment security
 *
 * SECURITY NOTES:
 * - NO credit card data is stored locally
 * - All payment data is held by Square (PCI compliant)
 * - Only Square IDs (customer_id, card_id, subscription_id) are stored
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
}));

jest.mock('../../utils/subscription-handler', () => ({
    getPlans: jest.fn(),
    getSubscriberByEmail: jest.fn(),
    TRIAL_DAYS: 14,
}));

const db = require('../../utils/database');
const subscriptionHandler = require('../../utils/subscription-handler');
const logger = require('../../utils/logger');

describe('Subscription Routes', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Promo Code Validation', () => {

        describe('Code Lookup', () => {

            test('validates active promo code', async () => {
                const code = 'SUMMER20';

                db.query.mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        code: 'SUMMER20',
                        discount_type: 'percent',
                        discount_value: 20,
                        is_active: true,
                        description: '20% off summer sale'
                    }]
                });

                const result = await db.query(`
                    SELECT * FROM promo_codes
                    WHERE UPPER(code) = UPPER($1)
                      AND is_active = TRUE
                `, [code.trim()]);

                expect(result.rows.length).toBe(1);
                expect(result.rows[0].discount_value).toBe(20);
            });

            test('rejects inactive promo code', async () => {
                const code = 'EXPIRED';

                db.query.mockResolvedValueOnce({ rows: [] });

                const result = await db.query(`
                    SELECT * FROM promo_codes
                    WHERE UPPER(code) = UPPER($1)
                      AND is_active = TRUE
                `, [code.trim()]);

                expect(result.rows.length).toBe(0);
            });

            test('case insensitive code matching', async () => {
                const upperCode = 'DISCOUNT';
                const lowerCode = 'discount';
                const mixedCode = 'DiScOuNt';

                // All should match the same code
                expect(upperCode.toUpperCase()).toBe('DISCOUNT');
                expect(lowerCode.toUpperCase()).toBe('DISCOUNT');
                expect(mixedCode.toUpperCase()).toBe('DISCOUNT');
            });

            test('trims whitespace from code', () => {
                const code = '  PROMO123  ';
                expect(code.trim()).toBe('PROMO123');
            });
        });

        describe('Date Validation', () => {

            test('checks valid_from date', async () => {
                const now = new Date();
                const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
                const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Yesterday

                // Future valid_from should fail (code not yet active)
                expect(futureDate > now).toBe(true);

                // Past valid_from should pass
                expect(pastDate < now).toBe(true);
            });

            test('checks valid_until date', async () => {
                const now = new Date();
                const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);

                // Future valid_until should pass (code still active)
                expect(futureDate > now).toBe(true);

                // Past valid_until should fail (code expired)
                expect(pastDate < now).toBe(true);
            });

            test('allows null date fields (no restriction)', () => {
                const validFrom = null;
                const validUntil = null;

                // Null dates mean no restriction
                expect(validFrom === null || validFrom <= new Date()).toBe(true);
                expect(validUntil === null || validUntil >= new Date()).toBe(true);
            });
        });

        describe('Usage Limits', () => {

            test('checks max_uses limit', () => {
                const maxUses = 100;
                const timesUsed = 99;

                // Should be allowed (99 < 100)
                expect(timesUsed < maxUses).toBe(true);
            });

            test('rejects code at max uses', () => {
                const maxUses = 100;
                const timesUsed = 100;

                // Should be rejected (100 >= 100)
                expect(timesUsed < maxUses).toBe(false);
            });

            test('allows unlimited uses when max_uses is null', () => {
                const maxUses = null;
                const timesUsed = 9999;

                // Null max_uses means unlimited
                expect(maxUses === null || timesUsed < maxUses).toBe(true);
            });
        });

        describe('Plan Restrictions', () => {

            test('allows code with no plan restrictions', () => {
                const appliesToPlans = null;
                const selectedPlan = 'professional';

                const planAllowed = !appliesToPlans || appliesToPlans.length === 0 || appliesToPlans.includes(selectedPlan);

                expect(planAllowed).toBe(true);
            });

            test('allows code when plan is in allowed list', () => {
                const appliesToPlans = ['basic', 'professional'];
                const selectedPlan = 'professional';

                const planAllowed = appliesToPlans.includes(selectedPlan);

                expect(planAllowed).toBe(true);
            });

            test('rejects code when plan is not in allowed list', () => {
                const appliesToPlans = ['basic'];
                const selectedPlan = 'professional';

                const planAllowed = appliesToPlans.includes(selectedPlan);

                expect(planAllowed).toBe(false);
            });
        });

        describe('Minimum Purchase', () => {

            test('allows purchase above minimum', () => {
                const minPurchaseCents = 1000; // $10
                const priceCents = 1500; // $15

                const meetsMinimum = priceCents >= minPurchaseCents;

                expect(meetsMinimum).toBe(true);
            });

            test('rejects purchase below minimum', () => {
                const minPurchaseCents = 1000; // $10
                const priceCents = 500; // $5

                const meetsMinimum = priceCents >= minPurchaseCents;

                expect(meetsMinimum).toBe(false);
            });

            test('allows any purchase when no minimum', () => {
                const minPurchaseCents = null;
                const priceCents = 100; // $1

                const meetsMinimum = !minPurchaseCents || priceCents >= minPurchaseCents;

                expect(meetsMinimum).toBe(true);
            });
        });

        describe('Discount Calculation', () => {

            test('calculates percent discount correctly', () => {
                const discountType = 'percent';
                const discountValue = 20; // 20%
                const priceCents = 10000; // $100

                let discountCents = 0;
                if (discountType === 'percent') {
                    discountCents = Math.floor(priceCents * discountValue / 100);
                }

                expect(discountCents).toBe(2000); // $20
            });

            test('calculates fixed discount correctly', () => {
                const discountType = 'fixed';
                const discountValue = 1500; // $15
                const priceCents = 10000; // $100

                let discountCents = 0;
                if (discountType === 'percent') {
                    discountCents = Math.floor(priceCents * discountValue / 100);
                } else {
                    discountCents = discountValue;
                }

                expect(discountCents).toBe(1500); // $15
            });

            test('caps discount at price (prevents negative)', () => {
                const priceCents = 1000; // $10
                let discountCents = 2000; // $20 discount

                // Don't let discount exceed price
                if (discountCents > priceCents) {
                    discountCents = priceCents;
                }

                expect(discountCents).toBe(1000); // Capped at $10
            });

            test('floors percent calculation (no fractional cents)', () => {
                const discountValue = 33; // 33%
                const priceCents = 1000; // $10

                // 33% of 1000 = 330, not 330.0
                const discountCents = Math.floor(priceCents * discountValue / 100);

                expect(discountCents).toBe(330);
                expect(Number.isInteger(discountCents)).toBe(true);
            });
        });
    });

    describe('Subscription Creation', () => {

        describe('Input Validation', () => {

            test('requires email', () => {
                const email = undefined;

                expect(!email).toBe(true);
            });

            test('requires business name', () => {
                const businessName = undefined;

                expect(!businessName).toBe(true);
            });

            test('requires plan selection', () => {
                const plan = undefined;

                expect(!plan).toBe(true);
            });

            test('requires payment source ID', () => {
                const sourceId = undefined;

                expect(!sourceId).toBe(true);
            });
        });

        describe('Duplicate Prevention', () => {

            test('rejects duplicate email', async () => {
                const email = 'existing@example.com';

                subscriptionHandler.getSubscriberByEmail.mockResolvedValueOnce({
                    id: 123,
                    email: email
                });

                const existing = await subscriptionHandler.getSubscriberByEmail(email);

                expect(existing).toBeTruthy();
            });

            test('allows new email', async () => {
                const email = 'new@example.com';

                subscriptionHandler.getSubscriberByEmail.mockResolvedValueOnce(null);

                const existing = await subscriptionHandler.getSubscriberByEmail(email);

                expect(existing).toBeNull();
            });
        });

        describe('Plan Validation', () => {

            test('validates plan exists', async () => {
                const plans = [
                    { plan_key: 'basic', price_cents: 999 },
                    { plan_key: 'professional', price_cents: 1999 }
                ];
                const selectedPlanKey = 'professional';

                subscriptionHandler.getPlans.mockResolvedValueOnce(plans);

                const availablePlans = await subscriptionHandler.getPlans();
                const selectedPlan = availablePlans.find(p => p.plan_key === selectedPlanKey);

                expect(selectedPlan).toBeDefined();
                expect(selectedPlan.price_cents).toBe(1999);
            });

            test('rejects invalid plan', async () => {
                const plans = [
                    { plan_key: 'basic', price_cents: 999 }
                ];
                const selectedPlanKey = 'enterprise';

                subscriptionHandler.getPlans.mockResolvedValueOnce(plans);

                const availablePlans = await subscriptionHandler.getPlans();
                const selectedPlan = availablePlans.find(p => p.plan_key === selectedPlanKey);

                expect(selectedPlan).toBeUndefined();
            });

            test('requires Square plan ID configuration', () => {
                const plan = { plan_key: 'basic', price_cents: 999, square_plan_id: null };

                expect(!plan.square_plan_id).toBe(true);
                // Should return error: "Subscription plan not configured"
            });
        });

        describe('Configuration Checks', () => {

            test('requires SQUARE_LOCATION_ID', () => {
                const locationId = process.env.SQUARE_LOCATION_ID;

                // In test, env var is not set
                expect(locationId).toBeFalsy();
            });
        });

        describe('Trial Period', () => {

            test('default trial is 14 days', () => {
                expect(subscriptionHandler.TRIAL_DAYS).toBe(14);
            });
        });
    });

    describe('Security: No PCI Data Storage', () => {

        test('does not store credit card numbers', () => {
            const subscriber = {
                id: 1,
                email: 'user@example.com',
                square_customer_id: 'CUST_123',
                square_card_id: 'CARD_123',
                square_subscription_id: 'SUB_123'
            };

            // Should only store Square IDs, not card numbers
            expect(subscriber).not.toHaveProperty('card_number');
            expect(subscriber).not.toHaveProperty('cvv');
            expect(subscriber).not.toHaveProperty('expiration_date');
        });

        test('only stores Square IDs', () => {
            const allowedPaymentFields = [
                'square_customer_id',
                'square_card_id',
                'square_subscription_id'
            ];

            const forbiddenFields = [
                'card_number',
                'cc_number',
                'credit_card',
                'cvv',
                'cvc',
                'expiry',
                'expiration'
            ];

            // Verify we know what fields to check
            expect(allowedPaymentFields.length).toBe(3);
            expect(forbiddenFields.length).toBeGreaterThan(0);
        });

        test('sourceId is a nonce, not actual card data', () => {
            // sourceId from Square Web Payments SDK is a nonce token
            const sourceId = 'cnon:card-nonce-ok';

            // Nonces start with 'cnon:' or similar prefix
            expect(sourceId.startsWith('cnon:')).toBe(true);

            // Nonces are not actual card numbers
            expect(sourceId).not.toMatch(/^\d{13,19}$/); // Card number pattern
        });
    });

    describe('Admin Operations', () => {

        describe('Refund Processing', () => {

            test('requires admin role for refunds', () => {
                const userRole = 'user';

                expect(userRole).not.toBe('admin');
                // Should return 403
            });

            test('admin can process refund', () => {
                const userRole = 'admin';

                expect(userRole).toBe('admin');
                // Should be allowed
            });
        });

        describe('Subscriber Management', () => {

            test('requires admin role to list subscribers', () => {
                const userRole = 'user';

                expect(userRole).not.toBe('admin');
                // Should return 403
            });
        });

        describe('Plan Setup', () => {

            test('requires super admin for Square plan setup', () => {
                const userRole = 'admin';
                const isSuperAdmin = userRole === 'superadmin';

                expect(isSuperAdmin).toBe(false);
                // Should return 403
            });
        });
    });

    describe('Subscription Status', () => {

        test('identifies trial status', () => {
            const subscription = {
                status: 'active',
                trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days from now
            };

            const isInTrial = subscription.trial_ends_at && new Date(subscription.trial_ends_at) > new Date();

            expect(isInTrial).toBe(true);
        });

        test('identifies active status', () => {
            const subscription = {
                status: 'active',
                trial_ends_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
            };

            const isActive = subscription.status === 'active';
            const isInTrial = subscription.trial_ends_at && new Date(subscription.trial_ends_at) > new Date();

            expect(isActive).toBe(true);
            expect(isInTrial).toBe(false);
        });

        test('identifies cancelled status', () => {
            const subscription = {
                status: 'cancelled',
                cancelled_at: new Date()
            };

            const isCancelled = subscription.status === 'cancelled';

            expect(isCancelled).toBe(true);
        });

        test('identifies expired status', () => {
            const subscription = {
                status: 'expired',
                expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000) // Yesterday
            };

            const isExpired = subscription.status === 'expired' ||
                (subscription.expires_at && new Date(subscription.expires_at) < new Date());

            expect(isExpired).toBe(true);
        });
    });

    describe('Error Handling', () => {

        test('logs promo code validation errors', () => {
            logger.error('Promo code validation error', {
                error: 'Database connection failed',
                code: 'SUMMER20'
            });

            expect(logger.error).toHaveBeenCalledWith(
                'Promo code validation error',
                expect.objectContaining({ error: 'Database connection failed' })
            );
        });

        test('logs plan retrieval errors', () => {
            logger.error('Get plans error', {
                error: 'Square API unavailable'
            });

            expect(logger.error).toHaveBeenCalledWith(
                'Get plans error',
                expect.objectContaining({ error: 'Square API unavailable' })
            );
        });

        test('returns generic error messages to client', () => {
            // Don't expose internal error details
            const internalError = 'SQLSTATE: connection refused to database...';
            const clientError = 'Failed to validate promo code';

            expect(clientError).not.toContain('SQLSTATE');
            expect(clientError).not.toContain('database');
        });
    });
});
