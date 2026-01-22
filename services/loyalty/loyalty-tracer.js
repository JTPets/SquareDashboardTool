/**
 * Loyalty Service Correlation ID Tracking
 *
 * Provides trace IDs that flow through the entire order processing pipeline
 * for debugging "what happened to this order?" questions.
 *
 * Usage:
 *   const tracer = new LoyaltyTracer();
 *   const traceId = tracer.startTrace({ orderId: 'xyz', merchantId: 123 });
 *   tracer.span('CUSTOMER_IDENTIFIED', { method: 'ORDER_CUSTOMER_ID' });
 *   tracer.span('PURCHASE_RECORDED', { variationId: 'abc' });
 *   const trace = tracer.endTrace();
 *   // trace.id can be used to query all related logs
 */

const crypto = require('crypto');

// Global WeakMap to store tracer instances by context
const tracerInstances = new WeakMap();

/**
 * Generate a unique trace ID using UUID v4
 * @returns {string} UUID v4 string
 */
function generateTraceId() {
  return crypto.randomUUID();
}

/**
 * LoyaltyTracer class for tracking operations through the loyalty pipeline
 */
class LoyaltyTracer {
  constructor() {
    this.traceId = null;
    this.startTime = null;
    this.endTime = null;
    this.context = {};
    this.spans = [];
    this.isActive = false;
  }

  /**
   * Start a new trace
   * @param {Object} context - Initial context for the trace
   * @param {string} [context.orderId] - Square order ID
   * @param {number} [context.merchantId] - Internal merchant ID
   * @param {string} [context.source] - Source of the trace (e.g., 'WEBHOOK', 'BACKFILL', 'MANUAL')
   * @returns {string} The trace ID
   */
  startTrace(context = {}) {
    this.traceId = generateTraceId();
    this.startTime = Date.now();
    this.context = {
      ...context,
      startedAt: new Date().toISOString(),
    };
    this.spans = [];
    this.isActive = true;

    return this.traceId;
  }

  /**
   * Add a span (operation) to the current trace
   * @param {string} name - Name of the operation
   * @param {Object} [data] - Additional data for this span
   */
  span(name, data = {}) {
    if (!this.isActive) {
      return; // Silently ignore if trace not started
    }

    this.spans.push({
      name,
      timestamp: new Date().toISOString(),
      elapsed: Date.now() - this.startTime,
      ...data,
    });
  }

  /**
   * End the current trace and return the complete trace object
   * @returns {Object} Complete trace with all spans and timing
   */
  endTrace() {
    if (!this.isActive) {
      return {
        id: null,
        duration: 0,
        spans: [],
        context: {},
      };
    }

    this.endTime = Date.now();
    this.isActive = false;

    return {
      id: this.traceId,
      duration: this.endTime - this.startTime,
      startedAt: this.context.startedAt,
      endedAt: new Date().toISOString(),
      context: this.context,
      spans: this.spans,
      spanCount: this.spans.length,
    };
  }

  /**
   * Get the current trace ID
   * @returns {string|null} The trace ID or null if not active
   */
  getTraceId() {
    return this.isActive ? this.traceId : null;
  }

  /**
   * Check if trace is active
   * @returns {boolean} True if trace is active
   */
  isTraceActive() {
    return this.isActive;
  }

  /**
   * Get current spans
   * @returns {Array} Array of spans
   */
  getSpans() {
    return [...this.spans];
  }

  /**
   * Get elapsed time since trace started
   * @returns {number} Elapsed time in milliseconds, or 0 if not active
   */
  getElapsedTime() {
    if (!this.isActive) {
      return 0;
    }
    return Date.now() - this.startTime;
  }
}

// Thread-local-like storage using a Map with request ID as key
const traceStore = new Map();

/**
 * Get or create a tracer for the given context key
 * Useful for async/await chains where you need to maintain trace context
 * @param {string} contextKey - Unique key for this trace context (e.g., orderId)
 * @returns {LoyaltyTracer} The tracer instance
 */
function getTracer(contextKey) {
  if (!traceStore.has(contextKey)) {
    traceStore.set(contextKey, new LoyaltyTracer());
  }
  return traceStore.get(contextKey);
}

/**
 * Clean up a tracer from the store
 * @param {string} contextKey - The context key to remove
 */
function cleanupTracer(contextKey) {
  traceStore.delete(contextKey);
}

module.exports = {
  LoyaltyTracer,
  getTracer,
  cleanupTracer,
  generateTraceId,
};
