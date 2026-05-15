"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isProd = exports.env = void 0;
function required(name) {
    const v = process.env[name];
    if (!v || v.trim() === '') {
        throw new Error(`${name} environment variable is required`);
    }
    return v;
}
function optional(name, fallback = '') {
    return process.env[name]?.trim() || fallback;
}
exports.env = {
    port: Number(optional('PORT', '3001')),
    jwtSecret: required('JWT_SECRET'),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    internalSecret: required('INTERNAL_API_SECRET'),
    allowedOrigins: optional('ALLOWED_ORIGINS')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    nodeEnv: optional('NODE_ENV', 'development'),
};
exports.isProd = exports.env.nodeEnv === 'production';
//# sourceMappingURL=env.js.map