/**
 * Shared currency and number formatting utility.
 * Loaded globally before page-specific scripts.
 *
 * BACKLOG-23: Extracted from 14+ files with inline toLocaleString() calls.
 * BACKLOG-27: Standardizes all formatting to 'en-CA' locale.
 */

/* eslint-disable no-unused-vars */

/**
 * Format cents as currency string (e.g. 1500 → "$15.00").
 * @param {number} cents - Amount in cents
 * @returns {string} Formatted currency string, or '--' on falsy (except 0)
 */
function formatCurrency(cents) {
  if (!cents && cents !== 0) return '--';
  return '$' + (cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Format a dollar amount as currency string (e.g. 15.5 → "$15.50").
 * @param {number} dollars - Amount in dollars
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {string} Formatted currency string
 */
function formatDollars(dollars, decimals) {
  var d = typeof decimals === 'number' ? decimals : 2;
  return '$' + Number(dollars || 0).toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * Format a number with locale-appropriate separators (e.g. 1234 → "1,234").
 * @param {number} num - Number to format
 * @returns {string} Formatted number string
 */
function formatNumber(num) {
  return Number(num || 0).toLocaleString('en-CA');
}
