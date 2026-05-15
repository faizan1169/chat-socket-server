"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * NexChat standalone socket server.
 *
 * Boots a Node HTTP server, attaches a Socket.IO instance, registers all
 * chat/WebRTC event handlers, and exposes an authenticated `/internal/*`
 * HTTP bridge for the Next.js app to broadcast events.
 */
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const env_js_1 = require("./env.js");
const handlers_js_1 = require("./handlers.js");
const internal_bridge_js_1 = require("./internal-bridge.js");
const httpServer = (0, http_1.createServer)();
httpServer.on('request', async (req, res) => {
    // Health check — useful for Railway/Fly probes.
    if (req.url === '/healthz' || req.url === '/') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('ok');
        return;
    }
    // Internal bridge — Next.js app pushes broadcasts here.
    try {
        const handled = await (0, internal_bridge_js_1.handleInternalRequest)(req, res, io);
        if (handled)
            return;
    }
    catch (err) {
        console.error('[internal] handler error', err);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.end('internal error');
        }
        return;
    }
    // Anything else (e.g. unknown HTTP path) → 404. Socket.IO traffic is
    // intercepted by the io instance via its own request listener attachment.
    res.statusCode = 404;
    res.end();
});
const corsOrigin = env_js_1.isProd
    ? env_js_1.env.allowedOrigins.length > 0
        ? env_js_1.env.allowedOrigins
        : false
    : true;
const io = new socket_io_1.Server(httpServer, {
    // Match the path the existing useSocket() client uses so no frontend
    // changes are needed beyond pointing NEXT_PUBLIC_SOCKET_URL at this host.
    path: '/api/socket',
    addTrailingSlash: false,
    cors: {
        origin: corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
    },
});
(0, handlers_js_1.registerHandlers)(io);
httpServer.listen(env_js_1.env.port, () => {
    console.log(`[socket-server] listening on :${env_js_1.env.port}`);
    console.log(`[socket-server] env=${env_js_1.env.nodeEnv}, allowedOrigins=${env_js_1.env.allowedOrigins.length ? env_js_1.env.allowedOrigins.join(',') : '(open in dev)'}`);
});
const shutdown = (signal) => {
    console.log(`[socket-server] received ${signal}, closing…`);
    io.close(() => {
        httpServer.close(() => process.exit(0));
    });
    // Force exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
//# sourceMappingURL=index.js.map