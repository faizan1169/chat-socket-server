"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyAccessToken = verifyAccessToken;
const jose_1 = require("jose");
const env_js_1 = require("./env.js");
const accessSecret = new TextEncoder().encode(env_js_1.env.jwtSecret);
async function verifyAccessToken(token) {
    const { payload } = await (0, jose_1.jwtVerify)(token, accessSecret);
    if (payload.type !== 'access')
        throw new Error('Invalid token type');
    return payload;
}
//# sourceMappingURL=tokens.js.map