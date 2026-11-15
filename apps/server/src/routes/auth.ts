import crypto from 'node:crypto';
import {
  LoginInputSchema,
  RegisterInputSchema,
} from '@baby-tracker/shared';
import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
import {
  authenticateRequest,
  clearSessionCookie,
  setSessionCookie,
} from '../auth/session.js';
import type { ServerConfig } from '../config.js';
import { DuplicateEmailError, type StorageAdapter } from '../db/types.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  config: ServerConfig,
): void {
  app.post('/api/auth/register', async (request, reply) => {
    const parsed = RegisterInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const { email, password, displayName } = parsed.data;
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    try {
      const user = await storage.createUser({
        id: crypto.randomUUID(),
        email,
        displayName,
        passwordHash,
        createdAt: now,
      });
      setSessionCookie(reply, user.id, config);
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        return reply.code(409).send({ error: 'Email already registered' });
      }
      throw err;
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const { email, password } = parsed.data;
    const userRecord = await storage.findUserByEmail(email);
    if (!userRecord) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const valid = await verifyPassword(password, userRecord.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    setSessionCookie(reply, userRecord.id, config);
    return reply.code(200).send({
      user: {
        id: userRecord.id,
        email: userRecord.email,
        displayName: userRecord.displayName,
        createdAt: userRecord.createdAt,
      },
    });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    clearSessionCookie(reply, config);
    return reply.code(200).send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;
    return reply.code(200).send({ user });
  });
}
