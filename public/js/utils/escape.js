/**
 * Shared HTML/attribute escaping utilities.
 * Loaded globally before page-specific scripts.
 *
 * escapeHtml  — DOM-based, handles all HTML entities (most defensive variant)
 * escapeAttr  — regex-based, escapes &, ", ', <, > for safe HTML attribute values
 * escapeHtmlAttr — alias for escapeAttr (backward compat with expiry.js)
 */

/* eslint-disable no-unused-vars */

/**
 * Escape HTML entities to prevent XSS.
 * Uses DOM textContent→innerHTML for complete entity coverage.
 * Handles falsy values including 0.
 * @param {*} text - Value to escape (coerced to string)
 * @returns {string} Escaped HTML string
 */
function escapeHtml(text) {
  if (!text && text !== 0) return '';
  var div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * Escape a string for safe use in HTML attribute values.
 * Covers &, ", ', <, > (the 5 entities that matter in attributes).
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Alias for backward compatibility (used in expiry.js)
var escapeHtmlAttr = escapeAttr;
