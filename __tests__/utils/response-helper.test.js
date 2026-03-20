/**
 * Response Helper Test Suite (BACKLOG-3)
 *
 * Tests for sendSuccess, sendError, sendPaginated utilities.
 */

const { sendSuccess, sendError, sendPaginated, ErrorCodes } = require('../../utils/response-helper');

function createMockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(data) {
            res.body = data;
            return res;
        },
    };
    return res;
}

describe('Response Helper', () => {
    describe('sendSuccess', () => {
        it('should flat-merge object data with success: true', () => {
            const res = createMockRes();
            sendSuccess(res, { items: [1, 2], count: 2 });

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ success: true, items: [1, 2], count: 2 });
        });

        it('should wrap array data in { success: true, data }', () => {
            const res = createMockRes();
            sendSuccess(res, [1, 2, 3]);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ success: true, data: [1, 2, 3] });
        });

        it('should wrap primitive data in { success: true, data }', () => {
            const res = createMockRes();
            sendSuccess(res, 'hello');

            expect(res.body).toEqual({ success: true, data: 'hello' });
        });

        it('should wrap null in { success: true, data: null }', () => {
            const res = createMockRes();
            sendSuccess(res, null);

            expect(res.body).toEqual({ success: true, data: null });
        });

        it('should accept custom status code', () => {
            const res = createMockRes();
            sendSuccess(res, { id: 1 }, 201);

            expect(res.statusCode).toBe(201);
            expect(res.body).toEqual({ success: true, id: 1 });
        });

        it('should not double-wrap objects that already have success: true', () => {
            const res = createMockRes();
            sendSuccess(res, { merchants: [{ id: 1 }] });

            expect(res.body.success).toBe(true);
            expect(res.body.merchants).toEqual([{ id: 1 }]);
            expect(res.body.data).toBeUndefined();
        });

        it('should handle empty object', () => {
            const res = createMockRes();
            sendSuccess(res, {});

            expect(res.body).toEqual({ success: true });
        });
    });

    describe('sendError', () => {
        it('should send error with default 400 status', () => {
            const res = createMockRes();
            sendError(res, 'Bad request');

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Bad request' });
        });

        it('should send error with custom status code', () => {
            const res = createMockRes();
            sendError(res, 'Not found', 404);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ success: false, error: 'Not found' });
        });

        it('should include error code when provided', () => {
            const res = createMockRes();
            sendError(res, 'Unauthorized', 401, 'UNAUTHORIZED');

            expect(res.body).toEqual({
                success: false,
                error: 'Unauthorized',
                code: 'UNAUTHORIZED',
            });
        });

        it('should not include code when null', () => {
            const res = createMockRes();
            sendError(res, 'Error', 500);

            expect(res.body.code).toBeUndefined();
        });
    });

    describe('sendPaginated', () => {
        it('should send paginated response with flat merge', () => {
            const res = createMockRes();
            sendPaginated(res, { items: [1, 2], total: 10, limit: 2, offset: 0 });

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                success: true,
                items: [1, 2],
                total: 10,
                limit: 2,
                offset: 0,
            });
        });

        it('should accept custom status code', () => {
            const res = createMockRes();
            sendPaginated(res, { items: [], total: 0 }, 200);

            expect(res.body).toEqual({ success: true, items: [], total: 0 });
        });
    });

    describe('ErrorCodes', () => {
        it('should export standard error codes', () => {
            expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
            expect(ErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
            expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED');
            expect(ErrorCodes.FORBIDDEN).toBe('FORBIDDEN');
            expect(ErrorCodes.CONFLICT).toBe('CONFLICT');
            expect(ErrorCodes.EXTERNAL_API_ERROR).toBe('EXTERNAL_API_ERROR');
            expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
        });
    });
});
