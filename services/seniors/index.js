/**
 * Seniors Discount Service Layer
 *
 * Public API for the seniors discount service module. This module provides:
 * - Age-based discount eligibility management
 * - Square customer group management for seniors (60+)
 * - Catalog discount and pricing rule management
 * - Birthday update handling from webhooks
 *
 * Usage:
 *   const { SeniorsService } = require('./services/seniors');
 *
 *   const service = new SeniorsService(merchantId);
 *   await service.initialize();
 *   await service.setupSquareObjects();  // One-time setup
 *
 * For webhook handling:
 *   const result = await service.handleCustomerBirthdayUpdate({
 *       squareCustomerId: 'CUSTOMER_ID',
 *       birthday: '1960-05-15'
 *   });
 *
 * For age calculations:
 *   const { calculateAge, isSenior } = require('./services/seniors');
 *   const age = calculateAge('1960-05-15');  // 65
 *   const eligible = isSenior('1960-05-15'); // true
 */

// Main service
const { SeniorsService } = require('./seniors-service');

// Age calculation utilities
const {
    calculateAge,
    isSenior,
    parseBirthday,
    formatBirthday,
    getNextBirthday,
} = require('./age-calculator');

module.exports = {
    // Main service (recommended entry point)
    SeniorsService,

    // Age utilities
    calculateAge,
    isSenior,
    parseBirthday,
    formatBirthday,
    getNextBirthday,
};
