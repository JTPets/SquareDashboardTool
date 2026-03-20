/**
 * Shared currency and number formatting utility.
 * Loaded globally before page-specific scripts.
 *
 * BACKLOG-23: Extracted from 14+ files with inline toLocaleString() calls.
 * BACKLOG-27: Standardizes all formatting to 'en-CA' locale.
 *
 * OSS locale: Reads window.MERCHANT_LOCALE and window.MERCHANT_CURRENCY
 * for multi-tenant / franchise support. Falls back to 'en-CA' / 'CAD'.
 */

/* eslint-disable no-unused-vars */

// LOGIC CHANGE: Read locale/currency from merchant globals with fallback (OSS locale)
function _getLocale() {
  return (typeof window !== 'undefined' && window.MERCHANT_LOCALE) || 'en-CA';
}

function _getCurrencySymbol() {
  // For now, always use '$'. Future: derive from window.MERCHANT_CURRENCY via Intl.
  return '$';
}

/**
 * Format cents as currency string (e.g. 1500 → "$15.00").
 * @param {number} cents - Amount in cents
 * @returns {string} Formatted currency string, or '--' on falsy (except 0)
 */
function formatCurrency(cents) {
  if (!cents && cents !== 0) return '--';
  var locale = _getLocale();
  return _getCurrencySymbol() + (cents / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Format a dollar amount as currency string (e.g. 15.5 → "$15.50").
 * @param {number} dollars - Amount in dollars
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {string} Formatted currency string
 */
function formatDollars(dollars, decimals) {
  var d = typeof decimals === 'number' ? decimals : 2;
  var locale = _getLocale();
  return _getCurrencySymbol() + Number(dollars || 0).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * Format a number with locale-appropriate separators (e.g. 1234 → "1,234").
 * @param {number} num - Number to format
 * @returns {string} Formatted number string
 */
function formatNumber(num) {
  var locale = _getLocale();
  return Number(num || 0).toLocaleString(locale);
}
