/**
 * Async Handler Middleware
 *
 * Wraps async route handlers to automatically catch errors and pass them
 * to Express's error handling middleware. This eliminates the need for
 * try/catch blocks in every route handler.
 *
 * Usage:
 *   const asyncHandler = require('../middleware/async-handler');
 *   router.get('/endpoint', asyncHandler(async (req, res) => {
 *       // async code - errors automatically caught
 *   }));
 */

/**
 * Wraps an async function to catch any errors and pass them to next()
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped function that catches errors
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
