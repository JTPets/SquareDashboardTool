/**
 * Loyalty Service Layer
 *
 * Public API for the loyalty service module. This module provides:
 * - Order processing for loyalty programs
 * - Customer identification
 * - Offer management
 * - Purchase tracking
 * - Reward management
 *
 * Usage:
 *   const { LoyaltyWebhookService } = require('./services/loyalty');
 *
 *   const service = new LoyaltyWebhookService(merchantId);
 *   await service.initialize();
 *   const result = await service.processOrder(order);
 *
 * For debugging:
 *   const { LoyaltyTracer, loyaltyLogger } = require('./services/loyalty');
 */

// Main orchestration service
const { LoyaltyWebhookService } = require('./webhook-service');

// Individual services for direct access when needed
const { LoyaltySquareClient, SquareApiError } = require('./square-client');
const { LoyaltyCustomerService } = require('./customer-service');
const { LoyaltyOfferService } = require('./offer-service');
const { LoyaltyPurchaseService } = require('./purchase-service');
const { LoyaltyRewardService } = require('./reward-service');

// Logging and tracing utilities
const { loyaltyLogger } = require('./loyalty-logger');
const {
  LoyaltyTracer,
  getTracer,
  cleanupTracer,
  generateTraceId,
} = require('./loyalty-tracer');

module.exports = {
  // Main service (recommended entry point)
  LoyaltyWebhookService,

  // Individual services
  LoyaltySquareClient,
  LoyaltyCustomerService,
  LoyaltyOfferService,
  LoyaltyPurchaseService,
  LoyaltyRewardService,

  // Errors
  SquareApiError,

  // Logging and tracing
  loyaltyLogger,
  LoyaltyTracer,
  getTracer,
  cleanupTracer,
  generateTraceId,
};
