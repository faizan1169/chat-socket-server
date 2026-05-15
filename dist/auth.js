"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateSocket = authenticateSocket;
exports.socketRateLimit = socketRateLimit;
const tokens_js_1 = require("./tokens.js");
const cookies_js_1 = require("./cookies.js");
const supabase_js_1 = require("./supabase.js");
const role_types_js_1 = require("./role-types.js");
function tokenFromHandshake(socket) {
    const headerAuth = socket.handshake.headers.authorization;
    if (typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')) {
        return headerAuth.slice(7);
    }
    const tokenFromAuth = socket.handshake.auth?.token;
    if (typeof tokenFromAuth === 'string' && tokenFromAuth.length > 0) {
        return tokenFromAuth;
    }
    const cookieHeader = socket.handshake.headers.cookie;
    if (cookieHeader) {
        const cookies = (0, cookies_js_1.parseCookieHeader)(cookieHeader);
        const t = cookies[cookies_js_1.COOKIE_ACCESS];
        if (t)
            return t;
    }
    return null;
}
async function authenticateSocket(socket) {
    const token = tokenFromHandshake(socket);
    if (!token)
        return null;
    let payload;
    try {
        payload = await (0, tokens_js_1.verifyAccessToken)(token);
    }
    catch {
        return null;
    }
    const { data: user } = await supabase_js_1.supabaseAdmin
        .from('users')
        .select('id, username, role, is_disabled')
        .eq('id', payload.sub)
        .maybeSingle();
    if (!user || user.is_disabled)
        return null;
    return {
        userId: user.id,
        username: user.username,
        role: await (0, role_types_js_1.getRoleNameFromId)(user.role),
    };
}
const socketBuckets = new Map();
function socketRateLimit(socketId, scope, limit, windowMs) {
    const key = `${scope}:${socketId}`;
    const now = Date.now();
    const existing = socketBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
        socketBuckets.set(key, { count: 1, resetAt: now + windowMs });
        if (socketBuckets.size > 10000) {
            socketBuckets.forEach((b, k) => {
                if (b.resetAt <= now)
                    socketBuckets.delete(k);
            });
        }
        return true;
    }
    if (existing.count >= limit)
        return false;
    existing.count += 1;
    return true;
}
//# sourceMappingURL=auth.js.map