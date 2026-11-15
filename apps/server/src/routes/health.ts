import type { HealthzResponse } from '@baby-tracker/shared';
import type { FastifyInstance } from 'fastify';
import type { StorageAdapter } from '../db/types.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
): void {
  app.get('/healthz', async (): Promise<HealthzResponse> => {
    return {
      status: 'ok',
      storage: storage.kind,
    };
  });
}
