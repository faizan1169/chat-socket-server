/**
 * NexChat standalone socket server.
 *
 * Boots a Node HTTP server, attaches a Socket.IO instance, registers all
 * chat/WebRTC event handlers, and exposes an authenticated `/internal/*`
 * HTTP bridge for the Next.js app to broadcast events.
 */
import { createServer } from 'http';
import { Server as ServerIO } from 'socket.io';
import { env, isProd } from './env.js';
import { registerHandlers } from './handlers.js';
import { handleInternalRequest } from './internal-bridge.js';

const httpServer = createServer();

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
    const handled = await handleInternalRequest(req, res, io);
    if (handled) return;
  } catch (err) {
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

const corsOrigin =
  isProd
    ? env.allowedOrigins.length > 0
      ? env.allowedOrigins
      : false
    : true;

const io = new ServerIO(httpServer, {
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

registerHandlers(io);

httpServer.listen(env.port, () => {
  console.log(`[socket-server] listening on :${env.port}`);
  console.log(`[socket-server] env=${env.nodeEnv}, allowedOrigins=${
    env.allowedOrigins.length ? env.allowedOrigins.join(',') : '(open in dev)'
  }`);
});

const shutdown = (signal: string) => {
  console.log(`[socket-server] received ${signal}, closing…`);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Force exit if shutdown hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
