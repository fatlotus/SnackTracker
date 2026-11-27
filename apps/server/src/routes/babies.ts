import crypto from 'node:crypto';
import {
  AcceptInviteInputSchema,
  CreateInviteInputSchema,
  UpdateMemberRoleInputSchema,
  canAssignRole,
  canInviteMembers,
  uuidSchema,
} from '@baby-tracker/shared';
import type { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth/session.js';
import type { ServerConfig } from '../config.js';
import type { StorageAdapter } from '../db/types.js';

export function registerBabyRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  config: ServerConfig,
): void {
  app.post('/api/babies/:babyId/invites', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const { babyId } = request.params as { babyId: string };
    if (!uuidSchema.safeParse(babyId).success) {
      return reply.code(400).send({ error: 'Invalid babyId' });
    }

    const parsed = CreateInviteInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const membership = await storage.getActiveMembership(babyId, user.id);
    if (!membership || !canInviteMembers(membership.role)) {
      return reply
        .code(403)
        .send({ error: 'Forbidden: insufficient role to create invites' });
    }

    if (!canAssignRole(membership.role, parsed.data.role)) {
      return reply
        .code(403)
        .send({ error: 'Forbidden: cannot invite a role higher than your own' });
    }

    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(
      nowMs + parsed.data.expiresInHours * 60 * 60 * 1000,
    ).toISOString();
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();

    const invite = await storage.createInvite({
      id: crypto.randomUUID(),
      babyId,
      code,
      role: parsed.data.role,
      createdByUserId: user.id,
      expiresAt,
      createdAt,
    });

    return reply.code(201).send({ invite });
  });

  app.post('/api/invites/accept', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const parsed = AcceptInviteInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const result = await storage.acceptInvite({
      code: parsed.data.code.toUpperCase(),
      userId: user.id,
      displayName: user.displayName,
      memberId: crypto.randomUUID(),
      now: new Date().toISOString(),
    });

    if (!result.ok) {
      if (result.error === 'EXPIRED') {
        return reply.code(410).send({ error: 'Invite has expired' });
      }
      return reply.code(404).send({ error: 'Invite not found' });
    }

    return reply.code(200).send({
      baby: result.baby,
      member: result.member,
    });
  });

  app.get('/api/babies/:babyId/members', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const { babyId } = request.params as { babyId: string };
    if (!uuidSchema.safeParse(babyId).success) {
      return reply.code(400).send({ error: 'Invalid babyId' });
    }

    const membership = await storage.getActiveMembership(babyId, user.id);
    if (!membership) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const members = await storage.listBabyMembers(babyId);
    return reply.code(200).send({ members });
  });

  app.patch('/api/babies/:babyId/members/:userId', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const { babyId, userId: targetUserId } = request.params as {
      babyId: string;
      userId: string;
    };
    if (
      !uuidSchema.safeParse(babyId).success ||
      !uuidSchema.safeParse(targetUserId).success
    ) {
      return reply.code(400).send({ error: 'Invalid babyId or userId' });
    }

    const parsed = UpdateMemberRoleInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const result = await storage.updateBabyMemberRole({
      babyId,
      actorUserId: user.id,
      targetUserId,
      role: parsed.data.role,
      now: new Date().toISOString(),
    });

    if (!result.ok) {
      if (result.error === 'FORBIDDEN') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      if (result.error === 'LAST_PARENT') {
        return reply.code(409).send({
          error: 'Cannot demote the last parent of a baby',
          code: 'LAST_PARENT',
        });
      }
      return reply.code(404).send({ error: 'Member not found' });
    }

    return reply.code(200).send({ member: result.member });
  });

  app.delete('/api/babies/:babyId/members/:userId', async (request, reply) => {
    const user = await authenticateRequest(request, reply, storage, config);
    if (!user) return;

    const { babyId, userId: targetUserId } = request.params as {
      babyId: string;
      userId: string;
    };
    if (
      !uuidSchema.safeParse(babyId).success ||
      !uuidSchema.safeParse(targetUserId).success
    ) {
      return reply.code(400).send({ error: 'Invalid babyId or userId' });
    }

    const result = await storage.removeBabyMember({
      babyId,
      targetUserId,
      actorUserId: user.id,
      now: new Date().toISOString(),
    });

    if (!result.ok) {
      if (result.error === 'FORBIDDEN') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      if (result.error === 'LAST_PARENT') {
        return reply.code(409).send({
          error: 'Cannot remove the last parent of a baby',
          code: 'LAST_PARENT',
        });
      }
      return reply.code(404).send({ error: 'Member not found' });
    }

    return reply.code(200).send({ ok: true });
  });
}
