import crypto from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  BabySchema,
  ROLE_RANK,
  TrackingEventSchema,
  canAccessPumping,
  canAssignRole,
  canEditEvents,
  canInviteMembers,
  canManageBaby,
  canManageMember,
  isoDateTimeSchema,
  normalizeBabyRole,
  uuidSchema,
  type Baby,
  type BabyInvitePublic,
  type BabyMember,
  type BabyRole,
  type InviteRole,
  type SyncMutation,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncRejectedMutation,
  type TrackingEvent,
  type User,
} from '@baby-tracker/shared';
import {
  DuplicateEmailError,
  type AcceptInviteResult,
  type RemoveMemberResult,
  type StorageAdapter,
  type UpdateMemberRoleResult,
  type UserRecord,
} from './types.js';

interface PgBabyRow {
  id: string;
  name: string;
  dob: string;
  birth_weight_grams: number | null;
  avatar_color: string;
  notes: string | null;
  is_archived: boolean;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: string | number;
}

interface PgMemberRow {
  id: string;
  baby_id: string;
  user_id: string;
  display_name: string | null;
  role: string;
  joined_at: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: string | number;
}

interface PgEventRow {
  id: string;
  baby_id: string;
  type: TrackingEvent['type'];
  started_at: string;
  ended_at: string | null;
  payload_json: unknown;
  notes: string | null;
  logged_by_user_id: string;
  logged_by_name: string | null;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: string | number;
}

function mapBabyRow(row: PgBabyRow): Baby {
  return {
    id: row.id,
    name: row.name,
    dob: row.dob,
    birthWeightGrams: row.birth_weight_grams,
    avatarColor: row.avatar_color,
    notes: row.notes,
    isArchived: Boolean(row.is_archived),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverSeq: Number(row.server_seq),
  };
}

function mapMemberRow(row: PgMemberRow): BabyMember {
  return {
    id: row.id,
    babyId: row.baby_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: normalizeBabyRole(row.role),
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverSeq: Number(row.server_seq),
  };
}

function mapEventRow(row: PgEventRow): TrackingEvent {
  const payload =
    typeof row.payload_json === 'string'
      ? (JSON.parse(row.payload_json) as unknown)
      : row.payload_json;
  return {
    id: row.id,
    babyId: row.baby_id,
    type: row.type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    payload,
    notes: row.notes,
    loggedByUserId: row.logged_by_user_id,
    loggedByName: row.logged_by_name,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverSeq: Number(row.server_seq),
  } as TrackingEvent;
}

export class PostgresStorageAdapter implements StorageAdapter {
  readonly kind = 'postgres' as const;
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS babies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dob TEXT NOT NULL,
        birth_weight_grams INTEGER,
        avatar_color TEXT NOT NULL,
        notes TEXT,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS baby_members (
        id TEXT PRIMARY KEY,
        baby_id TEXT NOT NULL REFERENCES babies(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        display_name TEXT,
        role TEXT NOT NULL CHECK (role IN ('parent', 'caregiver', 'viewer')),
        joined_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq BIGINT NOT NULL,
        UNIQUE(baby_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS baby_invites (
        id TEXT PRIMARY KEY,
        baby_id TEXT NOT NULL REFERENCES babies(id),
        code TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('parent', 'caregiver', 'viewer')),
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        baby_id TEXT NOT NULL REFERENCES babies(id),
        type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        payload_json JSONB NOT NULL,
        notes TEXT,
        logged_by_user_id TEXT NOT NULL,
        logged_by_name TEXT,
        updated_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_baby_seq ON events(baby_id, server_seq);
      CREATE INDEX IF NOT EXISTS idx_members_user ON baby_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_members_baby_seq ON baby_members(baby_id, server_seq);

      CREATE TABLE IF NOT EXISTS sync_mutations (
        mutation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('acked', 'rejected')),
        reason TEXT,
        server_seq BIGINT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        val BIGINT NOT NULL DEFAULT 0
      );

      INSERT INTO sync_seq (id, val) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    `);

    await this.runInTransaction(async (client) => {
      const memberChecks = await client.query<{
        conname: string;
        def: string;
      }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = 'baby_members'::regclass AND contype = 'c'`,
      );
      const legacyMemberChecks = memberChecks.rows.filter(
        (c) => c.def.includes('role') && !c.def.includes("'parent'"),
      );
      if (legacyMemberChecks.length > 0) {
        for (const c of legacyMemberChecks) {
          const safeName = c.conname.replace(/"/g, '""');
          await client.query(
            `ALTER TABLE baby_members DROP CONSTRAINT IF EXISTS "${safeName}"`,
          );
        }
        const ownerRes = await client.query<{ id: string }>(
          "SELECT id FROM baby_members WHERE role = 'owner'",
        );
        if (ownerRes.rows.length > 0) {
          const seq = await this.nextSeq(client);
          const now = new Date().toISOString();
          await client.query(
            `UPDATE baby_members
             SET role = 'parent', updated_at = $1, server_seq = $2
             WHERE role = 'owner'`,
            [now, seq],
          );
        }
        await client.query(
          `ALTER TABLE baby_members
           ADD CONSTRAINT baby_members_role_check
           CHECK (role IN ('parent', 'caregiver', 'viewer'))`,
        );
      }

      const inviteChecks = await client.query<{
        conname: string;
        def: string;
      }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = 'baby_invites'::regclass AND contype = 'c'`,
      );
      const legacyInviteChecks = inviteChecks.rows.filter(
        (c) => c.def.includes('role') && !c.def.includes("'parent'"),
      );
      if (legacyInviteChecks.length > 0) {
        for (const c of legacyInviteChecks) {
          const safeName = c.conname.replace(/"/g, '""');
          await client.query(
            `ALTER TABLE baby_invites DROP CONSTRAINT IF EXISTS "${safeName}"`,
          );
        }
        await client.query(
          `ALTER TABLE baby_invites
           ADD CONSTRAINT baby_invites_role_check
           CHECK (role IN ('parent', 'caregiver', 'viewer'))`,
        );
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async runInTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async nextSeq(client: PoolClient): Promise<number> {
    const res = await client.query<{ val: string | number }>(
      'UPDATE sync_seq SET val = val + 1 WHERE id = 1 RETURNING val',
    );
    return Number(res.rows[0]?.val ?? 0);
  }

  private async getLatestSeq(client?: PoolClient): Promise<number> {
    const executor = client ?? this.pool;
    const res = await executor.query<{ val: string | number }>(
      'SELECT val FROM sync_seq WHERE id = 1',
    );
    return Number(res.rows[0]?.val ?? 0);
  }

  async createUser(input: {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    createdAt: string;
  }): Promise<User> {
    const normalizedEmail = input.email.trim().toLowerCase();
    try {
      await this.pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.id,
          normalizedEmail,
          input.displayName,
          input.passwordHash,
          input.createdAt,
        ],
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw new DuplicateEmailError(normalizedEmail);
      }
      throw err;
    }

    return {
      id: input.id,
      email: normalizedEmail,
      displayName: input.displayName,
      createdAt: input.createdAt,
    };
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const res = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      password_hash: string;
      created_at: string;
    }>(
      `SELECT id, email, display_name, password_hash, created_at
       FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  async findUserById(id: string): Promise<User | null> {
    const res = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      created_at: string;
    }>(
      `SELECT id, email, display_name, created_at
       FROM users WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  }

  async createInvite(input: {
    id: string;
    babyId: string;
    code: string;
    role: InviteRole;
    createdByUserId: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<BabyInvitePublic> {
    await this.pool.query(
      `INSERT INTO baby_invites (id, baby_id, code, role, created_by_user_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.id,
        input.babyId,
        input.code,
        input.role,
        input.createdByUserId,
        input.expiresAt,
        input.createdAt,
      ],
    );
    return {
      id: input.id,
      babyId: input.babyId,
      code: input.code,
      role: input.role,
      expiresAt: input.expiresAt,
    };
  }

  async acceptInvite(input: {
    code: string;
    userId: string;
    displayName: string;
    memberId: string;
    now: string;
  }): Promise<AcceptInviteResult> {
    return this.runInTransaction(async (client) => {
      const inviteRes = await client.query<{
        id: string;
        baby_id: string;
        code: string;
        role: InviteRole;
        expires_at: string;
      }>(
        `SELECT id, baby_id, code, role, expires_at
         FROM baby_invites WHERE code = $1`,
        [input.code],
      );
      const invite = inviteRes.rows[0];
      if (!invite) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      if (Date.parse(invite.expires_at) <= Date.parse(input.now)) {
        return { ok: false, error: 'EXPIRED' };
      }

      const babyRes = await client.query<PgBabyRow>(
        'SELECT * FROM babies WHERE id = $1 AND deleted_at IS NULL',
        [invite.baby_id],
      );
      const babyRow = babyRes.rows[0];
      if (!babyRow) {
        return { ok: false, error: 'BABY_NOT_FOUND' };
      }

      const seq = await this.nextSeq(client);

      const existingRes = await client.query<PgMemberRow>(
        'SELECT * FROM baby_members WHERE baby_id = $1 AND user_id = $2',
        [invite.baby_id, input.userId],
      );
      const existingMember = existingRes.rows[0];

      let memberRow: PgMemberRow;
      if (existingMember) {
        const existingRole = normalizeBabyRole(existingMember.role);
        const nextRole =
          existingMember.deleted_at === null &&
          ROLE_RANK[existingRole] > ROLE_RANK[invite.role]
            ? existingRole
            : invite.role;
        const updatedRes = await client.query<PgMemberRow>(
          `UPDATE baby_members
           SET display_name = $1, role = $2, joined_at = $3, updated_at = $4, deleted_at = NULL, server_seq = $5
           WHERE id = $6
           RETURNING *`,
          [
            input.displayName,
            nextRole,
            existingMember.deleted_at === null
              ? existingMember.joined_at
              : input.now,
            input.now,
            seq,
            existingMember.id,
          ],
        );
        memberRow = updatedRes.rows[0]!;
      } else {
        const insertedRes = await client.query<PgMemberRow>(
          `INSERT INTO baby_members (id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
           RETURNING *`,
          [
            input.memberId,
            invite.baby_id,
            input.userId,
            input.displayName,
            invite.role,
            input.now,
            input.now,
            seq,
          ],
        );
        memberRow = insertedRes.rows[0]!;
      }

      return {
        ok: true,
        baby: mapBabyRow(babyRow),
        member: mapMemberRow(memberRow),
      };
    });
  }

  async getActiveMembership(
    babyId: string,
    userId: string,
  ): Promise<BabyMember | null> {
    const res = await this.pool.query<PgMemberRow>(
      `SELECT * FROM baby_members
       WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [babyId, userId],
    );
    const row = res.rows[0];
    return row ? mapMemberRow(row) : null;
  }

  async listBabyMembers(babyId: string): Promise<BabyMember[]> {
    const res = await this.pool.query<PgMemberRow>(
      `SELECT * FROM baby_members
       WHERE baby_id = $1 AND deleted_at IS NULL
       ORDER BY joined_at ASC`,
      [babyId],
    );
    return res.rows.map(mapMemberRow);
  }

  async updateBabyMemberRole(input: {
    babyId: string;
    actorUserId: string;
    targetUserId: string;
    role: BabyRole;
    now: string;
  }): Promise<UpdateMemberRoleResult> {
    return this.runInTransaction(async (client) => {
      const actorRes = await client.query<PgMemberRow>(
        `SELECT * FROM baby_members
         WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [input.babyId, input.actorUserId],
      );
      const actor = actorRes.rows[0];
      if (!actor) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const actorRole = normalizeBabyRole(actor.role);
      if (!canAssignRole(actorRole, input.role)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const targetRes = await client.query<PgMemberRow>(
        `SELECT * FROM baby_members
         WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [input.babyId, input.targetUserId],
      );
      const target = targetRes.rows[0];
      if (!target) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      const targetRole = normalizeBabyRole(target.role);
      if (!canManageMember(actorRole, targetRole)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (targetRole === 'parent' && input.role !== 'parent') {
        const parentRes = await client.query<{ id: string }>(
          `SELECT id FROM baby_members
           WHERE baby_id = $1 AND role = 'parent' AND deleted_at IS NULL
           FOR UPDATE`,
          [input.babyId],
        );
        if (parentRes.rows.length <= 1) {
          return { ok: false, error: 'LAST_PARENT' };
        }
      }

      const seq = await this.nextSeq(client);
      const updatedRes = await client.query<PgMemberRow>(
        `UPDATE baby_members
         SET role = $1, updated_at = $2, server_seq = $3
         WHERE id = $4
         RETURNING *`,
        [input.role, input.now, seq, target.id],
      );

      return { ok: true, member: mapMemberRow(updatedRes.rows[0]!) };
    });
  }

  async removeBabyMember(input: {
    babyId: string;
    targetUserId: string;
    actorUserId: string;
    now: string;
  }): Promise<RemoveMemberResult> {
    return this.runInTransaction(async (client) => {
      const actorRes = await client.query<PgMemberRow>(
        `SELECT * FROM baby_members
         WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [input.babyId, input.actorUserId],
      );
      const actor = actorRes.rows[0];
      if (!actor) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const actorRole = normalizeBabyRole(actor.role);
      const isSelf = input.actorUserId === input.targetUserId;
      if (!isSelf && !canInviteMembers(actorRole)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const targetRes = await client.query<PgMemberRow>(
        `SELECT * FROM baby_members
         WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [input.babyId, input.targetUserId],
      );
      const target = targetRes.rows[0];
      if (!target) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      const targetRole = normalizeBabyRole(target.role);
      if (!isSelf && !canManageMember(actorRole, targetRole)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (targetRole === 'parent') {
        const parentRes = await client.query<{ id: string }>(
          `SELECT id FROM baby_members
           WHERE baby_id = $1 AND role = 'parent' AND deleted_at IS NULL
           FOR UPDATE`,
          [input.babyId],
        );
        if (parentRes.rows.length <= 1) {
          return { ok: false, error: 'LAST_PARENT' };
        }
      }

      const seq = await this.nextSeq(client);
      await client.query(
        `UPDATE baby_members
         SET deleted_at = $1, updated_at = $2, server_seq = $3
         WHERE id = $4`,
        [input.now, input.now, seq, target.id],
      );

      return { ok: true };
    });
  }

  async promoteUserMembershipsToParent(input: {
    userId: string;
    now: string;
  }): Promise<number> {
    return this.runInTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT id FROM baby_members
         WHERE user_id = $1 AND deleted_at IS NULL AND role != 'parent'`,
        [input.userId],
      );
      if (res.rows.length === 0) return 0;

      for (const row of res.rows) {
        const seq = await this.nextSeq(client);
        await client.query(
          `UPDATE baby_members
           SET role = 'parent', updated_at = $1, server_seq = $2
           WHERE id = $3`,
          [input.now, seq, row.id],
        );
      }
      return res.rows.length;
    });
  }

  async applySyncMutations(input: {
    userId: string;
    userDisplayName: string;
    mutations: SyncMutation[];
    serverNowIso: string;
  }): Promise<SyncPushResponse> {
    return this.runInTransaction(async (client) => {
      const ackedMutationIds: string[] = [];
      const rejected: SyncRejectedMutation[] = [];
      const serverNowMs = Date.parse(input.serverNowIso);
      const maxAllowedMs = serverNowMs + 60_000;

      for (const mutation of input.mutations) {
        const existingMutRes = await client.query<{
          user_id: string;
          status: 'acked' | 'rejected';
          reason: string | null;
        }>(
          'SELECT user_id, status, reason FROM sync_mutations WHERE mutation_id = $1',
          [mutation.mutationId],
        );
        const existingMut = existingMutRes.rows[0];
        if (existingMut) {
          if (existingMut.user_id !== input.userId) {
            rejected.push({
              mutationId: mutation.mutationId,
              reason: 'Conflict: mutationId belongs to another user',
            });
          } else if (existingMut.status === 'acked') {
            ackedMutationIds.push(mutation.mutationId);
          } else {
            rejected.push({
              mutationId: mutation.mutationId,
              reason: existingMut.reason ?? 'Rejected',
            });
          }
          continue;
        }

        const clientMs = Date.parse(mutation.clientUpdatedAt);
        const effectiveUpdatedAtMs = Math.min(clientMs, maxAllowedMs);
        const effectiveUpdatedAt = new Date(effectiveUpdatedAtMs).toISOString();

        const recordAck = async (seq: number) => {
          await client.query(
            `INSERT INTO sync_mutations (mutation_id, user_id, status, reason, server_seq, created_at)
             VALUES ($1, $2, 'acked', NULL, $3, $4)`,
            [mutation.mutationId, input.userId, seq, input.serverNowIso],
          );
          ackedMutationIds.push(mutation.mutationId);
        };

        const recordReject = async (reason: string) => {
          await client.query(
            `INSERT INTO sync_mutations (mutation_id, user_id, status, reason, server_seq, created_at)
             VALUES ($1, $2, 'rejected', $3, 0, $4)`,
            [mutation.mutationId, input.userId, reason, input.serverNowIso],
          );
          rejected.push({ mutationId: mutation.mutationId, reason });
        };

        if (mutation.entityType === 'baby') {
          if (mutation.op === 'upsert') {
            const parsed = BabySchema.safeParse(mutation.data);
            if (!parsed.success) {
              await recordReject(
                `Invalid baby payload: ${parsed.error.issues[0]?.message ?? 'validation error'}`,
              );
              continue;
            }
            const baby = parsed.data;
            const existingRes = await client.query<PgBabyRow>(
              'SELECT * FROM babies WHERE id = $1',
              [baby.id],
            );
            const existingBaby = existingRes.rows[0];

            if (!existingBaby) {
              const seq = await this.nextSeq(client);
              await client.query(
                `INSERT INTO babies (
                  id, name, dob, birth_weight_grams, avatar_color, notes, is_archived,
                  created_by_user_id, created_at, updated_at, deleted_at, server_seq
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  baby.id,
                  baby.name,
                  baby.dob,
                  baby.birthWeightGrams ?? null,
                  baby.avatarColor,
                  baby.notes ?? null,
                  baby.isArchived,
                  input.userId,
                  baby.createdAt,
                  effectiveUpdatedAt,
                  baby.deletedAt ?? null,
                  seq,
                ],
              );

              await client.query(
                `INSERT INTO baby_members (
                  id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq
                ) VALUES ($1, $2, $3, $4, 'parent', $5, $6, NULL, $7)`,
                [
                  crypto.randomUUID(),
                  baby.id,
                  input.userId,
                  input.userDisplayName,
                  input.serverNowIso,
                  input.serverNowIso,
                  seq,
                ],
              );

              await recordAck(seq);
            } else {
              const memberRes = await client.query<{ role: string }>(
                `SELECT role FROM baby_members
                 WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
                [baby.id, input.userId],
              );
              const member = memberRes.rows[0];
              if (!member || !canManageBaby(normalizeBabyRole(member.role))) {
                await recordReject(
                  'Forbidden: parent role required to modify baby',
                );
                continue;
              }

              const existingUpdatedMs = Date.parse(existingBaby.updated_at);
              if (effectiveUpdatedAtMs < existingUpdatedMs) {
                await recordAck(Number(existingBaby.server_seq));
                continue;
              }

              const seq = await this.nextSeq(client);
              await client.query(
                `UPDATE babies
                 SET name = $1, dob = $2, birth_weight_grams = $3, avatar_color = $4, notes = $5,
                     is_archived = $6, updated_at = $7, deleted_at = $8, server_seq = $9
                 WHERE id = $10`,
                [
                  baby.name,
                  baby.dob,
                  baby.birthWeightGrams ?? null,
                  baby.avatarColor,
                  baby.notes ?? null,
                  baby.isArchived,
                  effectiveUpdatedAt,
                  baby.deletedAt ?? null,
                  seq,
                  baby.id,
                ],
              );
              await recordAck(seq);
            }
          } else {
            const idParsed = uuidSchema.safeParse(mutation.data.id);
            if (!idParsed.success) {
              await recordReject('Invalid baby id for delete');
              continue;
            }
            const babyId = idParsed.data;
            const existingRes = await client.query<PgBabyRow>(
              'SELECT * FROM babies WHERE id = $1',
              [babyId],
            );
            const existingBaby = existingRes.rows[0];
            if (!existingBaby) {
              await recordReject('Baby not found');
              continue;
            }

            const memberRes = await client.query<{ role: string }>(
              `SELECT role FROM baby_members
               WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
              [babyId, input.userId],
            );
            const member = memberRes.rows[0];
            if (!member || !canManageBaby(normalizeBabyRole(member.role))) {
              await recordReject('Forbidden: parent role required to delete baby');
              continue;
            }

            const existingUpdatedMs = Date.parse(existingBaby.updated_at);
            if (effectiveUpdatedAtMs < existingUpdatedMs) {
              await recordAck(Number(existingBaby.server_seq));
              continue;
            }

            const parsedDeletedAt = isoDateTimeSchema.safeParse(
              mutation.data.deletedAt,
            );
            const deletedAt = parsedDeletedAt.success
              ? parsedDeletedAt.data
              : effectiveUpdatedAt;
            const seq = await this.nextSeq(client);
            await client.query(
              `UPDATE babies
               SET deleted_at = $1, updated_at = $2, server_seq = $3
               WHERE id = $4`,
              [deletedAt, effectiveUpdatedAt, seq, babyId],
            );
            await recordAck(seq);
          }
        } else {
          if (mutation.op === 'upsert') {
            const parsed = TrackingEventSchema.safeParse(mutation.data);
            if (!parsed.success) {
              await recordReject(
                `Invalid event payload: ${parsed.error.issues[0]?.message ?? 'validation error'}`,
              );
              continue;
            }
            const evt = parsed.data;

            const memberRes = await client.query<{ role: string }>(
              `SELECT role FROM baby_members
               WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
              [evt.babyId, input.userId],
            );
            const member = memberRes.rows[0];
            if (!member) {
              await recordReject('Forbidden: not an active member of this baby');
              continue;
            }
            const memberRole = normalizeBabyRole(member.role);
            if (!canEditEvents(memberRole)) {
              await recordReject(
                'Forbidden: viewer role cannot mutate events',
              );
              continue;
            }
            if (evt.type === 'pumping' && !canAccessPumping(memberRole)) {
              await recordReject(
                'Forbidden: parent role required to mutate pumping events',
              );
              continue;
            }

            const babyRes = await client.query<{ deleted_at: string | null }>(
              'SELECT deleted_at FROM babies WHERE id = $1',
              [evt.babyId],
            );
            const babyRow = babyRes.rows[0];
            if (!babyRow || babyRow.deleted_at !== null) {
              await recordReject('Forbidden: baby has been deleted');
              continue;
            }

            const existingRes = await client.query<PgEventRow>(
              'SELECT * FROM events WHERE id = $1',
              [evt.id],
            );
            const existingEvt = existingRes.rows[0];

            if (existingEvt) {
              if (existingEvt.baby_id !== evt.babyId) {
                await recordReject(
                  'Forbidden: cannot move event to another baby',
                );
                continue;
              }
              if (
                existingEvt.type === 'pumping' &&
                !canAccessPumping(memberRole)
              ) {
                await recordReject(
                  'Forbidden: parent role required to mutate pumping events',
                );
                continue;
              }
              const existingUpdatedMs = Date.parse(existingEvt.updated_at);
              if (effectiveUpdatedAtMs < existingUpdatedMs) {
                await recordAck(Number(existingEvt.server_seq));
                continue;
              }
            }

            const seq = await this.nextSeq(client);
            const payloadJson = JSON.stringify(evt.payload);

            if (!existingEvt) {
              await client.query(
                `INSERT INTO events (
                  id, baby_id, type, started_at, ended_at, payload_json, notes,
                  logged_by_user_id, logged_by_name, updated_by_user_id,
                  created_at, updated_at, deleted_at, server_seq
                ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
                [
                  evt.id,
                  evt.babyId,
                  evt.type,
                  evt.startedAt,
                  evt.endedAt,
                  payloadJson,
                  evt.notes ?? null,
                  input.userId,
                  evt.loggedByName ?? input.userDisplayName,
                  input.userId,
                  evt.createdAt,
                  effectiveUpdatedAt,
                  evt.deletedAt ?? null,
                  seq,
                ],
              );
            } else {
              await client.query(
                `UPDATE events
                 SET type = $1, started_at = $2, ended_at = $3, payload_json = $4::jsonb, notes = $5,
                     updated_by_user_id = $6, updated_at = $7, deleted_at = $8, server_seq = $9
                 WHERE id = $10`,
                [
                  evt.type,
                  evt.startedAt,
                  evt.endedAt,
                  payloadJson,
                  evt.notes ?? null,
                  input.userId,
                  effectiveUpdatedAt,
                  evt.deletedAt ?? null,
                  seq,
                  evt.id,
                ],
              );
            }
            await recordAck(seq);
          } else {
            const idParsed = uuidSchema.safeParse(mutation.data.id);
            if (!idParsed.success) {
              await recordReject('Invalid event id for delete');
              continue;
            }
            const eventId = idParsed.data;
            const existingRes = await client.query<PgEventRow>(
              'SELECT * FROM events WHERE id = $1',
              [eventId],
            );
            const existingEvt = existingRes.rows[0];

            if (!existingEvt) {
              const parsedFull = TrackingEventSchema.safeParse(mutation.data);
              if (parsedFull.success) {
                const evt = parsedFull.data;
                const memberRes = await client.query<{ role: string }>(
                  `SELECT role FROM baby_members
                   WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
                  [evt.babyId, input.userId],
                );
                const member = memberRes.rows[0];
                if (!member || !canEditEvents(normalizeBabyRole(member.role))) {
                  await recordReject('Forbidden: cannot delete event');
                  continue;
                }
                if (
                  evt.type === 'pumping' &&
                  !canAccessPumping(normalizeBabyRole(member.role))
                ) {
                  await recordReject(
                    'Forbidden: parent role required to delete pumping events',
                  );
                  continue;
                }
                const babyRes = await client.query<{
                  deleted_at: string | null;
                }>('SELECT deleted_at FROM babies WHERE id = $1', [evt.babyId]);
                const babyRow = babyRes.rows[0];
                if (!babyRow || babyRow.deleted_at !== null) {
                  await recordReject('Forbidden: baby has been deleted');
                  continue;
                }
                const seq = await this.nextSeq(client);
                const deletedAt = evt.deletedAt ?? effectiveUpdatedAt;
                await client.query(
                  `INSERT INTO events (
                    id, baby_id, type, started_at, ended_at, payload_json, notes,
                    logged_by_user_id, logged_by_name, updated_by_user_id,
                    created_at, updated_at, deleted_at, server_seq
                  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
                  [
                    evt.id,
                    evt.babyId,
                    evt.type,
                    evt.startedAt,
                    evt.endedAt,
                    JSON.stringify(evt.payload),
                    evt.notes ?? null,
                    input.userId,
                    evt.loggedByName ?? input.userDisplayName,
                    input.userId,
                    evt.createdAt,
                    effectiveUpdatedAt,
                    deletedAt,
                    seq,
                  ],
                );
                await recordAck(seq);
              } else {
                await recordAck(await this.getLatestSeq(client));
              }
              continue;
            }

            const memberRes = await client.query<{ role: string }>(
              `SELECT role FROM baby_members
               WHERE baby_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
              [existingEvt.baby_id, input.userId],
            );
            const member = memberRes.rows[0];
            if (!member || !canEditEvents(normalizeBabyRole(member.role))) {
              await recordReject('Forbidden: cannot delete event');
              continue;
            }
            if (
              existingEvt.type === 'pumping' &&
              !canAccessPumping(normalizeBabyRole(member.role))
            ) {
              await recordReject(
                'Forbidden: parent role required to delete pumping events',
              );
              continue;
            }

            const babyRes = await client.query<{ deleted_at: string | null }>(
              'SELECT deleted_at FROM babies WHERE id = $1',
              [existingEvt.baby_id],
            );
            const babyRow = babyRes.rows[0];
            if (!babyRow || babyRow.deleted_at !== null) {
              await recordReject('Forbidden: baby has been deleted');
              continue;
            }

            const existingUpdatedMs = Date.parse(existingEvt.updated_at);
            if (effectiveUpdatedAtMs < existingUpdatedMs) {
              await recordAck(Number(existingEvt.server_seq));
              continue;
            }

            const parsedDeletedAt = isoDateTimeSchema.safeParse(
              mutation.data.deletedAt,
            );
            const deletedAt = parsedDeletedAt.success
              ? parsedDeletedAt.data
              : effectiveUpdatedAt;
            const seq = await this.nextSeq(client);
            await client.query(
              `UPDATE events
               SET deleted_at = $1, updated_at = $2, updated_by_user_id = $3, server_seq = $4
               WHERE id = $5`,
              [deletedAt, effectiveUpdatedAt, input.userId, seq, eventId],
            );
            await recordAck(seq);
          }
        }
      }

      return {
        ackedMutationIds,
        rejected,
        latestSeq: await this.getLatestSeq(client),
      };
    });
  }

  async pullSince(input: {
    userId: string;
    sinceSeq: number;
  }): Promise<SyncPullResponse> {
    const latestSeq = await this.getLatestSeq();

    const myMembershipsRes = await this.pool.query<PgMemberRow>(
      'SELECT * FROM baby_members WHERE user_id = $1',
      [input.userId],
    );

    const activeBabyIds: string[] = [];
    const activeRoleByBabyId = new Map<string, BabyRole>();
    const newlyJoinedBabyIds = new Set<string>();
    const removedMemberships: BabyMember[] = [];

    for (const m of myMembershipsRes.rows) {
      const seq = Number(m.server_seq);
      if (m.deleted_at === null) {
        activeBabyIds.push(m.baby_id);
        activeRoleByBabyId.set(m.baby_id, normalizeBabyRole(m.role));
        if (seq > input.sinceSeq) {
          newlyJoinedBabyIds.add(m.baby_id);
        }
      } else if (seq > input.sinceSeq) {
        removedMemberships.push(mapMemberRow(m));
      }
    }

    const babies: Baby[] = [];
    const members: BabyMember[] = [...removedMemberships];
    const events: TrackingEvent[] = [];

    for (const babyId of activeBabyIds) {
      const isNew = newlyJoinedBabyIds.has(babyId);
      const allowPumping = canAccessPumping(
        activeRoleByBabyId.get(babyId) ?? 'viewer',
      );

      const babyRes = isNew
        ? await this.pool.query<PgBabyRow>(
            'SELECT * FROM babies WHERE id = $1',
            [babyId],
          )
        : await this.pool.query<PgBabyRow>(
            'SELECT * FROM babies WHERE id = $1 AND server_seq > $2',
            [babyId, input.sinceSeq],
          );
      for (const b of babyRes.rows) {
        babies.push(mapBabyRow(b));
      }

      const memberRes = isNew
        ? await this.pool.query<PgMemberRow>(
            'SELECT * FROM baby_members WHERE baby_id = $1',
            [babyId],
          )
        : await this.pool.query<PgMemberRow>(
            'SELECT * FROM baby_members WHERE baby_id = $1 AND server_seq > $2',
            [babyId, input.sinceSeq],
          );
      for (const m of memberRes.rows) {
        members.push(mapMemberRow(m));
      }

      const eventRes = isNew
        ? await this.pool.query<PgEventRow>(
            'SELECT * FROM events WHERE baby_id = $1',
            [babyId],
          )
        : await this.pool.query<PgEventRow>(
            'SELECT * FROM events WHERE baby_id = $1 AND server_seq > $2',
            [babyId, input.sinceSeq],
          );
      for (const e of eventRes.rows) {
        if (e.type === 'pumping' && !allowPumping) {
          continue;
        }
        events.push(mapEventRow(e));
      }
    }

    return {
      babies,
      members,
      events,
      latestSeq,
    };
  }
}
