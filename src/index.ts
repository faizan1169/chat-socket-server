
import { createServer } from 'http';
import { Server as ServerIO } from 'socket.io';
import { env, isProd } from './env.js';
import { registerHandlers } from './handlers.js';
import { handleInternalRequest } from './internal-bridge.js';

const httpServer = createServer();

httpServer.on('request', async (req, res) => {

  if (req.url === '/healthz' || req.url === '/') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
    return;
  }

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
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
