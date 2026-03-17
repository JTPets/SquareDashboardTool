/**
 * Tests for DB-6: ON DELETE CASCADE on user_id foreign keys
 * Verifies schema.sql includes CASCADE for all user-referencing FKs.
 */

const fs = require('fs');
const path = require('path');

describe('DB-6: ON DELETE CASCADE on user_id foreign keys', () => {
    let schemaContent;

    beforeAll(() => {
        const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
        schemaContent = fs.readFileSync(schemaPath, 'utf8');
    });

    // All columns in schema.sql that reference users(id)
    const expectedCascadeTables = [
        { table: 'oauth_states', column: 'user_id' },
        { table: 'delivery_routes', column: 'generated_by' },
        { table: 'delivery_audit_log', column: 'user_id' },
        { table: 'loyalty_offers', column: 'created_by' },
        { table: 'loyalty_redemptions', column: 'redeemed_by_user_id' },
        { table: 'loyalty_audit_logs', column: 'user_id' },
        { table: 'delivery_route_tokens', column: 'created_by' },
    ];

    test.each(expectedCascadeTables)(
        '$table.$column should have ON DELETE CASCADE',
        ({ table, column }) => {
            // Find the CREATE TABLE block for this table
            const tableRegex = new RegExp(
                `CREATE TABLE[^(]*${table}\\s*\\(([^;]+);`,
                's'
            );
            const match = schemaContent.match(tableRegex);
            expect(match).toBeTruthy();

            const tableBody = match[1];

            // Find the column definition with REFERENCES users(id)
            const columnRegex = new RegExp(
                `${column}\\s+INTEGER\\s+REFERENCES\\s+users\\(id\\)\\s+ON DELETE CASCADE`
            );
            expect(tableBody).toMatch(columnRegex);
        }
    );

    test('no user_id FK references users(id) without ON DELETE CASCADE', () => {
        // Find all lines referencing users(id) and ensure none lack CASCADE
        const lines = schemaContent.split('\n');
        const userFkLines = lines.filter(
            line => line.includes('REFERENCES users(id)') && !line.trim().startsWith('--')
        );

        for (const line of userFkLines) {
            expect(line).toContain('ON DELETE CASCADE');
        }
    });

    test('migration 072 exists and covers all 7 tables', () => {
        const migrationPath = path.join(
            __dirname, '..', '..', 'database', 'migrations',
            '072_add_cascade_user_fks.sql'
        );
        const migration = fs.readFileSync(migrationPath, 'utf8');

        const tables = [
            'oauth_states',
            'delivery_routes',
            'delivery_audit_log',
            'loyalty_offers',
            'loyalty_redemptions',
            'loyalty_audit_logs',
            'delivery_route_tokens',
        ];

        for (const table of tables) {
            expect(migration).toContain(`ALTER TABLE ${table}`);
            expect(migration).toContain('ON DELETE CASCADE');
        }
    });
});
