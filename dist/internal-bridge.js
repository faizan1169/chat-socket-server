"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInternalRequest = handleInternalRequest;
const env_js_1 = require("./env.js");
const handlers_js_1 = require("./handlers.js");
function timingSafeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let result = 0;
    for (let i = 0; i < a.length; i++)
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return result === 0;
}
function authorize(req) {
    const header = req.headers['x-internal-secret'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided)
        return false;
    return timingSafeEqual(provided, env_js_1.env.internalSecret);
}
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (c) => {
            chunks.push(c);
            total += c.length;
            if (total > 1_000_000) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (chunks.length === 0)
                return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
function send(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}
/**
 * Returns true if the request was an internal-bridge request (and was
 * handled here). The caller should pass the request through to Socket.IO
 * normally if this returns false.
 */
async function handleInternalRequest(req, res, io) {
    const url = req.url || '';
    if (!url.startsWith('/internal/'))
        return false;
    if (!authorize(req)) {
        send(res, 401, { error: 'unauthorized' });
        return true;
    }
    // POST /internal/emit  { username, event, payload }
    if (url === '/internal/emit' && req.method === 'POST') {
        try {
            const body = await readJson(req);
            const { username, event, payload } = body || {};
            if (typeof username !== 'string' || typeof event !== 'string') {
                send(res, 400, { error: 'username and event are required strings' });
                return true;
            }
            io.to((0, handlers_js_1.USER_ROOM)(username.trim())).emit(event, payload);
            send(res, 200, { ok: true });
        }
        catch (err) {
            send(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
        }
        return true;
    }
    // GET /internal/online?username=foo  →  { online: bool }
    if (url.startsWith('/internal/online') && req.method === 'GET') {
        const u = new URL(url, 'http://localhost').searchParams.get('username');
        if (!u) {
            send(res, 400, { error: 'username query param required' });
            return true;
        }
        send(res, 200, { online: (0, handlers_js_1.isUserConnected)(u.trim()) });
        return true;
    }
    send(res, 404, { error: 'not found' });
    return true;
}
//# sourceMappingURL=internal-bridge.js.map