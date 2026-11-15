import type { User } from '@baby-tracker/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { StorageAdapter } from '../db/types.js';
import { signSessionToken, verifySessionToken } from './crypto.js';

export const SESSION_COOKIE_NAME = 'bt_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function setSessionCookie(
  reply: FastifyReply,
  userId: string,
  config: ServerConfig,
): void {
  const token = signSessionToken(
    { userId, exp: Date.now() + SESSION_TTL_MS },
    config.sessionSecret,
  );
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.cookieSecure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  config: ServerConfig,
): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.cookieSecure,
  });
}

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  storage: StorageAdapter,
  config: ServerConfig,
): Promise<User | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    await reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }

  const payload = verifySessionToken(token, config.sessionSecret);
  if (!payload) {
    await reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }

  const user = await storage.findUserById(payload.userId);
  if (!user) {
    await reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }

  return user;
}
