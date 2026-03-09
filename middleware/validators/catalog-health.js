/**
 * Validators for catalog health admin routes
 */

const { handleValidationErrors } = require('./index');

const getHealth = [handleValidationErrors];
const runCheck = [handleValidationErrors];

module.exports = { getHealth, runCheck };
