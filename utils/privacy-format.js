/**
 * Privacy-Aware Formatting Utilities
 *
 * Shared formatting functions for reports that need to display customer
 * information in a privacy-conscious way (for brand representatives, vendors, etc.)
 *
 * Also includes standardized date formatting for consistent report output.
 */

// ============================================================================
// PRIVACY-AWARE CUSTOMER FORMATTING
// ============================================================================

/**
 * Format customer name as "First L."
 * @param {string} givenName - First name
 * @param {string} familyName - Last name
 * @returns {string} Formatted name
 */
function formatPrivacyName(givenName, familyName) {
    const first = givenName ? givenName.trim() : '';
    const lastInitial = familyName ? familyName.trim().charAt(0).toUpperCase() + '.' : '';

    if (first && lastInitial) {
        return `${first} ${lastInitial}`;
    } else if (first) {
        return first;
    }
    return 'Customer';
}

/**
 * Format phone number as "***-XXXX" (last 4 digits)
 * @param {string} phone - Full phone number
 * @returns {string|null} Masked phone or null if not available
 */
function formatPrivacyPhone(phone) {
    if (!phone) return null;

    // Extract digits only
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return '***-****';

    const last4 = digits.slice(-4);
    return `***-${last4}`;
}

/**
 * Format email as "user@d..." (truncated domain)
 * @param {string} email - Full email
 * @returns {string|null} Truncated email or null if not available
 */
function formatPrivacyEmail(email) {
    if (!email) return null;

    const atIndex = email.indexOf('@');
    if (atIndex === -1) return email.slice(0, 8) + '...';

    const localPart = email.slice(0, atIndex);
    const domain = email.slice(atIndex + 1);
    const domainTrunc = domain.length > 2 ? domain.slice(0, 1) + '...' : domain;

    return `${localPart}@${domainTrunc}`;
}

// ============================================================================
// DATE FORMATTING
// ============================================================================

/**
 * Format date for reports (standardized: "Jan 30, 2026, 02:30 PM")
 * @param {Date|string} date - Date to format
 * @returns {string} Formatted date string or 'N/A' if not available
 */
function formatReportDate(date) {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Format date without time (standardized: "Jan 30, 2026")
 * @param {Date|string} date - Date to format
 * @returns {string} Formatted date string or 'N/A' if not available
 */
function formatReportDateOnly(date) {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

// ============================================================================
// CURRENCY FORMATTING
// ============================================================================

/**
 * Format cents as dollars (e.g., 1699 -> "$16.99")
 * @param {number} cents - Amount in cents
 * @returns {string} Formatted currency string or 'N/A' if not available
 */
function formatCents(cents) {
    if (cents === null || cents === undefined) return 'N/A';
    return `$${(cents / 100).toFixed(2)}`;
}

module.exports = {
    // Privacy formatting
    formatPrivacyName,
    formatPrivacyPhone,
    formatPrivacyEmail,

    // Date formatting
    formatReportDate,
    formatReportDateOnly,

    // Currency formatting
    formatCents
};
