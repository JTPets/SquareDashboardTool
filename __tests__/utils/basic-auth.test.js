const { parseBasicAuth } = require('../../utils/basic-auth');

function makeReq(authHeader) {
    return { headers: authHeader ? { authorization: authHeader } : {} };
}

function b64(str) {
    return Buffer.from(str).toString('base64');
}

describe('parseBasicAuth', () => {
    it('returns null when Authorization header is absent', () => {
        expect(parseBasicAuth(makeReq(null))).toBeNull();
    });

    it('returns null for non-Basic scheme (Bearer)', () => {
        expect(parseBasicAuth(makeReq('Bearer some-token'))).toBeNull();
    });

    it('parses valid Basic header', () => {
        const result = parseBasicAuth(makeReq(`Basic ${b64('user:secret')}`));
        expect(result).toEqual({ username: 'user', password: 'secret' });
    });

    it('handles empty username (GMC-style: just :token)', () => {
        const result = parseBasicAuth(makeReq(`Basic ${b64(':my-feed-token')}`));
        expect(result).toEqual({ username: '', password: 'my-feed-token' });
    });

    it('handles password containing colons', () => {
        const result = parseBasicAuth(makeReq(`Basic ${b64('user:pass:with:colons')}`));
        expect(result).toEqual({ username: 'user', password: 'pass:with:colons' });
    });

    it('returns null when decoded string has no colon', () => {
        const noColon = Buffer.from('nocohereseparator').toString('base64');
        expect(parseBasicAuth(makeReq(`Basic ${noColon}`))).toBeNull();
    });

    it('returns null for malformed base64', () => {
        expect(parseBasicAuth(makeReq('Basic !!notbase64!!'))).toBeNull();
    });

    it('returns empty password string (not null) for "user:"', () => {
        const result = parseBasicAuth(makeReq(`Basic ${b64('user:')}`));
        expect(result).toEqual({ username: 'user', password: '' });
    });
});
