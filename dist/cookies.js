"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COOKIE_ACCESS = void 0;
exports.parseCookieHeader = parseCookieHeader;
exports.COOKIE_ACCESS = 'access_token';
function parseCookieHeader(header) {
    if (!header)
        return {};
    const out = {};
    for (const part of header.split('; ')) {
        const idx = part.indexOf('=');
        if (idx === -1)
            continue;
        out[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
    }
    return out;
}
//# sourceMappingURL=cookies.js.map