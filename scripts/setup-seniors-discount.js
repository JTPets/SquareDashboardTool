#!/usr/bin/env node

/**
 * Seniors Day Discount Setup Script
 *
 * Sets up the Square objects required for the seniors discount feature:
 * - Customer Group: "Seniors (60+)"
 * - Catalog Discount: 10% off
 * - Product Set: All items
 * - Pricing Rule: Ties discount to group
 *
 * Prerequisites:
 * - Migration 032_seniors_day.sql must be run first
 * - Environment variables must be set (.env file)
 *
 * Usage:
 *   node scripts/setup-seniors-discount.js [merchantId]
 *
 * If merchantId is not provided, defaults to merchant ID 1 (JTPets).
 */

const { SeniorsService } = require('../services/seniors');
const db = require('../utils/database');
const logger = require('../utils/logger');

async function main() {
    const merchantId = parseInt(process.argv[2] || '1', 10);

    console.log('='.repeat(60));
    console.log('Seniors Day Discount Setup');
    console.log('='.repeat(60));
    console.log(`Merchant ID: ${merchantId}`);
    console.log('');

    try {
        // Verify merchant exists
        const merchantResult = await db.query(
            'SELECT id, business_name FROM merchants WHERE id = $1',
            [merchantId]
        );

        if (merchantResult.rows.length === 0) {
            console.error(`ERROR: Merchant ${merchantId} not found`);
            process.exit(1);
        }

        const merchant = merchantResult.rows[0];
        console.log(`Business: ${merchant.business_name}`);
        console.log('');

        // Initialize and run setup
        console.log('Initializing seniors service...');
        const service = new SeniorsService(merchantId);
        await service.initialize();

        console.log('Creating Square objects...');
        const config = await service.setupSquareObjects();

        console.log('');
        console.log('Setup complete!');
        console.log('-'.repeat(60));
        console.log('Square Object IDs:');
        console.log(`  Customer Group: ${config.square_group_id}`);
        console.log(`  Discount:       ${config.square_discount_id}`);
        console.log(`  Product Set:    ${config.square_product_set_id}`);
        console.log(`  Pricing Rule:   ${config.square_pricing_rule_id}`);
        console.log('');
        console.log('Configuration:');
        console.log(`  Discount:       ${config.discount_percent}%`);
        console.log(`  Minimum Age:    ${config.min_age}`);
        console.log(`  Enabled:        ${config.is_enabled}`);
        console.log('');
        console.log('Next steps:');
        console.log('1. Verify objects in Square Dashboard');
        console.log('2. Enable cron jobs in cron-scheduler.js (Phase 4)');
        console.log('3. Run backfill for existing customers (Phase 5)');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('');
        console.error('ERROR:', error.message);
        if (error.details) {
            console.error('Details:', JSON.stringify(error.details, null, 2));
        }
        logger.error('Seniors discount setup failed', {
            merchantId,
            error: error.message,
            stack: error.stack,
        });
        process.exit(1);
    } finally {
        // Close database pool
        await db.end();
    }
}

main();
