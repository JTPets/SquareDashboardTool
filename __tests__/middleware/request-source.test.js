'use strict';

/**
 * Request Source Middleware Tests
 *
 * Verifies that req.isAutomated is correctly set based on the
 * x-request-source header.
 */

const requestSource = require('../../middleware/request-source');

function mockReq(headers = {}) {
    return { headers };
}

describe('requestSource middleware', () => {
    test('sets req.isAutomated = false when x-request-source header is absent', () => {
        const req = mockReq();
        const next = jest.fn();
        requestSource(req, {}, next);
        expect(req.isAutomated).toBe(false);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('sets req.isAutomated = true when x-request-source is "automation"', () => {
        const req = mockReq({ 'x-request-source': 'automation' });
        const next = jest.fn();
        requestSource(req, {}, next);
        expect(req.isAutomated).toBe(true);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('sets req.isAutomated = false for any other x-request-source value', () => {
        const req = mockReq({ 'x-request-source': 'human' });
        const next = jest.fn();
        requestSource(req, {}, next);
        expect(req.isAutomated).toBe(false);
    });

    test('is case-sensitive — "Automation" does not trigger automated mode', () => {
        const req = mockReq({ 'x-request-source': 'Automation' });
        const next = jest.fn();
        requestSource(req, {}, next);
        expect(req.isAutomated).toBe(false);
    });

    test('always calls next()', () => {
        const req = mockReq({ 'x-request-source': 'automation' });
        const next = jest.fn();
        requestSource(req, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});
