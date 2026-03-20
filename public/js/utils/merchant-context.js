/**
 * Merchant context globals for OSS / multi-tenant locale support.
 *
 * Sets window.MERCHANT_LOCALE and window.MERCHANT_CURRENCY which are read
 * by format-currency.js and date-format.js. Include this script BEFORE
 * those utilities in any page that needs merchant-aware formatting.
 *
 * Currently defaults to en-CA / CAD. When the merchant settings API is
 * available, this script should fetch and apply the merchant's locale.
 *
 * // TODO(pre-franchise): populate MERCHANT_LOCALE/CURRENCY from API
 * //   e.g. fetch('/api/merchants/me').then(m => {
 * //     window.MERCHANT_LOCALE = m.locale;
 * //     window.MERCHANT_CURRENCY = m.currency;
 * //   });
 */

/* eslint-disable no-unused-vars */

// LOGIC CHANGE: OSS locale — set merchant globals with safe defaults
window.MERCHANT_LOCALE = window.MERCHANT_LOCALE || 'en-CA';
window.MERCHANT_CURRENCY = window.MERCHANT_CURRENCY || 'CAD';
