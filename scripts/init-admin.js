#!/usr/bin/env node
/**
 * Initialize Admin User Script
 * Creates the first admin user if none exists
 *
 * Usage:
 *   node scripts/init-admin.js
 *   node scripts/init-admin.js --email admin@example.com --password MySecurePass1
 *
 * Or set environment variables:
 *   ADMIN_EMAIL=admin@example.com
 *   ADMIN_PASSWORD=MySecurePass1
 */

require('dotenv').config();
const db = require('../utils/database');
const { hashPassword, validatePassword, generateRandomPassword } = require('../utils/password');

async function initAdmin() {
    console.log('='.repeat(50));
    console.log('Admin User Initialization');
    console.log('='.repeat(50));

    try {
        // Check if users table exists
        const tableCheck = await db.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'users'
            )
        `);

        if (!tableCheck.rows[0].exists) {
            console.error('\nError: users table does not exist.');
            console.error('The table should be created automatically on server startup.');
            console.error('Please start the server first to create the authentication tables,');
            console.error('then run this script again.\n');
            process.exit(1);
        }

        // Check if any admin users exist
        const existingAdmins = await db.query(
            "SELECT COUNT(*) as count FROM users WHERE role = 'admin'"
        );

        if (parseInt(existingAdmins.rows[0].count) > 0) {
            console.log('\nAdmin user(s) already exist:');
            const admins = await db.query(
                "SELECT email, name, is_active, last_login FROM users WHERE role = 'admin'"
            );
            admins.rows.forEach(admin => {
                console.log(`  - ${admin.email} (${admin.is_active ? 'active' : 'inactive'})`);
            });
            console.log('\nNo new admin created.');
            process.exit(0);
        }

        // Get admin credentials from args or env
        const args = process.argv.slice(2);
        let email = process.env.ADMIN_EMAIL;
        let password = process.env.ADMIN_PASSWORD;

        // Parse command line arguments
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--email' && args[i + 1]) {
                email = args[i + 1];
                i++;
            } else if (args[i] === '--password' && args[i + 1]) {
                password = args[i + 1];
                i++;
            }
        }

        // Prompt for email if not provided
        if (!email) {
            console.error('\nError: Admin email is required.');
            console.error('Provide via --email flag or ADMIN_EMAIL environment variable.\n');
            console.error('Usage:');
            console.error('  node scripts/init-admin.js --email admin@example.com\n');
            process.exit(1);
        }

        // Validate email format
        if (!email.includes('@')) {
            console.error('\nError: Invalid email format.\n');
            process.exit(1);
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Check if email already exists
        const existingUser = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [normalizedEmail]
        );

        if (existingUser.rows.length > 0) {
            console.error(`\nError: User with email ${normalizedEmail} already exists.\n`);
            process.exit(1);
        }

        // Generate password if not provided
        let generatedPassword = null;
        if (!password) {
            password = generateRandomPassword(16);
            generatedPassword = password;
            console.log('\nNo password provided. Generating secure password...');
        } else {
            // Validate provided password
            const validation = validatePassword(password);
            if (!validation.valid) {
                console.error('\nError: Password does not meet requirements:');
                validation.errors.forEach(err => console.error(`  - ${err}`));
                console.error('');
                process.exit(1);
            }
        }

        // Hash password
        console.log('Hashing password...');
        const passwordHash = await hashPassword(password);

        // Create admin user
        const result = await db.query(`
            INSERT INTO users (email, password_hash, name, role, is_active)
            VALUES ($1, $2, 'Administrator', 'admin', true)
            RETURNING id, email, role, created_at
        `, [normalizedEmail, passwordHash]);

        const newAdmin = result.rows[0];

        console.log('\n' + '='.repeat(50));
        console.log('Admin user created successfully!');
        console.log('='.repeat(50));
        console.log(`\n  Email:    ${newAdmin.email}`);
        console.log(`  Role:     ${newAdmin.role}`);

        if (generatedPassword) {
            console.log(`  Password: ${generatedPassword}`);
            console.log('\n  ⚠️  SAVE THIS PASSWORD! It will not be shown again.');
        }

        console.log('\nYou can now log in at /login.html\n');

        process.exit(0);

    } catch (error) {
        console.error('\nError:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    initAdmin();
}

module.exports = { initAdmin };
