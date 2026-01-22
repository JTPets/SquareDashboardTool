/**
 * Unit tests for loyalty-tracer.js
 */

const {
  LoyaltyTracer,
  getTracer,
  cleanupTracer,
  generateTraceId,
} = require('../loyalty-tracer');

describe('LoyaltyTracer', () => {
  describe('generateTraceId', () => {
    test('generates unique UUIDs', () => {
      const id1 = generateTraceId();
      const id2 = generateTraceId();

      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(id1).not.toBe(id2);
    });
  });

  describe('constructor', () => {
    test('creates inactive tracer', () => {
      const tracer = new LoyaltyTracer();

      expect(tracer.isTraceActive()).toBe(false);
      expect(tracer.getTraceId()).toBeNull();
    });
  });

  describe('startTrace', () => {
    test('starts a new trace with context', () => {
      const tracer = new LoyaltyTracer();
      const traceId = tracer.startTrace({
        orderId: 'order-123',
        merchantId: 456,
      });

      expect(traceId).toBeTruthy();
      expect(tracer.isTraceActive()).toBe(true);
      expect(tracer.getTraceId()).toBe(traceId);
    });

    test('trace ID is a valid UUID', () => {
      const tracer = new LoyaltyTracer();
      const traceId = tracer.startTrace();

      expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  describe('span', () => {
    test('adds spans to active trace', () => {
      const tracer = new LoyaltyTracer();
      tracer.startTrace({ orderId: 'order-123' });

      tracer.span('CUSTOMER_IDENTIFIED', { method: 'ORDER_CUSTOMER_ID' });
      tracer.span('PURCHASE_RECORDED', { variationId: 'var-456' });

      const spans = tracer.getSpans();
      expect(spans).toHaveLength(2);
      expect(spans[0].name).toBe('CUSTOMER_IDENTIFIED');
      expect(spans[0].method).toBe('ORDER_CUSTOMER_ID');
      expect(spans[1].name).toBe('PURCHASE_RECORDED');
      expect(spans[1].variationId).toBe('var-456');
    });

    test('span includes timestamp and elapsed time', () => {
      const tracer = new LoyaltyTracer();
      tracer.startTrace();

      tracer.span('TEST_SPAN');

      const spans = tracer.getSpans();
      expect(spans[0].timestamp).toBeTruthy();
      expect(typeof spans[0].elapsed).toBe('number');
      expect(spans[0].elapsed).toBeGreaterThanOrEqual(0);
    });

    test('ignores spans when trace not active', () => {
      const tracer = new LoyaltyTracer();

      tracer.span('SHOULD_BE_IGNORED');

      expect(tracer.getSpans()).toHaveLength(0);
    });
  });

  describe('endTrace', () => {
    test('returns complete trace object', () => {
      const tracer = new LoyaltyTracer();
      const traceId = tracer.startTrace({
        orderId: 'order-123',
        merchantId: 456,
      });

      tracer.span('OPERATION_1');
      tracer.span('OPERATION_2');

      const trace = tracer.endTrace();

      expect(trace.id).toBe(traceId);
      expect(trace.duration).toBeGreaterThanOrEqual(0);
      expect(trace.startedAt).toBeTruthy();
      expect(trace.endedAt).toBeTruthy();
      expect(trace.context.orderId).toBe('order-123');
      expect(trace.context.merchantId).toBe(456);
      expect(trace.spans).toHaveLength(2);
      expect(trace.spanCount).toBe(2);
    });

    test('marks trace as inactive', () => {
      const tracer = new LoyaltyTracer();
      tracer.startTrace();

      expect(tracer.isTraceActive()).toBe(true);

      tracer.endTrace();

      expect(tracer.isTraceActive()).toBe(false);
      expect(tracer.getTraceId()).toBeNull();
    });

    test('returns empty trace when not active', () => {
      const tracer = new LoyaltyTracer();

      const trace = tracer.endTrace();

      expect(trace.id).toBeNull();
      expect(trace.duration).toBe(0);
      expect(trace.spans).toHaveLength(0);
    });
  });

  describe('getElapsedTime', () => {
    test('returns elapsed time during active trace', async () => {
      const tracer = new LoyaltyTracer();
      tracer.startTrace();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      const elapsed = tracer.getElapsedTime();
      expect(elapsed).toBeGreaterThanOrEqual(10);
    });

    test('returns 0 when trace not active', () => {
      const tracer = new LoyaltyTracer();

      expect(tracer.getElapsedTime()).toBe(0);
    });
  });
});

describe('getTracer and cleanupTracer', () => {
  afterEach(() => {
    cleanupTracer('test-key');
  });

  test('getTracer returns same instance for same key', () => {
    const tracer1 = getTracer('test-key');
    const tracer2 = getTracer('test-key');

    expect(tracer1).toBe(tracer2);
  });

  test('getTracer returns different instances for different keys', () => {
    const tracer1 = getTracer('key-1');
    const tracer2 = getTracer('key-2');

    expect(tracer1).not.toBe(tracer2);

    // Cleanup
    cleanupTracer('key-1');
    cleanupTracer('key-2');
  });

  test('cleanupTracer removes tracer from store', () => {
    const tracer1 = getTracer('test-key');
    cleanupTracer('test-key');
    const tracer2 = getTracer('test-key');

    expect(tracer1).not.toBe(tracer2);
  });
});

describe('Full trace lifecycle', () => {
  test('complete order processing trace', () => {
    const tracer = new LoyaltyTracer();

    // Start trace
    const traceId = tracer.startTrace({
      orderId: 'ORDER-001',
      merchantId: 123,
      source: 'WEBHOOK',
    });

    // Simulate order processing
    tracer.span('CUSTOMER_LOOKUP_START');
    tracer.span('CUSTOMER_IDENTIFIED', {
      method: 'ORDER_CUSTOMER_ID',
      customerId: 'CUST-456',
    });
    tracer.span('LINE_ITEM_PROCESSED', {
      variationId: 'VAR-001',
      quantity: 2,
      decision: 'QUALIFIES',
    });
    tracer.span('LINE_ITEM_PROCESSED', {
      variationId: 'VAR-002',
      quantity: 1,
      decision: 'SKIP_FREE',
    });
    tracer.span('PURCHASE_RECORDED', {
      offerId: 789,
      newProgress: 5,
    });
    tracer.span('REWARD_EARNED', {
      rewardId: 101,
    });

    // End trace
    const trace = tracer.endTrace();

    // Verify
    expect(trace.id).toBe(traceId);
    expect(trace.context.orderId).toBe('ORDER-001');
    expect(trace.context.source).toBe('WEBHOOK');
    expect(trace.spanCount).toBe(6);
    expect(trace.spans.map(s => s.name)).toEqual([
      'CUSTOMER_LOOKUP_START',
      'CUSTOMER_IDENTIFIED',
      'LINE_ITEM_PROCESSED',
      'LINE_ITEM_PROCESSED',
      'PURCHASE_RECORDED',
      'REWARD_EARNED',
    ]);
  });
});
