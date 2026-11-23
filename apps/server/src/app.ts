import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type ServerConfig } from './config.js';
import { createStorageAdapter, type StorageAdapter } from './db/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBabyRoutes } from './routes/babies.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSyncRoutes } from './routes/sync.js';

export interface BuildAppOptions {
  config?: Partial<ServerConfig>;
  storage?: StorageAdapter;
  logger?: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = loadConfig(options.config);
  const storage = options.storage ?? createStorageAdapter(config);
  await storage.init();

  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.addHook('onClose', async () => {
    await storage.close();
  });

  await app.register(fastifyCookie);

  registerHealthRoutes(app, storage);
  registerAuthRoutes(app, storage, config);
  registerBabyRoutes(app, storage, config);
  registerSyncRoutes(app, storage, config);

  const hasStaticDir = fs.existsSync(config.staticDir);
  const hasIndexHtml =
    hasStaticDir && fs.existsSync(path.join(config.staticDir, 'index.html'));

  if (hasStaticDir) {
    await app.register(fastifyStatic, {
      root: config.staticDir,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const relPath = path
          .relative(config.staticDir, filePath)
          .split(path.sep)
          .join('/');
        if (relPath === 'sw.js' || relPath === 'registerSW.js') {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (
          relPath === 'index.html' ||
          relPath === 'manifest.webmanifest'
        ) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (relPath.startsWith('assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=0');
        }
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const pathOnly = request.url.split('?')[0] ?? request.url;
    if (
      pathOnly === '/api' ||
      pathOnly.startsWith('/api/') ||
      request.method !== 'GET'
    ) {
      return reply.code(404).send({ error: 'Not found' });
    }

    if (hasIndexHtml) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
