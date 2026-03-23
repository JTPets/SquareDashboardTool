'use strict';

/**
 * Escape special characters for PostgreSQL LIKE/ILIKE patterns.
 *
 * The characters %, _, and \ have special meaning inside LIKE patterns.
 * This function escapes them so user input is treated as literal text.
 *
 * Usage:
 *   const safe = escapeLikePattern(userInput);
 *   db.query("SELECT * FROM t WHERE col ILIKE $1", [`%${safe}%`]);
 *
 * @param {string} input - Raw user input
 * @returns {string} Escaped string safe for LIKE patterns
 */
function escapeLikePattern(input) {
    if (typeof input !== 'string') return input;
    return input
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
}

module.exports = { escapeLikePattern };
