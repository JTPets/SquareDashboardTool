/**
 * HTTP Basic Auth parser utility
 *
 * Extracted from routes/gmc.js where it was duplicated across two TSV feed handlers.
 */

/**
 * Parse an HTTP Basic Auth Authorization header.
 * Returns { username, password } on success, or null if the header is absent,
 * not Basic scheme, or malformed.
 *
 * @param {import('express').Request} req
 * @returns {{ username: string, password: string } | null}
 */
function parseBasicAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) return null;
    try {
        const b64 = authHeader.split(' ')[1];
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx === -1) return null;
        return {
            username: decoded.slice(0, colonIdx),
            password: decoded.slice(colonIdx + 1)
        };
    } catch {
        return null;
    }
}

module.exports = { parseBasicAuth };
