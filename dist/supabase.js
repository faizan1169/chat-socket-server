"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabaseAdmin = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const ws_1 = __importDefault(require("ws"));
const env_js_1 = require("./env.js");
exports.supabaseAdmin = (0, supabase_js_1.createClient)(env_js_1.env.supabaseUrl, env_js_1.env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    global: { headers: { 'x-client-info': 'nexchat-socket-server' } },
    realtime: { transport: ws_1.default },
});
//# sourceMappingURL=supabase.js.map