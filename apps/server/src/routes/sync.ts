import {
  SyncPullQuerySchema,
  SyncPushRequestSchema,
} from '@baby-tracker/shared';
import type { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth/session.js';
import type { ServerConfig } from '../config.js';
import type { StorageAdapter } from '../db/types.js';

export function registerSyncRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  config: ServerConfig,
): void {
  app.post('/api/sync/push', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const parsed = SyncPushRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const result = await storage.applySyncMutations({
      userId: user.id,
      userDisplayName: user.displayName,
      mutations: parsed.data.mutations,
      serverNowIso: new Date().toISOString(),
    });

    return reply.code(200).send(result);
  });

  app.get('/api/sync/pull', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const parsed = SyncPullQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        issues: parsed.error.issues,
      });
    }

    const result = await storage.pullSince({
      userId: user.id,
      sinceSeq: parsed.data.since_seq,
    });

    return reply.code(200).send(result);
  });
}
