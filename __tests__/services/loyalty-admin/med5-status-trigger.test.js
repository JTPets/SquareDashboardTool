/**
 * Tests for MED-5: loyalty_rewards status transition trigger
 *
 * These tests verify the trigger SQL logic by testing the transition rules
 * directly. Since we can't run PL/pgSQL in Jest, we test the logic
 * declaratively: asserting which transitions are valid and which are blocked.
 *
 * Integration testing with a real database should verify:
 * - Valid: in_progress->earned, earned->redeemed, earned->revoked
 * - Blocked: redeemed->*, revoked->*, in_progress->redeemed, earned->in_progress, etc.
 * - Non-status updates always allowed
 */

const fs = require('fs');
const path = require('path');

describe('MED-5: loyalty_rewards status transition trigger', () => {
    const migrationPath = path.join(__dirname, '../../../database/migrations/archive/071_loyalty_rewards_status_trigger.sql');

    test('migration file exists', () => {
        expect(fs.existsSync(migrationPath)).toBe(true);
    });

    test('migration creates the trigger function', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        expect(sql).toContain('CREATE OR REPLACE FUNCTION enforce_loyalty_reward_status_transition()');
        expect(sql).toContain('RETURNS TRIGGER');
    });

    test('migration creates the trigger on loyalty_rewards', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        expect(sql).toContain('CREATE TRIGGER enforce_loyalty_reward_status');
        expect(sql).toContain('BEFORE UPDATE ON loyalty_rewards');
        expect(sql).toContain('FOR EACH ROW');
    });

    test('migration is idempotent (DROP IF EXISTS before CREATE)', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        expect(sql).toContain('DROP TRIGGER IF EXISTS enforce_loyalty_reward_status ON loyalty_rewards');
    });

    test('trigger allows non-status updates (OLD.status = NEW.status)', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        expect(sql).toContain('IF OLD.status = NEW.status THEN');
        expect(sql).toContain('RETURN NEW');
    });

    // Verify valid transitions are in the trigger
    const validTransitions = [
        { from: 'in_progress', to: 'earned' },
        { from: 'earned', to: 'redeemed' },
        { from: 'earned', to: 'revoked' }
    ];

    for (const { from, to } of validTransitions) {
        test(`trigger allows valid transition: ${from} -> ${to}`, () => {
            const sql = fs.readFileSync(migrationPath, 'utf8');
            expect(sql).toContain(`OLD.status = '${from}' AND NEW.status = '${to}'`);
        });
    }

    // Verify invalid transitions would raise exception
    test('trigger raises exception on invalid transitions', () => {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        expect(sql).toContain('RAISE EXCEPTION');
        expect(sql).toContain('Invalid loyalty_rewards status transition from % to %');
    });

    // Verify that the following invalid transitions are NOT allowed
    // (they should fall through to the RAISE EXCEPTION)
    const invalidTransitions = [
        { from: 'redeemed', to: 'earned', desc: 'terminal state redeemed cannot go back' },
        { from: 'redeemed', to: 'in_progress', desc: 'terminal state redeemed cannot go back' },
        { from: 'revoked', to: 'earned', desc: 'terminal state revoked cannot go back' },
        { from: 'revoked', to: 'in_progress', desc: 'terminal state revoked cannot go back' },
        { from: 'in_progress', to: 'redeemed', desc: 'cannot skip earned' },
        { from: 'in_progress', to: 'revoked', desc: 'in_progress cannot go directly to revoked' },
        { from: 'earned', to: 'in_progress', desc: 'cannot go backwards' }
    ];

    for (const { from, to, desc } of invalidTransitions) {
        test(`trigger blocks invalid transition: ${from} -> ${to} (${desc})`, () => {
            const sql = fs.readFileSync(migrationPath, 'utf8');
            // The transition should NOT have a matching RETURN NEW clause
            // Valid transitions are explicit IF/ELSIF checks that RETURN NEW
            // Invalid transitions fall through to RAISE EXCEPTION
            const allowPattern = `OLD.status = '${from}' AND NEW.status = '${to}'`;
            // Count only in IF/ELSIF context (not in RAISE or comments)
            const lines = sql.split('\n');
            const allowingLines = lines.filter(line =>
                line.includes(allowPattern) &&
                (line.trim().startsWith('IF') || line.trim().startsWith('ELSIF'))
            );
            expect(allowingLines).toHaveLength(0);
        });
    }

    test('schema.sql includes the trigger', () => {
        const schemaPath = path.join(__dirname, '../../../database/schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        expect(schema).toContain('enforce_loyalty_reward_status_transition');
        expect(schema).toContain('CREATE TRIGGER enforce_loyalty_reward_status');
    });
});
