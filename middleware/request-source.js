'use strict';

/**
 * Request Source Middleware
 *
 * Attaches req.isAutomated to every request to distinguish automated callers
 * (cron jobs, agent-generated POs, SMS/email triggers) from human sessions.
 *
 * Detection: presence of header  x-request-source: automation
 * Default:   false (human)
 *
 * See docs/AUTOMATION-PATTERNS.md for full usage guide.
 */

function requestSource(req, res, next) {
    req.isAutomated = req.headers['x-request-source'] === 'automation';
    next();
}

module.exports = requestSource;
