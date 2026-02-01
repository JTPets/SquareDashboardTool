/**
 * Age Calculator Utilities
 *
 * Pure functions for calculating age from birthday.
 * Used by seniors discount service to determine eligibility.
 */

const { SENIORS_DISCOUNT } = require('../../config/constants');

/**
 * Calculate age from birthday
 * @param {string|Date} birthday - Birthday in YYYY-MM-DD format or Date object
 * @param {Date} [asOfDate] - Calculate age as of this date (defaults to today)
 * @returns {number|null} Age in years, or null if birthday is invalid
 */
function calculateAge(birthday, asOfDate = new Date()) {
    if (!birthday) {
        return null;
    }

    const birthDate = birthday instanceof Date ? birthday : new Date(birthday);

    if (isNaN(birthDate.getTime())) {
        return null;
    }

    let age = asOfDate.getFullYear() - birthDate.getFullYear();
    const monthDiff = asOfDate.getMonth() - birthDate.getMonth();

    // Adjust if birthday hasn't occurred this year yet
    if (monthDiff < 0 || (monthDiff === 0 && asOfDate.getDate() < birthDate.getDate())) {
        age--;
    }

    return age;
}

/**
 * Check if a customer is a senior (60+ by default)
 * @param {string|Date} birthday - Birthday in YYYY-MM-DD format or Date object
 * @param {number} [minAge] - Minimum age for senior status (defaults to config)
 * @param {Date} [asOfDate] - Check as of this date (defaults to today)
 * @returns {boolean} True if customer is a senior
 */
function isSenior(birthday, minAge = SENIORS_DISCOUNT.MIN_AGE, asOfDate = new Date()) {
    const age = calculateAge(birthday, asOfDate);
    return age !== null && age >= minAge;
}

/**
 * Parse a birthday string to Date object
 * @param {string} birthdayStr - Birthday in YYYY-MM-DD format
 * @returns {Date|null} Date object or null if invalid
 */
function parseBirthday(birthdayStr) {
    if (!birthdayStr || typeof birthdayStr !== 'string') {
        return null;
    }

    // Square provides birthday in YYYY-MM-DD format
    const match = birthdayStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }

    const date = new Date(birthdayStr);
    if (isNaN(date.getTime())) {
        return null;
    }

    return date;
}

/**
 * Format a Date object to YYYY-MM-DD string
 * @param {Date} date - Date to format
 * @returns {string|null} Formatted date string or null if invalid
 */
function formatBirthday(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
        return null;
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

/**
 * Get next birthday for a customer
 * @param {string|Date} birthday - Customer's birthday
 * @returns {Date|null} Next birthday date or null if invalid
 */
function getNextBirthday(birthday) {
    const birthDate = birthday instanceof Date ? birthday : parseBirthday(birthday);
    if (!birthDate) {
        return null;
    }

    const today = new Date();
    const thisYear = today.getFullYear();

    // Birthday this year
    const thisYearBirthday = new Date(thisYear, birthDate.getMonth(), birthDate.getDate());

    // If birthday has passed this year, return next year's
    if (thisYearBirthday <= today) {
        return new Date(thisYear + 1, birthDate.getMonth(), birthDate.getDate());
    }

    return thisYearBirthday;
}

module.exports = {
    calculateAge,
    isSenior,
    parseBirthday,
    formatBirthday,
    getNextBirthday,
};
