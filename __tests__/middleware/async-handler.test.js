/**
 * Tests for async-handler middleware
 */

const asyncHandler = require('../../middleware/async-handler');

describe('asyncHandler', () => {
    let mockReq, mockRes, mockNext;

    beforeEach(() => {
        mockReq = {};
        mockRes = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };
        mockNext = jest.fn();
    });

    it('should call the wrapped function with req, res, next', async () => {
        const handler = jest.fn().mockResolvedValue();
        const wrapped = asyncHandler(handler);

        await wrapped(mockReq, mockRes, mockNext);

        expect(handler).toHaveBeenCalledWith(mockReq, mockRes, mockNext);
    });

    it('should pass through successful responses', async () => {
        const handler = jest.fn().mockImplementation(async (req, res) => {
            res.json({ success: true });
        });
        const wrapped = asyncHandler(handler);

        await wrapped(mockReq, mockRes, mockNext);

        expect(mockRes.json).toHaveBeenCalledWith({ success: true });
        expect(mockNext).not.toHaveBeenCalled();
    });

    it('should catch errors and pass them to next()', async () => {
        const testError = new Error('Test error');
        const handler = jest.fn().mockRejectedValue(testError);
        const wrapped = asyncHandler(handler);

        await wrapped(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalledWith(testError);
    });

    it('should catch synchronous errors thrown in async handlers', async () => {
        const testError = new Error('Sync error in async');
        const handler = jest.fn().mockImplementation(async () => {
            throw testError;
        });
        const wrapped = asyncHandler(handler);

        await wrapped(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalledWith(testError);
    });

    it('should work with handlers that return values', async () => {
        const handler = jest.fn().mockResolvedValue('result');
        const wrapped = asyncHandler(handler);

        await wrapped(mockReq, mockRes, mockNext);

        expect(mockNext).not.toHaveBeenCalled();
    });
});
