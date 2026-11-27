import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { signSessionToken } from '../auth/crypto.js';
import { SqliteStorageAdapter } from '../db/sqlite.js';

function extractCookie(res: {
  headers: Record<string, string | string[] | number | undefined>;
}): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const sessionCookie = list.find((c) => c.startsWith('bt_session='));
  if (!sessionCookie) {
    throw new Error('Missing bt_session Set-Cookie header');
  }
  return sessionCookie.split(';')[0]!;
}

describe('Baby Tracker Server (M2)', () => {
  const apps: FastifyInstance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (apps.length > 0) {
      const app = apps.pop()!;
      await app.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createTestApp(staticDir?: string): Promise<FastifyInstance> {
    const app = await buildApp({
      config: {
        sqlitePath: ':memory:',
        sessionSecret: 'test-secret-key-for-vitest',
        staticDir: staticDir ?? '/nonexistent-static-dir',
      },
    });
    apps.push(app);
    return app;
  }

  it('returns healthz ok with sqlite storage', async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', storage: 'sqlite' });
  });

  it('handles register, me, logout, login, and duplicate email', async () => {
    const app = await createTestApp();

    const unauthMe = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(unauthMe.statusCode).toBe(401);

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'parent1@example.com',
        password: 'password123',
        displayName: 'Parent One',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const regBody = regRes.json() as { user: { id: string; email: string; displayName: string } };
    expect(regBody.user.email).toBe('parent1@example.com');
    expect(regBody.user.displayName).toBe('Parent One');

    const setCookieHeader = String(regRes.headers['set-cookie']);
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain('Path=/');

    const cookie = extractCookie(regRes);

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual({ user: regBody.user });

    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'parent1@example.com',
        password: 'password123',
        displayName: 'Duplicate',
      },
    });
    expect(dupRes.statusCode).toBe(409);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json()).toEqual({ ok: true });

    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'parent1@example.com', password: 'wrongpassword' },
    });
    expect(badLogin.statusCode).toBe(401);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'parent1@example.com', password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginCookie = extractCookie(loginRes);
    const me2 = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: loginCookie },
    });
    expect(me2.statusCode).toBe(200);
  });

  it('supports sync push/pull, idempotency, LWW, clock clamping, and soft-delete', async () => {
    const app = await createTestApp();

    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'alice@example.com',
        password: 'password123',
        displayName: 'Alice',
      },
    });
    const cookie = extractCookie(reg);
    const aliceId = (reg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const now = new Date().toISOString();
    const mutBabyId = crypto.randomUUID();

    // Push new baby
    const push1 = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: mutBabyId,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Maya',
              dob: '2026-01-15',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: aliceId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(push1.statusCode).toBe(200);
    const push1Body = push1.json() as {
      ackedMutationIds: string[];
      rejected: unknown[];
      latestSeq: number;
    };
    expect(push1Body.ackedMutationIds).toEqual([mutBabyId]);
    expect(push1Body.rejected).toEqual([]);
    expect(push1Body.latestSeq).toBeGreaterThan(0);

    // Idempotent retry of same mutationId
    const pushRetry = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: mutBabyId,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Maya Modified',
              dob: '2026-01-15',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: aliceId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushRetry.statusCode).toBe(200);
    expect(pushRetry.json()).toEqual({
      ackedMutationIds: [mutBabyId],
      rejected: [],
      latestSeq: push1Body.latestSeq,
    });

    // Push event with future clientUpdatedAt (should be clamped)
    const eventId = crypto.randomUUID();
    const farFuture = new Date(Date.now() + 3_600_000).toISOString();
    const evtMutId = crypto.randomUUID();
    const pushEvt = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: evtMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: farFuture,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: aliceId,
              updatedByUserId: aliceId,
              createdAt: now,
              updatedAt: farFuture,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushEvt.statusCode).toBe(200);
    const pushEvtBody = pushEvt.json() as {
      ackedMutationIds: string[];
      rejected: unknown[];
      latestSeq: number;
    };
    expect(pushEvtBody.ackedMutationIds).toEqual([evtMutId]);

    // Pull from 0
    const pullRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie },
    });
    expect(pullRes.statusCode).toBe(200);
    const pullBody = pullRes.json() as {
      babies: Array<{ id: string; name: string }>;
      members: Array<{ babyId: string; userId: string; role: string }>;
      events: Array<{ id: string; updatedAt: string; deletedAt?: string | null }>;
      latestSeq: number;
    };
    expect(pullBody.babies).toHaveLength(1);
    expect(pullBody.babies[0]!.name).toBe('Maya');
    expect(pullBody.members).toHaveLength(1);
    expect(pullBody.members[0]!.role).toBe('parent');
    expect(pullBody.events).toHaveLength(1);
    // Clamped to <= now + 65s
    expect(Date.parse(pullBody.events[0]!.updatedAt)).toBeLessThanOrEqual(
      Date.now() + 65_000,
    );

    // Soft-delete event
    const delMutId = crypto.randomUUID();
    const delAt = new Date(Date.now() + 120_000).toISOString();
    const pushDel = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: delMutId,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: delAt,
            data: { id: eventId, deletedAt: delAt },
          },
        ],
      },
    });
    expect(pushDel.statusCode).toBe(200);
    const pullAfterDel = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since_seq=${pullBody.latestSeq}`,
      headers: { cookie },
    });
    expect(pullAfterDel.statusCode).toBe(200);
    const delBody = pullAfterDel.json() as {
      events: Array<{ id: string; deletedAt: string | null }>;
    };
    expect(delBody.events).toHaveLength(1);
    expect(delBody.events[0]!.deletedAt).toBeTruthy();
  });

  it('enforces invites, backfill on accept, roles, and member removal', async () => {
    const app = await createTestApp();

    // Register Owner (Alice) and Caregiver (Bob) and Viewer (Carol)
    const regA = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', password: 'password123', displayName: 'Alice' },
    });
    const cookieA = extractCookie(regA);
    const idA = (regA.json() as { user: { id: string } }).user.id;

    const regB = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'b@example.com', password: 'password123', displayName: 'Bob' },
    });
    const cookieB = extractCookie(regB);
    const idB = (regB.json() as { user: { id: string } }).user.id;

    const regC = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'c@example.com', password: 'password123', displayName: 'Carol' },
    });
    const cookieC = extractCookie(regC);
    const idC = (regC.json() as { user: { id: string } }).user.id;

    // Bob creates his own baby first so his since_seq > 0
    const bobBabyId = crypto.randomUUID();
    const now = new Date().toISOString();
    const bobPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieB },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: bobBabyId,
              name: 'Bob Baby',
              dob: '2026-02-01',
              avatarColor: '#10b981',
              isArchived: false,
              createdByUserId: idB,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    const bobSeqBeforeInvite = (bobPush.json() as { latestSeq: number }).latestSeq;

    // Alice creates her baby + event
    const aliceBabyId = crypto.randomUUID();
    const aliceEventId = crypto.randomUUID();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: aliceBabyId,
              name: 'Alice Baby',
              dob: '2026-01-10',
              avatarColor: '#ec4899',
              isArchived: false,
              createdByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: aliceEventId,
              babyId: aliceBabyId,
              type: 'bottle_feed',
              startedAt: now,
              endedAt: now,
              payload: { volumeMl: 120, milkType: 'formula' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    // Alice creates caregiver invite for Bob and viewer invite for Carol
    const invCaregiver = await app.inject({
      method: 'POST',
      url: `/api/babies/${aliceBabyId}/invites`,
      headers: { cookie: cookieA },
      payload: { role: 'caregiver', expiresInHours: 24 },
    });
    expect(invCaregiver.statusCode).toBe(201);
    const codeB = (invCaregiver.json() as { invite: { code: string } }).invite.code;

    const invViewer = await app.inject({
      method: 'POST',
      url: `/api/babies/${aliceBabyId}/invites`,
      headers: { cookie: cookieA },
      payload: { role: 'viewer', expiresInHours: 24 },
    });
    expect(invViewer.statusCode).toBe(201);
    const codeC = (invViewer.json() as { invite: { code: string } }).invite.code;

    // Bob accepts invite
    const accB = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieB },
      payload: { code: codeB },
    });
    expect(accB.statusCode).toBe(200);
    expect((accB.json() as { member: { role: string } }).member.role).toBe('caregiver');

    // Bob pulls from bobSeqBeforeInvite -> should backfill Alice's baby + members + event!
    const pullB = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since_seq=${bobSeqBeforeInvite}`,
      headers: { cookie: cookieB },
    });
    expect(pullB.statusCode).toBe(200);
    const pullBBody = pullB.json() as {
      babies: Array<{ id: string }>;
      members: Array<{ userId: string }>;
      events: Array<{ id: string }>;
    };
    expect(pullBBody.babies.some((b) => b.id === aliceBabyId)).toBe(true);
    expect(pullBBody.events.some((e) => e.id === aliceEventId)).toBe(true);
    expect(pullBBody.members.some((m) => m.userId === idA)).toBe(true);

    // Carol accepts viewer invite
    const accC = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieC },
      payload: { code: codeC },
    });
    expect(accC.statusCode).toBe(200);

    // Carol (viewer) cannot mutate events
    const carolPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieC },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId: aliceBabyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'poopy' },
              loggedByUserId: idC,
              updatedByUserId: idC,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(carolPush.statusCode).toBe(200);
    const carolPushBody = carolPush.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ reason: string }>;
    };
    expect(carolPushBody.ackedMutationIds).toHaveLength(0);
    expect(carolPushBody.rejected).toHaveLength(1);

    // Cannot remove last owner
    const delLastOwner = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${aliceBabyId}/members/${idA}`,
      headers: { cookie: cookieA },
    });
    expect(delLastOwner.statusCode).toBe(409);

    // Owner removes Carol
    const delCarol = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${aliceBabyId}/members/${idC}`,
      headers: { cookie: cookieA },
    });
    expect(delCarol.statusCode).toBe(200);

    // Members list now has Alice and Bob
    const listMembers = await app.inject({
      method: 'GET',
      url: `/api/babies/${aliceBabyId}/members`,
      headers: { cookie: cookieA },
    });
    expect(listMembers.statusCode).toBe(200);
    expect((listMembers.json() as { members: unknown[] }).members).toHaveLength(2);
  });

  it('serves SPA fallback for non-API GET routes and 404 JSON for unknown /api routes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-static-'));
    tempDirs.push(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<!doctype html><html><body>Baby Tracker SPA</body></html>',
    );
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'assets', 'app.js'),
      'console.log("baby tracker asset");',
    );

    const app = await createTestApp(tmpDir);

    const spaRes = await app.inject({ method: 'GET', url: '/join/ABC123' });
    expect(spaRes.statusCode).toBe(200);
    expect(spaRes.body).toContain('Baby Tracker SPA');

    const api404 = await app.inject({ method: 'GET', url: '/api/unknown/route' });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toEqual({ error: 'Not found' });

    // Serving an actual static asset file returns 200 with its contents
    const assetRes = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.body).toBe('console.log("baby tracker asset");');

    // Non-GET unknown route returns 404 JSON (not index.html)
    const postUnknown = await app.inject({
      method: 'POST',
      url: '/some/unknown/path',
      payload: {},
    });
    expect(postUnknown.statusCode).toBe(404);
    expect(postUnknown.json()).toEqual({ error: 'Not found' });

    // GET /api?foo=bar returns 404 JSON (not index.html)
    const apiRootQuery = await app.inject({ method: 'GET', url: '/api?foo=bar' });
    expect(apiRootQuery.statusCode).toBe(404);
    expect(apiRootQuery.json()).toEqual({ error: 'Not found' });
  });

  it('acks stale LWW writes without overwriting newer baby/event state or advancing latestSeq', async () => {
    const app = await createTestApp();

    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'lww@example.com',
        password: 'password123',
        displayName: 'LWW User',
      },
    });
    const cookie = extractCookie(reg);
    const userId = (reg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const tNewer = new Date(Date.now() - 10_000).toISOString();
    const tOlder = new Date(Date.now() - 60_000).toISOString();

    // Push newer baby + event
    const pushNewer = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: tNewer,
            data: {
              id: babyId,
              name: 'Newer Baby Name',
              dob: '2026-01-15',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: userId,
              createdAt: tOlder,
              updatedAt: tNewer,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: tNewer,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: tOlder,
              endedAt: tOlder,
              payload: { kind: 'poopy' },
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: tOlder,
              updatedAt: tNewer,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushNewer.statusCode).toBe(200);
    const seqAfterNewer = (pushNewer.json() as { latestSeq: number }).latestSeq;

    // Push stale baby and stale event with older clientUpdatedAt
    const staleBabyMutId = crypto.randomUUID();
    const staleEventMutId = crypto.randomUUID();
    const pushStale = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: staleBabyMutId,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: tOlder,
            data: {
              id: babyId,
              name: 'Stale Baby Name',
              dob: '2026-01-15',
              avatarColor: '#000000',
              isArchived: true,
              createdByUserId: userId,
              createdAt: tOlder,
              updatedAt: tOlder,
              deletedAt: null,
            },
          },
          {
            mutationId: staleEventMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: tOlder,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: tOlder,
              endedAt: tOlder,
              payload: { kind: 'wet' },
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: tOlder,
              updatedAt: tOlder,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushStale.statusCode).toBe(200);
    expect(pushStale.json()).toEqual({
      ackedMutationIds: [staleBabyMutId, staleEventMutId],
      rejected: [],
      latestSeq: seqAfterNewer,
    });

    // Pull and verify newer state was preserved
    const pullRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie },
    });
    expect(pullRes.statusCode).toBe(200);
    const pullBody = pullRes.json() as {
      babies: Array<{ id: string; name: string; isArchived: boolean; updatedAt: string }>;
      events: Array<{ id: string; payload: { kind: string }; updatedAt: string }>;
      latestSeq: number;
    };
    expect(pullBody.latestSeq).toBe(seqAfterNewer);
    expect(pullBody.babies[0]!.name).toBe('Newer Baby Name');
    expect(pullBody.babies[0]!.isArchived).toBe(false);
    expect(pullBody.events[0]!.payload.kind).toBe('poopy');
  });

  it('supports owner-only baby delete and propagates soft-delete tombstone on pull', async () => {
    const app = await createTestApp();

    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'owner-del@example.com',
        password: 'password123',
        displayName: 'Owner',
      },
    });
    const cookie = extractCookie(reg);
    const userId = (reg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const t1 = new Date(Date.now() - 5000).toISOString();
    const pushCreate = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: babyId,
              name: 'To Be Deleted',
              dob: '2026-01-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: userId,
              createdAt: t1,
              updatedAt: t1,
              deletedAt: null,
            },
          },
        ],
      },
    });
    const seqBeforeDel = (pushCreate.json() as { latestSeq: number }).latestSeq;

    const delAt = new Date().toISOString();
    const delMutId = crypto.randomUUID();
    const pushDel = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: delMutId,
            entityType: 'baby',
            op: 'delete',
            clientUpdatedAt: delAt,
            data: { id: babyId, deletedAt: delAt },
          },
        ],
      },
    });
    expect(pushDel.statusCode).toBe(200);
    const pushDelBody = pushDel.json() as {
      ackedMutationIds: string[];
      rejected: unknown[];
      latestSeq: number;
    };
    expect(pushDelBody.ackedMutationIds).toEqual([delMutId]);
    expect(pushDelBody.rejected).toEqual([]);
    expect(pushDelBody.latestSeq).toBeGreaterThan(seqBeforeDel);

    const pullRes = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since_seq=${seqBeforeDel}`,
      headers: { cookie },
    });
    expect(pullRes.statusCode).toBe(200);
    const pullBody = pullRes.json() as {
      babies: Array<{ id: string; deletedAt: string | null }>;
    };
    expect(pullBody.babies).toHaveLength(1);
    expect(pullBody.babies[0]!.id).toBe(babyId);
    expect(pullBody.babies[0]!.deletedAt).toBe(delAt);
  });

  it('enforces role boundaries on sync mutations, invites, members, and revoked member isolation', async () => {
    const app = await createTestApp();

    const regOwner = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'owner@example.com', password: 'password123', displayName: 'Owner' },
    });
    const cookieOwner = extractCookie(regOwner);
    const ownerId = (regOwner.json() as { user: { id: string } }).user.id;

    const regCaregiver = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'caregiver@example.com', password: 'password123', displayName: 'Caregiver' },
    });
    const cookieCaregiver = extractCookie(regCaregiver);
    const caregiverId = (regCaregiver.json() as { user: { id: string } }).user.id;

    const regViewer = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'viewer@example.com', password: 'password123', displayName: 'Viewer' },
    });
    const cookieViewer = extractCookie(regViewer);
    const viewerId = (regViewer.json() as { user: { id: string } }).user.id;

    const regOutsider = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'outsider@example.com', password: 'password123', displayName: 'Outsider' },
    });
    const cookieOutsider = extractCookie(regOutsider);

    // Owner creates baby and initial event
    const babyId = crypto.randomUUID();
    const ownerEventId = crypto.randomUUID();
    const now = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieOwner },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Shared Baby',
              dob: '2026-01-15',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: ownerEventId,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: ownerId,
              updatedByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    // Invite caregiver & viewer
    const invCaregiver = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: cookieOwner },
      payload: { role: 'caregiver', expiresInHours: 24 },
    });
    const codeCaregiver = (invCaregiver.json() as { invite: { code: string } }).invite.code;
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieCaregiver },
      payload: { code: codeCaregiver },
    });

    const invViewer = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: cookieOwner },
      payload: { role: 'viewer', expiresInHours: 24 },
    });
    const codeViewer = (invViewer.json() as { invite: { code: string } }).invite.code;
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieViewer },
      payload: { code: codeViewer },
    });

    // 1. Viewer rejected on event upsert/delete and baby upsert/delete
    const viewerSyncRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieViewer },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'poopy' },
              loggedByUserId: viewerId,
              updatedByUserId: viewerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: now,
            data: { id: ownerEventId, deletedAt: now },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Viewer Renamed',
              dob: '2026-01-15',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'delete',
            clientUpdatedAt: now,
            data: { id: babyId, deletedAt: now },
          },
        ],
      },
    });
    expect(viewerSyncRes.statusCode).toBe(200);
    const viewerSyncBody = viewerSyncRes.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ reason: string }>;
    };
    expect(viewerSyncBody.ackedMutationIds).toHaveLength(0);
    expect(viewerSyncBody.rejected).toHaveLength(4);

    // 2. Caregiver rejected on baby upsert/delete, allowed on event upsert/delete
    const cgEventId = crypto.randomUUID();
    const cgEventUpsertId = crypto.randomUUID();
    const cgEventDeleteId = crypto.randomUUID();
    const cgBabyUpsertId = crypto.randomUUID();
    const cgBabyDeleteId = crypto.randomUUID();
    const tLater = new Date(Date.now() + 1000).toISOString();

    const cgSyncRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieCaregiver },
      payload: {
        mutations: [
          {
            mutationId: cgBabyUpsertId,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: tLater,
            data: {
              id: babyId,
              name: 'Caregiver Renamed',
              dob: '2026-01-15',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: now,
              updatedAt: tLater,
              deletedAt: null,
            },
          },
          {
            mutationId: cgBabyDeleteId,
            entityType: 'baby',
            op: 'delete',
            clientUpdatedAt: tLater,
            data: { id: babyId, deletedAt: tLater },
          },
          {
            mutationId: cgEventUpsertId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: cgEventId,
              babyId,
              type: 'sleep',
              startedAt: now,
              endedAt: null,
              payload: { category: 'nap' },
              loggedByUserId: caregiverId,
              updatedByUserId: caregiverId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: cgEventDeleteId,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: tLater,
            data: { id: cgEventId, deletedAt: tLater },
          },
        ],
      },
    });
    expect(cgSyncRes.statusCode).toBe(200);
    const cgSyncBody = cgSyncRes.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(cgSyncBody.ackedMutationIds).toEqual([cgEventUpsertId, cgEventDeleteId]);
    expect(cgSyncBody.rejected.map((r) => r.mutationId)).toEqual([
      cgBabyUpsertId,
      cgBabyDeleteId,
    ]);

    // 3. Viewers and outsiders get 403 on POST /api/babies/:babyId/invites; caregivers get 403 for parent invites
    for (const nonInviterCookie of [cookieViewer, cookieOutsider]) {
      const invRes = await app.inject({
        method: 'POST',
        url: `/api/babies/${babyId}/invites`,
        headers: { cookie: nonInviterCookie },
        payload: { role: 'viewer' },
      });
      expect(invRes.statusCode).toBe(403);
    }
    const cgParentInvRes = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: cookieCaregiver },
      payload: { role: 'parent' },
    });
    expect(cgParentInvRes.statusCode).toBe(403);

    // 4. Non-member gets 403 on GET /api/babies/:babyId/members
    const outsiderMembers = await app.inject({
      method: 'GET',
      url: `/api/babies/${babyId}/members`,
      headers: { cookie: cookieOutsider },
    });
    expect(outsiderMembers.statusCode).toBe(403);

    // 5. Hierarchy enforcement on DELETE /api/babies/:babyId/members/:userId
    // Caregiver cannot remove parent
    const cgDelParent = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${ownerId}`,
      headers: { cookie: cookieCaregiver },
    });
    expect(cgDelParent.statusCode).toBe(403);

    const viewerDelCaregiver = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${caregiverId}`,
      headers: { cookie: cookieViewer },
    });
    expect(viewerDelCaregiver.statusCode).toBe(403);

    const outsiderDelViewer = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${viewerId}`,
      headers: { cookie: cookieOutsider },
    });
    expect(outsiderDelViewer.statusCode).toBe(403);

    // 6. Owner gets 404 when deleting an unknown member
    const delUnknownMember = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${crypto.randomUUID()}`,
      headers: { cookie: cookieOwner },
    });
    expect(delUnknownMember.statusCode).toBe(404);

    // 7. Revoked member behavior
    const pullBeforeRevoke = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: cookieCaregiver },
    });
    const seqBeforeRevoke = (pullBeforeRevoke.json() as { latestSeq: number }).latestSeq;

    // Owner revokes caregiver
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${caregiverId}`,
      headers: { cookie: cookieOwner },
    });
    expect(revokeRes.statusCode).toBe(200);

    // Owner pushes a new event after revocation
    const postRevokeEventId = crypto.randomUUID();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieOwner },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              id: postRevokeEventId,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'both' },
              loggedByUserId: ownerId,
              updatedByUserId: ownerId,
              createdAt: now,
              updatedAt: new Date().toISOString(),
              deletedAt: null,
            },
          },
        ],
      },
    });

    // Revoked caregiver pulls -> receives member tombstone, NO new events for that baby
    const pullAfterRevoke = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since_seq=${seqBeforeRevoke}`,
      headers: { cookie: cookieCaregiver },
    });
    expect(pullAfterRevoke.statusCode).toBe(200);
    const afterRevokeBody = pullAfterRevoke.json() as {
      babies: Array<{ id: string }>;
      members: Array<{ userId: string; deletedAt: string | null }>;
      events: Array<{ id: string }>;
    };
    expect(afterRevokeBody.members).toHaveLength(1);
    expect(afterRevokeBody.members[0]!.userId).toBe(caregiverId);
    expect(afterRevokeBody.members[0]!.deletedAt).toBeTruthy();
    expect(afterRevokeBody.events.some((e) => e.id === postRevokeEventId)).toBe(false);
    expect(afterRevokeBody.babies).toHaveLength(0);

    // Revoked caregiver is rejected on push for that baby
    const pushAfterRevoke = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieCaregiver },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: caregiverId,
              updatedByUserId: caregiverId,
              createdAt: now,
              updatedAt: new Date().toISOString(),
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushAfterRevoke.statusCode).toBe(200);
    const pushAfterRevokeBody = pushAfterRevoke.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ reason: string }>;
    };
    expect(pushAfterRevokeBody.ackedMutationIds).toHaveLength(0);
    expect(pushAfterRevokeBody.rejected).toHaveLength(1);
  });

  it('returns 404 for unknown invite code and 410 for expired invite', async () => {
    vi.useFakeTimers({
      now: new Date('2026-06-01T00:00:00.000Z'),
      toFake: ['Date'],
    });
    const app = await createTestApp();

    const regOwner = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'inv-owner@example.com', password: 'password123', displayName: 'Owner' },
    });
    const cookieOwner = extractCookie(regOwner);
    const ownerId = (regOwner.json() as { user: { id: string } }).user.id;

    const regJoiner = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'inv-joiner@example.com', password: 'password123', displayName: 'Joiner' },
    });
    const cookieJoiner = extractCookie(regJoiner);

    // Unknown invite code -> 404
    const unknownRes = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieJoiner },
      payload: { code: 'DOESNOTEXIST' },
    });
    expect(unknownRes.statusCode).toBe(404);

    // Create baby + 1-hour invite
    const babyId = crypto.randomUUID();
    const now = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieOwner },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Invite Baby',
              dob: '2026-01-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    const invRes = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: cookieOwner },
      payload: { role: 'caregiver', expiresInHours: 1 },
    });
    expect(invRes.statusCode).toBe(201);
    const code = (invRes.json() as { invite: { code: string } }).invite.code;

    // Advance Date by 2 hours so invite is expired (session TTL is 30 days)
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    const expiredRes = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieJoiner },
      payload: { code },
    });
    expect(expiredRes.statusCode).toBe(410);
  });

  it('handles auth and validation edge cases and unauthenticated 401 responses', async () => {
    const app = await createTestApp();

    // Unauthenticated 401 on protected endpoints
    const randomId = crypto.randomUUID();
    const unauthRequests = [
      { method: 'POST' as const, url: '/api/sync/push', payload: { mutations: [] } },
      { method: 'GET' as const, url: '/api/sync/pull?since_seq=0' },
      { method: 'POST' as const, url: `/api/babies/${randomId}/invites`, payload: {} },
      { method: 'POST' as const, url: '/api/invites/accept', payload: { code: 'ABCD1234' } },
      { method: 'GET' as const, url: `/api/babies/${randomId}/members` },
      { method: 'DELETE' as const, url: `/api/babies/${randomId}/members/${randomId}` },
    ];
    for (const req of unauthRequests) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(401);
    }

    // Register user and check case-insensitive duplicate email (409)
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'CaseUser@Example.com',
        password: 'password123',
        displayName: 'Case User',
      },
    });
    expect(reg.statusCode).toBe(201);
    const cookie = extractCookie(reg);

    const dupCaseRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'caseuser@example.com',
        password: 'password123',
        displayName: 'Dup Case',
      },
    });
    expect(dupCaseRes.statusCode).toBe(409);

    // Unknown email login -> 401
    const unknownLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unknown@example.com', password: 'password123' },
    });
    expect(unknownLogin.statusCode).toBe(401);

    // Logout clears cookie (bt_session=; or Max-Age=0 / past Expires)
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(200);
    const logoutCookieHeader = String(logoutRes.headers['set-cookie']);
    expect(logoutCookieHeader).toMatch(/bt_session=;/);
    expect(logoutCookieHeader).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    // 400 validation errors on register, login, invite, and sync payloads
    const badRegister = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'short', displayName: '' },
    });
    expect(badRegister.statusCode).toBe(400);

    const badInviteCreate = await app.inject({
      method: 'POST',
      url: `/api/babies/${randomId}/invites`,
      headers: { cookie },
      payload: { role: 'owner', expiresInHours: 0 },
    });
    expect(badInviteCreate.statusCode).toBe(400);

    const badBabyIdInvite = await app.inject({
      method: 'POST',
      url: '/api/babies/not-a-uuid/invites',
      headers: { cookie },
      payload: { role: 'viewer' },
    });
    expect(badBabyIdInvite.statusCode).toBe(400);

    const badInviteAccept = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie },
      payload: { code: 'ab' },
    });
    expect(badInviteAccept.statusCode).toBe(400);

    const badSyncPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: { mutations: 'not-an-array' },
    });
    expect(badSyncPush.statusCode).toBe(400);

    const badSyncPull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=-5',
      headers: { cookie },
    });
    expect(badSyncPull.statusCode).toBe(400);
  });

  it('T5-AUTH-1: rejects expired, tampered-HMAC, malformed, and unknown-user bt_session cookies with 401', async () => {
    const app = await createTestApp();
    const secret = 'test-secret-key-for-vitest';

    // Register a real user so we can test tampered HMAC against a real session
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'auth-edge@example.com',
        password: 'password123',
        displayName: 'Auth Edge',
      },
    });
    expect(reg.statusCode).toBe(201);
    const userId = (reg.json() as { user: { id: string } }).user.id;
    const validCookie = extractCookie(reg);

    // 1. Expired token
    const expiredToken = signSessionToken(
      { userId, exp: Date.now() - 10_000 },
      secret,
    );
    // 2. Tampered HMAC (flip last character of signature)
    const tokenValue = validCookie.slice('bt_session='.length);
    const lastChar = tokenValue.slice(-1);
    const flippedChar = lastChar === 'a' ? 'b' : 'a';
    const tamperedToken = tokenValue.slice(0, -1) + flippedChar;

    // 3. Unknown user token (valid signature, non-existent userId)
    const unknownUserToken = signSessionToken(
      { userId: crypto.randomUUID(), exp: Date.now() + 60_000 },
      secret,
    );

    const badCookies = [
      `bt_session=${expiredToken}`,
      `bt_session=${tamperedToken}`,
      'bt_session=not-a-valid-token',
      'bt_session=abc.def.ghi',
      'bt_session=',
      `bt_session=${unknownUserToken}`,
    ];

    for (const cookie of badCookies) {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(meRes.statusCode).toBe(401);

      const pullRes = await app.inject({
        method: 'GET',
        url: '/api/sync/pull?since_seq=0',
        headers: { cookie },
      });
      expect(pullRes.statusCode).toBe(401);
    }
  });

  it('T5-INVITE-1: deleted baby invite returns 404, owner retains owner role on viewer invite, and caregiver self-removal revokes sync', async () => {
    const app = await createTestApp();

    const regOwner = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 't5inv-owner@example.com', password: 'password123', displayName: 'Owner' },
    });
    const cookieOwner = extractCookie(regOwner);
    const ownerId = (regOwner.json() as { user: { id: string } }).user.id;

    const regCg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 't5inv-cg@example.com', password: 'password123', displayName: 'Caregiver' },
    });
    const cookieCg = extractCookie(regCg);
    const cgId = (regCg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const now = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieOwner },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Invite Edge Baby',
              dob: '2026-01-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    // Create viewer invite and caregiver invite
    const viewerInvRes = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: cookieOwner },
      payload: { role: 'viewer', expiresInHours: 24 },
    });
    const viewerCode = (viewerInvRes.json() as { invite: { code: string } }).invite.code;

    const cgInvRes = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: cookieOwner },
      payload: { role: 'caregiver', expiresInHours: 24 },
    });
    const cgCode = (cgInvRes.json() as { invite: { code: string } }).invite.code;

    // Parent accepting a viewer invite retains 'parent' role
    const ownerAcceptViewer = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieOwner },
      payload: { code: viewerCode },
    });
    expect(ownerAcceptViewer.statusCode).toBe(200);
    expect((ownerAcceptViewer.json() as { member: { role: string } }).member.role).toBe('parent');

    // Caregiver accepts invite, then self-removes -> 200 and subsequent sync rejected
    const cgAccept = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieCg },
      payload: { code: cgCode },
    });
    expect(cgAccept.statusCode).toBe(200);

    const selfRemove = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${cgId}`,
      headers: { cookie: cookieCg },
    });
    expect(selfRemove.statusCode).toBe(200);
    expect(selfRemove.json()).toEqual({ ok: true });

    const cgPushAfterSelfRemove = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieCg },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: cgId,
              updatedByUserId: cgId,
              createdAt: now,
              updatedAt: new Date().toISOString(),
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(cgPushAfterSelfRemove.statusCode).toBe(200);
    const cgPushBody = cgPushAfterSelfRemove.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ reason: string }>;
    };
    expect(cgPushBody.ackedMutationIds).toHaveLength(0);
    expect(cgPushBody.rejected).toHaveLength(1);

    // Owner soft-deletes baby -> accepting invite for deleted baby returns 404
    const delAt = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieOwner },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'delete',
            clientUpdatedAt: delAt,
            data: { id: babyId, deletedAt: delAt },
          },
        ],
      },
    });

    const acceptDeletedBabyInv = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cookieCg },
      payload: { code: cgCode },
    });
    expect(acceptDeletedBabyInv.statusCode).toBe(404);
  });

  it('T5-SYNC-1: rejects cross-baby event move, prevents loggedByUserId spoofing, and rejects event mutations on soft-deleted baby', async () => {
    const app = await createTestApp();

    const regA = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'sync1-a@example.com', password: 'password123', displayName: 'Alice' },
    });
    const cookieA = extractCookie(regA);
    const idA = (regA.json() as { user: { id: string } }).user.id;

    const regB = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'sync1-b@example.com', password: 'password123', displayName: 'Bob' },
    });
    const idB = (regB.json() as { user: { id: string } }).user.id;

    const baby1 = crypto.randomUUID();
    const baby2 = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const t1 = new Date(Date.now() - 10_000).toISOString();

    // Create two babies and one event on baby1 with spoofed loggedByUserId = idB
    const pushInit = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: baby1,
              name: 'Baby One',
              dob: '2026-01-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: idA,
              createdAt: t1,
              updatedAt: t1,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: baby2,
              name: 'Baby Two',
              dob: '2026-01-02',
              avatarColor: '#ec4899',
              isArchived: false,
              createdByUserId: idA,
              createdAt: t1,
              updatedAt: t1,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: eventId,
              babyId: baby1,
              type: 'diaper',
              startedAt: t1,
              endedAt: t1,
              payload: { kind: 'wet' },
              loggedByUserId: idB, // spoofed!
              updatedByUserId: idB,
              createdAt: t1,
              updatedAt: t1,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushInit.statusCode).toBe(200);

    // Verify loggedByUserId was forced to authenticated user idA
    const pullRes = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: cookieA },
    });
    const pullBody = pullRes.json() as {
      events: Array<{ id: string; loggedByUserId: string; updatedByUserId: string }>;
    };
    const storedEvt = pullBody.events.find((e) => e.id === eventId)!;
    expect(storedEvt.loggedByUserId).toBe(idA);
    expect(storedEvt.updatedByUserId).toBe(idA);

    // Cross-baby event move rejected
    const t2 = new Date(Date.now() - 5_000).toISOString();
    const moveMutId = crypto.randomUUID();
    const pushMove = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: moveMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: eventId,
              babyId: baby2,
              type: 'diaper',
              startedAt: t1,
              endedAt: t1,
              payload: { kind: 'wet' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushMove.statusCode).toBe(200);
    const moveBody = pushMove.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(moveBody.ackedMutationIds).toEqual([]);
    expect(moveBody.rejected).toEqual([
      {
        mutationId: moveMutId,
        reason: 'Forbidden: cannot move event to another baby',
      },
    ]);

    // Soft-delete baby1, then attempt event upsert and event delete on baby1 -> both rejected
    const delAt = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'delete',
            clientUpdatedAt: delAt,
            data: { id: baby1, deletedAt: delAt },
          },
        ],
      },
    });

    const upsertOnDeletedMutId = crypto.randomUUID();
    const deleteOnDeletedMutId = crypto.randomUUID();
    const pushOnDeleted = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: upsertOnDeletedMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: delAt,
            data: {
              id: crypto.randomUUID(),
              babyId: baby1,
              type: 'diaper',
              startedAt: delAt,
              endedAt: delAt,
              payload: { kind: 'poopy' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: delAt,
              updatedAt: delAt,
              deletedAt: null,
            },
          },
          {
            mutationId: deleteOnDeletedMutId,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: delAt,
            data: { id: eventId, deletedAt: delAt },
          },
        ],
      },
    });
    expect(pushOnDeleted.statusCode).toBe(200);
    const deletedResBody = pushOnDeleted.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(deletedResBody.ackedMutationIds).toEqual([]);
    expect(deletedResBody.rejected).toEqual([
      {
        mutationId: upsertOnDeletedMutId,
        reason: 'Forbidden: baby has been deleted',
      },
      {
        mutationId: deleteOnDeletedMutId,
        reason: 'Forbidden: baby has been deleted',
      },
    ]);
  });

  it('T5-SYNC-2: handles mixed-batch partial rejection, rejected mutationId idempotency, cross-user mutationId isolation, and unknown event delete tombstones', async () => {
    const app = await createTestApp();

    const regA = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'sync2-a@example.com', password: 'password123', displayName: 'Alice' },
    });
    const cookieA = extractCookie(regA);
    const idA = (regA.json() as { user: { id: string } }).user.id;

    const regB = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'sync2-b@example.com', password: 'password123', displayName: 'Bob' },
    });
    const cookieB = extractCookie(regB);
    const idB = (regB.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const otherBabyId = crypto.randomUUID();
    const now = new Date().toISOString();

    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Batch Baby',
              dob: '2026-01-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    // Mixed batch: 1 valid event upsert (acked), 1 unauthorized baby event (rejected), 1 invalid payload (rejected)
    const ackedMutId = crypto.randomUUID();
    const rejUnauthMutId = crypto.randomUUID();
    const rejInvalidMutId = crypto.randomUUID();
    const mixedRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: ackedMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: rejUnauthMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId: otherBabyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: rejInvalidMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: 'not-a-uuid',
              babyId,
            },
          },
        ],
      },
    });
    expect(mixedRes.statusCode).toBe(200);
    const mixedBody = mixedRes.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(mixedBody.ackedMutationIds).toEqual([ackedMutId]);
    expect(mixedBody.rejected).toHaveLength(2);
    expect(mixedBody.rejected.map((r) => r.mutationId)).toEqual([
      rejUnauthMutId,
      rejInvalidMutId,
    ]);

    // Rejected mutationId idempotency: retrying rejUnauthMutId returns same rejection without re-processing
    const retryRejRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: rejUnauthMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(retryRejRes.statusCode).toBe(200);
    const retryRejBody = retryRejRes.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(retryRejBody.ackedMutationIds).toEqual([]);
    expect(retryRejBody.rejected).toEqual([
      {
        mutationId: rejUnauthMutId,
        reason: 'Forbidden: not an active member of this baby',
      },
    ]);

    // Cross-user mutationId isolation: User B sends User A's ackedMutId -> rejected with conflict
    const bobBabyId = crypto.randomUUID();
    const crossUserRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieB },
      payload: {
        mutations: [
          {
            mutationId: ackedMutId,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: bobBabyId,
              name: 'Bob Baby',
              dob: '2026-01-01',
              avatarColor: '#10b981',
              isArchived: false,
              createdByUserId: idB,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(crossUserRes.statusCode).toBe(200);
    const crossUserBody = crossUserRes.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(crossUserBody.ackedMutationIds).toEqual([]);
    expect(crossUserBody.rejected).toEqual([
      {
        mutationId: ackedMutId,
        reason: 'Conflict: mutationId belongs to another user',
      },
    ]);

    // Event delete for unknown ID:
    // 1) Minimal payload { id, deletedAt } -> acked idempotently
    // 2) Full event payload -> creates tombstone visible on pull
    const unknownMinimalId = crypto.randomUUID();
    const unknownFullId = crypto.randomUUID();
    const delMinimalMutId = crypto.randomUUID();
    const delFullMutId = crypto.randomUUID();
    const delUnknownRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cookieA },
      payload: {
        mutations: [
          {
            mutationId: delMinimalMutId,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: now,
            data: { id: unknownMinimalId, deletedAt: now },
          },
          {
            mutationId: delFullMutId,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: now,
            data: {
              id: unknownFullId,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              payload: { kind: 'wet' },
              loggedByUserId: idA,
              updatedByUserId: idA,
              createdAt: now,
              updatedAt: now,
              deletedAt: now,
            },
          },
        ],
      },
    });
    expect(delUnknownRes.statusCode).toBe(200);
    const delUnknownBody = delUnknownRes.json() as {
      ackedMutationIds: string[];
      rejected: unknown[];
    };
    expect(delUnknownBody.ackedMutationIds).toEqual([delMinimalMutId, delFullMutId]);
    expect(delUnknownBody.rejected).toEqual([]);

    const pullAfterTombstone = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: cookieA },
    });
    const tombEvents = (
      pullAfterTombstone.json() as {
        events: Array<{ id: string; deletedAt: string | null }>;
      }
    ).events;
    expect(tombEvents.some((e) => e.id === unknownMinimalId)).toBe(false);
    const fullTomb = tombEvents.find((e) => e.id === unknownFullId);
    expect(fullTomb?.deletedAt).toBe(now);
  });

  it('T5-SYNC-3: clamps future clientUpdatedAt (+5m -> +60s) and overwrites on equal-timestamp tie-break', async () => {
    vi.useFakeTimers({
      now: new Date('2026-06-15T12:00:00.000Z'),
      toFake: ['Date'],
    });
    const app = await createTestApp();

    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'sync3@example.com', password: 'password123', displayName: 'LWW Tie' },
    });
    const cookie = extractCookie(reg);
    const userId = (reg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const tNow = '2026-06-15T12:00:00.000Z';
    const tPlus5m = '2026-06-15T12:05:00.000Z';
    const expectedClamped = '2026-06-15T12:01:00.000Z'; // +60s

    // Push baby at tNow and event with +5m clientUpdatedAt
    const push1 = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: tNow,
            data: {
              id: babyId,
              name: 'Clamp Baby',
              dob: '2026-01-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: userId,
              createdAt: tNow,
              updatedAt: tNow,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: tPlus5m,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: tNow,
              endedAt: tNow,
              payload: { kind: 'wet' },
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: tNow,
              updatedAt: tPlus5m,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(push1.statusCode).toBe(200);

    const pull1 = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie },
    });
    const pull1Body = pull1.json() as {
      events: Array<{ id: string; updatedAt: string; payload: { kind: string } }>;
    };
    expect(pull1Body.events[0]!.updatedAt).toBe(expectedClamped);

    // Advance 60s so serverNow === expectedClamped, then push equal-timestamp update
    vi.advanceTimersByTime(60_000);
    const pushTie = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: expectedClamped,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: tNow,
              endedAt: tNow,
              payload: { kind: 'poopy' },
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: tNow,
              updatedAt: expectedClamped,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushTie.statusCode).toBe(200);

    const pull2 = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie },
    });
    const pull2Body = pull2.json() as {
      events: Array<{ id: string; updatedAt: string; payload: { kind: string } }>;
    };
    expect(pull2Body.events[0]!.payload.kind).toBe('poopy');
  });

  it('syncs vitamin events via push/pull and rejects viewer mutations', async () => {
    const app = await createTestApp();

    const ownerReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'vit-owner@example.com',
        password: 'password123',
        displayName: 'Owner',
      },
    });
    expect(ownerReg.statusCode).toBe(201);
    const ownerCookie = extractCookie(ownerReg);
    const ownerId = (ownerReg.json() as { user: { id: string } }).user.id;

    const viewerReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'vit-viewer@example.com',
        password: 'password123',
        displayName: 'Viewer',
      },
    });
    expect(viewerReg.statusCode).toBe(201);
    const viewerCookie = extractCookie(viewerReg);
    const viewerId = (viewerReg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const vitaminId = crypto.randomUUID();
    const now = '2026-06-15T09:00:00.000Z';

    const pushBabyAndVit = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: ownerCookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Vit Baby',
              dob: '2026-01-01',
              avatarColor: '#059669',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: vitaminId,
              babyId,
              type: 'vitamin',
              startedAt: now,
              endedAt: now,
              payload: {},
              loggedByUserId: ownerId,
              updatedByUserId: ownerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushBabyAndVit.statusCode).toBe(200);
    expect(pushBabyAndVit.json().rejected).toEqual([]);

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: 'viewer' },
    });
    expect(inviteRes.statusCode).toBe(201);
    const inviteCode = (inviteRes.json() as { invite: { code: string } }).invite.code;

    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: viewerCookie },
      payload: { code: inviteCode },
    });
    expect(acceptRes.statusCode).toBe(200);

    const viewerPull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: viewerCookie },
    });
    expect(viewerPull.statusCode).toBe(200);
    const pulledEvents = (viewerPull.json() as { events: Array<{ id: string; type: string }> }).events;
    expect(pulledEvents.some((e) => e.id === vitaminId && e.type === 'vitamin')).toBe(true);

    // Viewer cannot push a vitamin event
    const viewerPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: viewerCookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'vitamin',
              startedAt: now,
              endedAt: now,
              payload: {},
              loggedByUserId: viewerId,
              updatedByUserId: viewerId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(viewerPush.statusCode).toBe(200);
    expect(viewerPush.json().rejected).toHaveLength(1);
  });

  it('syncs pumping and tummy_time events via push/pull and rejects viewer mutations', async () => {
    const app = await createTestApp();

    const ownerReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'pump-owner@example.com',
        password: 'password123',
        displayName: 'Owner',
      },
    });
    expect(ownerReg.statusCode).toBe(201);
    const ownerCookie = extractCookie(ownerReg);
    const ownerId = (ownerReg.json() as { user: { id: string } }).user.id;

    const viewerReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'pump-viewer@example.com',
        password: 'password123',
        displayName: 'Viewer',
      },
    });
    expect(viewerReg.statusCode).toBe(201);
    const viewerCookie = extractCookie(viewerReg);
    const viewerId = (viewerReg.json() as { user: { id: string } }).user.id;

    const babyId = crypto.randomUUID();
    const pumpingId = crypto.randomUUID();
    const tummyId = crypto.randomUUID();
    const t1 = '2026-06-15T10:00:00.000Z';
    const t2 = '2026-06-15T10:15:00.000Z';

    const pushRes = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: ownerCookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: babyId,
              name: 'Pump Baby',
              dob: '2026-01-01',
              avatarColor: '#9333ea',
              isArchived: false,
              createdByUserId: ownerId,
              createdAt: t1,
              updatedAt: t1,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: pumpingId,
              babyId,
              type: 'pumping',
              startedAt: t1,
              endedAt: t2,
              notes: 'Morning pump',
              payload: {
                side: 'both',
                volumeMl: 120,
                leftVolumeMl: 60,
                rightVolumeMl: 60,
              },
              loggedByUserId: ownerId,
              updatedByUserId: ownerId,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: tummyId,
              babyId,
              type: 'tummy_time',
              startedAt: t1,
              endedAt: t2,
              notes: 'Mat play',
              payload: { mood: 'happy' },
              loggedByUserId: ownerId,
              updatedByUserId: ownerId,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushRes.statusCode).toBe(200);
    expect(pushRes.json().rejected).toEqual([]);

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: 'viewer' },
    });
    expect(inviteRes.statusCode).toBe(201);
    const inviteCode = (inviteRes.json() as { invite: { code: string } }).invite.code;

    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: viewerCookie },
      payload: { code: inviteCode },
    });
    expect(acceptRes.statusCode).toBe(200);

    const viewerPull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: viewerCookie },
    });
    expect(viewerPull.statusCode).toBe(200);
    const pulledEvents = (
      viewerPull.json() as { events: Array<{ id: string; type: string }> }
    ).events;
    expect(
      pulledEvents.some((e) => e.id === pumpingId && e.type === 'pumping'),
    ).toBe(false);
    expect(
      pulledEvents.some((e) => e.id === tummyId && e.type === 'tummy_time'),
    ).toBe(true);

    const viewerPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: viewerCookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'pumping',
              startedAt: t1,
              endedAt: t2,
              payload: { side: 'left', volumeMl: 40 },
              loggedByUserId: viewerId,
              updatedByUserId: viewerId,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'tummy_time',
              startedAt: t1,
              endedAt: t2,
              payload: { mood: 'fussy' },
              loggedByUserId: viewerId,
              updatedByUserId: viewerId,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(viewerPush.statusCode).toBe(200);
    expect(viewerPush.json().rejected).toHaveLength(2);
  });

  it('sets appropriate Cache-Control headers for SW, HTML, manifest, and hashed assets', async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-static-'));
    tempDirs.push(staticDir);
    fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(staticDir, 'sw.js'), '// sw');
    fs.writeFileSync(path.join(staticDir, 'registerSW.js'), '// register');
    fs.writeFileSync(path.join(staticDir, 'manifest.webmanifest'), '{}');
    fs.writeFileSync(
      path.join(staticDir, 'assets', 'index-abc123.js'),
      'console.log(1);',
    );

    const app = await createTestApp(staticDir);

    const swRes = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(swRes.statusCode).toBe(200);
    expect(swRes.headers['cache-control']).toBe(
      'no-cache, no-store, must-revalidate',
    );

    const regSwRes = await app.inject({
      method: 'GET',
      url: '/registerSW.js',
    });
    expect(regSwRes.statusCode).toBe(200);
    expect(regSwRes.headers['cache-control']).toBe(
      'no-cache, no-store, must-revalidate',
    );

    const indexRes = await app.inject({ method: 'GET', url: '/index.html' });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.headers['cache-control']).toBe('no-cache');

    const spaFallbackRes = await app.inject({
      method: 'GET',
      url: '/timeline',
    });
    expect(spaFallbackRes.statusCode).toBe(200);
    expect(spaFallbackRes.headers['cache-control']).toBe('no-cache');

    const manifestRes = await app.inject({
      method: 'GET',
      url: '/manifest.webmanifest',
    });
    expect(manifestRes.statusCode).toBe(200);
    expect(manifestRes.headers['cache-control']).toBe('no-cache');

    const assetRes = await app.inject({
      method: 'GET',
      url: '/assets/index-abc123.js',
    });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('enforces pumping RBAC on push (upsert/delete/type-change) and pull, and backfills pumping on promotion to parent', async () => {
    const app = await createTestApp();

    const regParent = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'pump-parent@example.com',
        password: 'password123',
        displayName: 'Parent',
      },
    });
    const parentCookie = extractCookie(regParent);
    const parentId = (regParent.json() as { user: { id: string } }).user.id;

    const regCg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'pump-cg@example.com',
        password: 'password123',
        displayName: 'Caregiver',
      },
    });
    const cgCookie = extractCookie(regCg);
    const cgId = (regCg.json() as { user: { id: string } }).user.id;

    const regViewer = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'pump-viewer@example.com',
        password: 'password123',
        displayName: 'Viewer',
      },
    });
    const viewerCookie = extractCookie(regViewer);

    const babyId = crypto.randomUUID();
    const pumpingId = crypto.randomUUID();
    const bottleId = crypto.randomUUID();
    const t1 = '2026-06-01T10:00:00.000Z';
    const t2 = '2026-06-01T10:15:00.000Z';
    const t3 = '2026-06-01T10:30:00.000Z';

    // Parent creates baby + pumping event + bottle event
    const parentPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: parentCookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: babyId,
              name: 'Pumping RBAC Baby',
              dob: '2026-01-01',
              avatarColor: '#ec4899',
              isArchived: false,
              createdByUserId: parentId,
              createdAt: t1,
              updatedAt: t1,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: pumpingId,
              babyId,
              type: 'pumping',
              startedAt: t1,
              endedAt: t2,
              payload: { side: 'both', volumeMl: 120 },
              loggedByUserId: parentId,
              updatedByUserId: parentId,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: bottleId,
              babyId,
              type: 'bottle_feed',
              startedAt: t1,
              endedAt: t2,
              payload: { volumeMl: 90, milkType: 'breastmilk' },
              loggedByUserId: parentId,
              updatedByUserId: parentId,
              createdAt: t1,
              updatedAt: t2,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(parentPush.statusCode).toBe(200);
    expect(parentPush.json().rejected).toEqual([]);

    // Invite caregiver and viewer
    const cgInv = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: parentCookie },
      payload: { role: 'caregiver' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cgCookie },
      payload: { code: (cgInv.json() as { invite: { code: string } }).invite.code },
    });

    const viewerInv = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: parentCookie },
      payload: { role: 'viewer' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: viewerCookie },
      payload: { code: (viewerInv.json() as { invite: { code: string } }).invite.code },
    });

    // Caregiver pulls -> sees bottle_feed, does NOT see pumping
    const cgPull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: cgCookie },
    });
    expect(cgPull.statusCode).toBe(200);
    const cgPullBody = cgPull.json() as {
      events: Array<{ id: string; type: string }>;
      latestSeq: number;
    };
    expect(cgPullBody.events.some((e) => e.id === bottleId)).toBe(true);
    expect(cgPullBody.events.some((e) => e.type === 'pumping')).toBe(false);

    // Viewer pulls -> sees bottle_feed, does NOT see pumping
    const viewerPull = await app.inject({
      method: 'GET',
      url: '/api/sync/pull?since_seq=0',
      headers: { cookie: viewerCookie },
    });
    expect(viewerPull.statusCode).toBe(200);
    const viewerEvents = (viewerPull.json() as { events: Array<{ id: string; type: string }> }).events;
    expect(viewerEvents.some((e) => e.id === bottleId)).toBe(true);
    expect(viewerEvents.some((e) => e.type === 'pumping')).toBe(false);

    // Caregiver attempts: (1) create pumping, (2) edit existing pumping (type-change to bottle),
    // (3) type-change existing bottle to pumping, (4) delete existing pumping, (5) tombstone pumping
    const mCreatePump = crypto.randomUUID();
    const mEditPumpToBottle = crypto.randomUUID();
    const mEditBottleToPump = crypto.randomUUID();
    const mDelPump = crypto.randomUUID();
    const mTombstonePump = crypto.randomUUID();

    const cgBadPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cgCookie },
      payload: {
        mutations: [
          {
            mutationId: mCreatePump,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t3,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'pumping',
              startedAt: t2,
              endedAt: t3,
              payload: { side: 'left', volumeMl: 60 },
              loggedByUserId: cgId,
              updatedByUserId: cgId,
              createdAt: t2,
              updatedAt: t3,
              deletedAt: null,
            },
          },
          {
            mutationId: mEditPumpToBottle,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t3,
            data: {
              id: pumpingId,
              babyId,
              type: 'bottle_feed',
              startedAt: t1,
              endedAt: t2,
              payload: { volumeMl: 120 },
              loggedByUserId: cgId,
              updatedByUserId: cgId,
              createdAt: t1,
              updatedAt: t3,
              deletedAt: null,
            },
          },
          {
            mutationId: mEditBottleToPump,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t3,
            data: {
              id: bottleId,
              babyId,
              type: 'pumping',
              startedAt: t1,
              endedAt: t2,
              payload: { volumeMl: 90 },
              loggedByUserId: cgId,
              updatedByUserId: cgId,
              createdAt: t1,
              updatedAt: t3,
              deletedAt: null,
            },
          },
          {
            mutationId: mDelPump,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: t3,
            data: { id: pumpingId, deletedAt: t3 },
          },
          {
            mutationId: mTombstonePump,
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: t3,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'pumping',
              startedAt: t2,
              endedAt: t3,
              payload: { volumeMl: 30 },
              loggedByUserId: cgId,
              updatedByUserId: cgId,
              createdAt: t2,
              updatedAt: t3,
              deletedAt: t3,
            },
          },
        ],
      },
    });
    expect(cgBadPush.statusCode).toBe(200);
    const cgBadPushBody = cgBadPush.json() as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
    };
    expect(cgBadPushBody.ackedMutationIds).toEqual([]);
    expect(cgBadPushBody.rejected).toHaveLength(5);
    for (const r of cgBadPushBody.rejected) {
      expect(r.reason).toMatch(/parent role required/i);
    }

    // Parent promotes caregiver to parent -> bumping server_seq triggers backfill on next pull!
    const promoteRes = await app.inject({
      method: 'PATCH',
      url: `/api/babies/${babyId}/members/${cgId}`,
      headers: { cookie: parentCookie },
      payload: { role: 'parent' },
    });
    expect(promoteRes.statusCode).toBe(200);
    expect(
      (promoteRes.json() as { member: { role: string } }).member.role,
    ).toBe('parent');

    // Promoted user pulls since seq before promotion -> backfills existing pumping event!
    const cgPullAfterPromo = await app.inject({
      method: 'GET',
      url: `/api/sync/pull?since_seq=${cgPullBody.latestSeq}`,
      headers: { cookie: cgCookie },
    });
    expect(cgPullAfterPromo.statusCode).toBe(200);
    const promoEvents = (
      cgPullAfterPromo.json() as { events: Array<{ id: string; type: string }> }
    ).events;
    expect(
      promoEvents.some((e) => e.id === pumpingId && e.type === 'pumping'),
    ).toBe(true);

    // Promoted parent can now create and delete pumping events
    const newPumpId = crypto.randomUUID();
    const promoPush = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: cgCookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t3,
            data: {
              id: newPumpId,
              babyId,
              type: 'pumping',
              startedAt: t2,
              endedAt: t3,
              payload: { side: 'right', volumeMl: 80 },
              loggedByUserId: cgId,
              updatedByUserId: cgId,
              createdAt: t2,
              updatedAt: t3,
              deletedAt: null,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: t3,
            data: { id: pumpingId, deletedAt: t3 },
          },
        ],
      },
    });
    expect(promoPush.statusCode).toBe(200);
    expect(promoPush.json().rejected).toEqual([]);
    expect(promoPush.json().ackedMutationIds).toHaveLength(2);
  });

  it('enforces member role PATCH ceiling, LAST_PARENT 409, invite ceiling, and DELETE hierarchy', async () => {
    const app = await createTestApp();

    const register = async (email: string, displayName: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'password123', displayName },
      });
      expect(res.statusCode).toBe(201);
      return {
        cookie: extractCookie(res),
        id: (res.json() as { user: { id: string } }).user.id,
      };
    };

    const parent1 = await register('role-p1@example.com', 'Parent 1');
    const cg1 = await register('role-cg1@example.com', 'Caregiver 1');
    const cg2 = await register('role-cg2@example.com', 'Caregiver 2');
    const viewer1 = await register('role-v1@example.com', 'Viewer 1');

    const babyId = crypto.randomUUID();
    const now = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie: parent1.cookie },
      payload: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Hierarchy Baby',
              dob: '2026-02-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: parent1.id,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    // Parent creates caregiver & viewer invites
    const invCg = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: parent1.cookie },
      payload: { role: 'caregiver' },
    });
    expect(invCg.statusCode).toBe(201);
    const cgCode = (invCg.json() as { invite: { code: string } }).invite.code;
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cg1.cookie },
      payload: { code: cgCode },
    });
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: cg2.cookie },
      payload: { code: cgCode },
    });

    const invViewer = await app.inject({
      method: 'POST',
      url: `/api/babies/${babyId}/invites`,
      headers: { cookie: parent1.cookie },
      payload: { role: 'viewer' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: viewer1.cookie },
      payload: { code: (invViewer.json() as { invite: { code: string } }).invite.code },
    });

    // Invite ceiling: caregiver CAN invite caregiver & viewer, CANNOT invite parent
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/babies/${babyId}/invites`,
          headers: { cookie: cg1.cookie },
          payload: { role: 'caregiver' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/babies/${babyId}/invites`,
          headers: { cookie: cg1.cookie },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/babies/${babyId}/invites`,
          headers: { cookie: cg1.cookie },
          payload: { role: 'parent' },
        })
      ).statusCode,
    ).toBe(403);

    // Parent CAN invite parent
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/babies/${babyId}/invites`,
          headers: { cookie: parent1.cookie },
          payload: { role: 'parent' },
        })
      ).statusCode,
    ).toBe(201);

    // Viewer CANNOT invite anyone
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/babies/${babyId}/invites`,
          headers: { cookie: viewer1.cookie },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(403);

    // GET /members shows actual roles to all active members (including viewer)
    const viewerMembersRes = await app.inject({
      method: 'GET',
      url: `/api/babies/${babyId}/members`,
      headers: { cookie: viewer1.cookie },
    });
    expect(viewerMembersRes.statusCode).toBe(200);
    const viewerMembers = (
      viewerMembersRes.json() as { members: Array<{ userId: string; role: string }> }
    ).members;
    expect(viewerMembers.find((m) => m.userId === parent1.id)?.role).toBe('parent');

    // Validation & auth errors on PATCH
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${cg1.id}`,
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${cg1.id}`,
          headers: { cookie: parent1.cookie },
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/not-a-uuid/members/${cg1.id}`,
          headers: { cookie: parent1.cookie },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${crypto.randomUUID()}`,
          headers: { cookie: parent1.cookie },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(404);

    // Viewer gets 403 on PATCH (even on self)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${viewer1.id}`,
          headers: { cookie: viewer1.cookie },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(403);

    // Caregiver CANNOT promote self or others to parent, CANNOT modify parent
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${cg1.id}`,
          headers: { cookie: cg1.cookie },
          payload: { role: 'parent' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${cg2.id}`,
          headers: { cookie: cg1.cookie },
          payload: { role: 'parent' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${parent1.id}`,
          headers: { cookie: cg1.cookie },
          payload: { role: 'caregiver' },
        })
      ).statusCode,
    ).toBe(403);

    // Caregiver CAN demote cg2 to viewer and promote viewer1 to caregiver
    const cgDemoteCg2 = await app.inject({
      method: 'PATCH',
      url: `/api/babies/${babyId}/members/${cg2.id}`,
      headers: { cookie: cg1.cookie },
      payload: { role: 'viewer' },
    });
    expect(cgDemoteCg2.statusCode).toBe(200);
    expect(
      (cgDemoteCg2.json() as { member: { role: string } }).member.role,
    ).toBe('viewer');

    const cgPromoteV1 = await app.inject({
      method: 'PATCH',
      url: `/api/babies/${babyId}/members/${viewer1.id}`,
      headers: { cookie: cg1.cookie },
      payload: { role: 'caregiver' },
    });
    expect(cgPromoteV1.statusCode).toBe(200);
    expect(
      (cgPromoteV1.json() as { member: { role: string } }).member.role,
    ).toBe('caregiver');

    // Caregiver CAN remove cg2 (now viewer), CANNOT remove parent1
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/babies/${babyId}/members/${parent1.id}`,
          headers: { cookie: cg1.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/babies/${babyId}/members/${cg2.id}`,
          headers: { cookie: cg1.cookie },
        })
      ).statusCode,
    ).toBe(200);

    // Last active parent CANNOT self-demote or self-remove -> 409 LAST_PARENT
    const selfDemoteLast = await app.inject({
      method: 'PATCH',
      url: `/api/babies/${babyId}/members/${parent1.id}`,
      headers: { cookie: parent1.cookie },
      payload: { role: 'caregiver' },
    });
    expect(selfDemoteLast.statusCode).toBe(409);
    expect((selfDemoteLast.json() as { code: string }).code).toBe('LAST_PARENT');

    const selfRemoveLast = await app.inject({
      method: 'DELETE',
      url: `/api/babies/${babyId}/members/${parent1.id}`,
      headers: { cookie: parent1.cookie },
    });
    expect(selfRemoveLast.statusCode).toBe(409);
    expect((selfRemoveLast.json() as { code: string }).code).toBe('LAST_PARENT');

    // Once parent1 promotes cg1 to parent, parent1 CAN demote self to caregiver
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/babies/${babyId}/members/${cg1.id}`,
          headers: { cookie: parent1.cookie },
          payload: { role: 'parent' },
        })
      ).statusCode,
    ).toBe(200);

    const selfDemoteNowOk = await app.inject({
      method: 'PATCH',
      url: `/api/babies/${babyId}/members/${parent1.id}`,
      headers: { cookie: parent1.cookie },
      payload: { role: 'caregiver' },
    });
    expect(selfDemoteNowOk.statusCode).toBe(200);
    expect(
      (selfDemoteNowOk.json() as { member: { role: string } }).member.role,
    ).toBe('caregiver');
  });

  it('migrates legacy SQLite DB constraints and converts owner->parent while preserving caregiver/viewer', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-legacy-sqlite-'));
    tempDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'legacy.sqlite');

    const uOwner = crypto.randomUUID();
    const uCg = crypto.randomUUID();
    const uViewer = crypto.randomUUID();
    const babyId = crypto.randomUUID();
    const ts = '2026-01-01T00:00:00.000Z';

    // Seed a database with the OLD schema (owner/caregiver/viewer on baby_members, caregiver/viewer on baby_invites)
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE babies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dob TEXT NOT NULL,
        birth_weight_grams INTEGER,
        avatar_color TEXT NOT NULL,
        notes TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq INTEGER NOT NULL
      );
      CREATE TABLE baby_members (
        id TEXT PRIMARY KEY,
        baby_id TEXT NOT NULL REFERENCES babies(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        display_name TEXT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'caregiver', 'viewer')),
        joined_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq INTEGER NOT NULL,
        UNIQUE(baby_id, user_id)
      );
      CREATE TABLE baby_invites (
        id TEXT PRIMARY KEY,
        baby_id TEXT NOT NULL REFERENCES babies(id),
        code TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('caregiver', 'viewer')),
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sync_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        val INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sync_seq (id, val) VALUES (1, 10);
    `);
    legacyDb
      .prepare(
        'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(uOwner, 'owner@legacy.test', 'Legacy Owner', 'hash', ts);
    legacyDb
      .prepare(
        'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(uCg, 'cg@legacy.test', 'Legacy CG', 'hash', ts);
    legacyDb
      .prepare(
        'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(uViewer, 'viewer@legacy.test', 'Legacy Viewer', 'hash', ts);
    legacyDb
      .prepare(
        `INSERT INTO babies (id, name, dob, avatar_color, is_archived, created_by_user_id, created_at, updated_at, server_seq)
         VALUES (?, 'Legacy Baby', '2026-01-01', '#6366f1', 0, ?, ?, ?, 1)`,
      )
      .run(babyId, uOwner, ts, ts);
    legacyDb
      .prepare(
        `INSERT INTO baby_members (id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq)
         VALUES (?, ?, ?, 'Legacy Owner', 'owner', ?, ?, NULL, 2)`,
      )
      .run(crypto.randomUUID(), babyId, uOwner, ts, ts);
    legacyDb
      .prepare(
        `INSERT INTO baby_members (id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq)
         VALUES (?, ?, ?, 'Legacy CG', 'caregiver', ?, ?, NULL, 3)`,
      )
      .run(crypto.randomUUID(), babyId, uCg, ts, ts);
    legacyDb
      .prepare(
        `INSERT INTO baby_members (id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq)
         VALUES (?, ?, ?, 'Legacy Viewer', 'viewer', ?, ?, NULL, 4)`,
      )
      .run(crypto.randomUUID(), babyId, uViewer, ts, ts);
    legacyDb.close();

    // Open with SqliteStorageAdapter -> runs idempotent migration
    const adapter = new SqliteStorageAdapter(dbPath);
    await adapter.init();
    try {
      const members = await adapter.listBabyMembers(babyId);
      const ownerM = members.find((m) => m.userId === uOwner)!;
      const cgM = members.find((m) => m.userId === uCg)!;
      const viewerM = members.find((m) => m.userId === uViewer)!;

      expect(ownerM.role).toBe('parent');
      expect(ownerM.serverSeq).toBeGreaterThan(10);
      expect(cgM.role).toBe('caregiver');
      expect(cgM.serverSeq).toBe(3);
      expect(viewerM.role).toBe('viewer');
      expect(viewerM.serverSeq).toBe(4);

      // New baby_invites CHECK constraint allows 'parent'
      const parentInvite = await adapter.createInvite({
        id: crypto.randomUUID(),
        babyId,
        code: 'PARENT01',
        role: 'parent',
        createdByUserId: uOwner,
        expiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: ts,
      });
      expect(parentInvite.role).toBe('parent');

      // Backfill promotion helper promotes caregiver to parent and bumps seq
      const promoted = await adapter.promoteUserMembershipsToParent({
        userId: uCg,
        now: '2026-06-01T00:00:00.000Z',
      });
      expect(promoted).toBe(1);
      const cgAfter = await adapter.getActiveMembership(babyId, uCg);
      expect(cgAfter?.role).toBe('parent');
      expect(cgAfter!.serverSeq).toBeGreaterThan(ownerM.serverSeq!);
    } finally {
      await adapter.close();
    }

    // Re-opening a second time is idempotent
    const adapter2 = new SqliteStorageAdapter(dbPath);
    await adapter2.init();
    try {
      const members2 = await adapter2.listBabyMembers(babyId);
      expect(members2.find((m) => m.userId === uOwner)?.role).toBe('parent');
      expect(members2.find((m) => m.userId === uCg)?.role).toBe('parent');
      expect(members2.find((m) => m.userId === uViewer)?.role).toBe('viewer');
    } finally {
      await adapter2.close();
    }
  });
});
