/**
 * Shared date formatting utility.
 * Loaded globally before page-specific scripts.
 *
 * @param {string} dateStr - ISO date string to format
 * @param {Object} [options] - Intl.DateTimeFormat options (default: year/month-short/day)
 * @returns {string} Formatted date string, or '-' on falsy/invalid input
 */

/* eslint-disable no-unused-vars */

function formatDate(dateStr, options) {
  if (!dateStr) return '-';
  try {
    var date = new Date(dateStr);
    var opts = options || { year: 'numeric', month: 'short', day: 'numeric' };
    return date.toLocaleDateString('en-US', opts);
  } catch (error) {
    return '-';
  }
}
