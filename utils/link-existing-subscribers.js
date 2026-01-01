#!/usr/bin/env node
/**
 * Link Existing Subscribers to User Accounts
 *
 * This script finds subscribers without user accounts and creates them.
 * Run after deploying the user account creation fix.
 *
 * Usage: node utils/link-existing-subscribers.js
 */

require('dotenv').config();
const db = require('./database');
const { hashPassword, generateRandomPassword } = require('./password');
const crypto = require('crypto');

async function linkExistingSubscribers() {
    console.log('🔍 Finding subscribers without user accounts...\n');

    try {
        // Ensure database tables exist
        await db.ensureSchema();

        // Find subscribers without linked user accounts
        const orphanedSubscribers = await db.query(`
            SELECT s.id, s.email, s.business_name, s.subscription_status
            FROM subscribers s
            LEFT JOIN users u ON u.email = LOWER(s.email)
            WHERE s.user_id IS NULL OR u.id IS NULL
            ORDER BY s.id
        `);

        if (orphanedSubscribers.rows.length === 0) {
            console.log('✅ All subscribers have linked user accounts!');
            return;
        }

        console.log(`Found ${orphanedSubscribers.rows.length} subscriber(s) without user accounts:\n`);

        const results = [];

        for (const subscriber of orphanedSubscribers.rows) {
            const email = subscriber.email.toLowerCase().trim();
            console.log(`Processing: ${email}`);

            // Check if user already exists with this email
            const existingUser = await db.query(
                'SELECT id FROM users WHERE email = $1',
                [email]
            );

            let userId;

            if (existingUser.rows.length > 0) {
                // User exists, just link them
                userId = existingUser.rows[0].id;
                console.log(`  → User already exists (ID: ${userId}), linking...`);
            } else {
                // Create new user
                const tempPassword = generateRandomPassword();
                const passwordHash = await hashPassword(tempPassword);

                const userResult = await db.query(`
                    INSERT INTO users (email, password_hash, name, role)
                    VALUES ($1, $2, $3, 'user')
                    RETURNING id
                `, [email, passwordHash, subscriber.business_name || null]);

                userId = userResult.rows[0].id;
                console.log(`  → Created user account (ID: ${userId})`);
            }

            // Link subscriber to user
            await db.query(`
                UPDATE subscribers SET user_id = $1 WHERE id = $2
            `, [userId, subscriber.id]);

            // Generate password reset token
            const resetToken = crypto.randomBytes(32).toString('hex');
            const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            // Delete any existing tokens for this user
            await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

            // Insert new token
            await db.query(`
                INSERT INTO password_reset_tokens (user_id, token, expires_at)
                VALUES ($1, $2, $3)
            `, [userId, resetToken, tokenExpiry]);

            const resetUrl = `/set-password.html?token=${resetToken}&new=true`;

            results.push({
                email,
                subscriberId: subscriber.id,
                userId,
                status: subscriber.subscription_status,
                resetUrl
            });

            console.log(`  → Generated password reset token\n`);
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('SUMMARY - Password Setup Links');
        console.log('='.repeat(60) + '\n');
        console.log('Send these links to your subscribers so they can set their passwords:\n');

        for (const result of results) {
            console.log(`Email: ${result.email}`);
            console.log(`Status: ${result.status}`);
            console.log(`Reset URL: ${result.resetUrl}`);
            console.log('');
        }

        console.log('='.repeat(60));
        console.log(`\n✅ Processed ${results.length} subscriber(s)`);
        console.log('\nNote: Reset tokens expire in 24 hours.');
        console.log('Users can also use "Forgot Password" on the login page.');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }

    process.exit(0);
}

linkExistingSubscribers();
