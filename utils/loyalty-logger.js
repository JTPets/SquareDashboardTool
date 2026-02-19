/**
 * Loyalty Service Enhanced Logging
 *
 * Provides structured logging with consistent prefixes for:
 * - Purchase tracking
 * - Reward state changes
 * - Redemption events
 * - Square API calls
 * - Customer identification
 * - Debugging
 *
 * All logs include [LOYALTY:*] prefix for easy filtering in log aggregators.
 *
 * Relocated from services/loyalty/loyalty-logger.js (BACKLOG-31).
 */

const logger = require('./logger');

/**
 * Structured logging for loyalty service operations
 * Each method prefixes logs with a specific category for easy filtering
 */
const loyaltyLogger = {
  /**
   * Log purchase-related events
   * @param {Object} data - Log data including orderId, customerId, quantity, etc.
   */
  purchase: (data) => {
    logger.info('[LOYALTY:PURCHASE]', {
      category: 'LOYALTY:PURCHASE',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log reward state machine events (earned, in_progress, etc.)
   * @param {Object} data - Log data including rewardId, status, customerId, etc.
   */
  reward: (data) => {
    logger.info('[LOYALTY:REWARD]', {
      category: 'LOYALTY:REWARD',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log redemption events
   * @param {Object} data - Log data including rewardId, redemptionType, etc.
   */
  redemption: (data) => {
    logger.info('[LOYALTY:REDEMPTION]', {
      category: 'LOYALTY:REDEMPTION',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log Square API calls with timing information
   * @param {Object} data - Log data including endpoint, method, status, duration, etc.
   */
  squareApi: (data) => {
    logger.info('[LOYALTY:SQUARE_API]', {
      category: 'LOYALTY:SQUARE_API',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log customer identification events
   * @param {Object} data - Log data including orderId, method, success, customerId, etc.
   */
  customer: (data) => {
    logger.info('[LOYALTY:CUSTOMER]', {
      category: 'LOYALTY:CUSTOMER',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log error events with full context
   * @param {Object} data - Log data including error message, stack, context, etc.
   */
  error: (data) => {
    logger.error('[LOYALTY:ERROR]', {
      category: 'LOYALTY:ERROR',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log debug information (verbose logging for development)
   * @param {Object} data - Debug data
   */
  debug: (data) => {
    logger.debug('[LOYALTY:DEBUG]', {
      category: 'LOYALTY:DEBUG',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log audit trail events for compliance tracking
   * @param {Object} data - Audit data including action, userId, merchantId, etc.
   */
  audit: (data) => {
    logger.info('[LOYALTY:AUDIT]', {
      category: 'LOYALTY:AUDIT',
      ...data,
      timestamp: new Date().toISOString()
    });
  },

  /**
   * Log performance metrics (timing data)
   * @param {Object} data - Performance data including operation, duration, etc.
   */
  perf: (data) => {
    logger.info('[LOYALTY:PERF]', {
      category: 'LOYALTY:PERF',
      ...data,
      timestamp: new Date().toISOString()
    });
  }
};

module.exports = { loyaltyLogger };
