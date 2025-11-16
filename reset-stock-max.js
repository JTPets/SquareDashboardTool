/**
 * One-time script to reset stock_alert_max from 99999 to NULL (infinity)
 * Usage: node reset-stock-max.js
 */

require('dotenv').config();
const db = require('./utils/database');

async function resetStockMax() {
  try {
    console.log('Connecting to database...');

    // First, count how many records will be affected
    const countResult = await db.query(
      'SELECT COUNT(*) FROM variations WHERE stock_alert_max = 99999'
    );
    const count = parseInt(countResult.rows[0].count);

    console.log(`Found ${count} records with stock_alert_max = 99999`);

    if (count === 0) {
      console.log('No records to update. Exiting.');
      process.exit(0);
    }

    // Ask for confirmation
    console.log('\nThis will reset all stock_alert_max values from 99999 to NULL (unlimited).');
    console.log('Updating...');

    // Reset to NULL
    const result = await db.query(
      'UPDATE variations SET stock_alert_max = NULL WHERE stock_alert_max = 99999'
    );

    console.log(`✅ Successfully updated ${result.rowCount} records`);
    console.log('All stock maximums have been reset to infinity (∞)');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

resetStockMax();
