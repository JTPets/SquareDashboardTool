/**
 * Shared date formatting utility.
 * Loaded globally before page-specific scripts.
 *
 * BACKLOG-26: Extended with formatDateTime for timestamp formatting.
 * BACKLOG-27: Standardized to 'en-CA' locale.
 *
 * OSS locale: Reads window.MERCHANT_LOCALE for multi-tenant / franchise
 * support. Falls back to 'en-CA'.
 *
 * @param {string} dateStr - ISO date string to format
 * @param {Object} [options] - Intl.DateTimeFormat options (default: year/month-short/day)
 * @returns {string} Formatted date string, or '-' on falsy/invalid input
 */

/* eslint-disable no-unused-vars */

// LOGIC CHANGE: Read locale from merchant global with fallback (OSS locale)
function _getDateLocale() {
  return (typeof window !== 'undefined' && window.MERCHANT_LOCALE) || 'en-CA';
}

function formatDate(dateStr, options) {
  if (!dateStr) return '-';
  try {
    var date = new Date(dateStr);
    var opts = options || { year: 'numeric', month: 'short', day: 'numeric' };
    return date.toLocaleDateString(_getDateLocale(), opts);
  } catch (error) {
    return '-';
  }
}

/**
 * Format a date+time string (e.g. "2026-03-15T10:30:00Z" → "Mar 15, 2026, 10:30 AM").
 * BACKLOG-26: Extracted from 10+ inline new Date().toLocaleString() calls.
 *
 * @param {string} dateStr - ISO date string to format
 * @param {Object} [options] - Intl.DateTimeFormat options
 * @returns {string} Formatted date+time string, or '-' on falsy/invalid input
 */
function formatDateTime(dateStr, options) {
  if (!dateStr) return '-';
  try {
    var date = new Date(dateStr);
    var opts = options || { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return date.toLocaleString(_getDateLocale(), opts);
  } catch (error) {
    return '-';
  }
}
