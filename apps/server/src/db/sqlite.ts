import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

interface SqliteBabyRow {
  id: string;
  name: string;
  dob: string;
  birth_weight_grams: number | null;
  avatar_color: string;
  notes: string | null;
  is_archived: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: number;
}

interface SqliteMemberRow {
  id: string;
  baby_id: string;
  user_id: string;
  display_name: string | null;
  role: string;
  joined_at: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: number;
}

interface SqliteEventRow {
  id: string;
  baby_id: string;
  type: TrackingEvent['type'];
  started_at: string;
  ended_at: string | null;
  payload_json: string;
  notes: string | null;
  logged_by_user_id: string;
  logged_by_name: string | null;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  server_seq: number;
}

function mapBabyRow(row: SqliteBabyRow): Baby {
  return {
    id: row.id,
    name: row.name,
    dob: row.dob,
    birthWeightGrams: row.birth_weight_grams,
    avatarColor: row.avatar_color,
    notes: row.notes,
    isArchived: row.is_archived === 1,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverSeq: row.server_seq,
  };
}

function mapMemberRow(row: SqliteMemberRow): BabyMember {
  return {
    id: row.id,
    babyId: row.baby_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: normalizeBabyRole(row.role),
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverSeq: row.server_seq,
  };
}

function mapEventRow(row: SqliteEventRow): TrackingEvent {
  const payload = JSON.parse(row.payload_json) as unknown;
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
    serverSeq: row.server_seq,
  } as TrackingEvent;
}

export class SqliteStorageAdapter implements StorageAdapter {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync | null = null;
  private readonly sqlitePath: string;

  constructor(sqlitePath: string) {
    this.sqlitePath = sqlitePath;
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }
    return this.db;
  }

  async init(): Promise<void> {
    if (this.db) return;

    if (this.sqlitePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(this.sqlitePath)), {
        recursive: true,
      });
    }

    const db = new DatabaseSync(this.sqlitePath);
    if (this.sqlitePath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');

    db.exec(`
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
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq INTEGER NOT NULL
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
        server_seq INTEGER NOT NULL,
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
        payload_json TEXT NOT NULL,
        notes TEXT,
        logged_by_user_id TEXT NOT NULL,
        logged_by_name TEXT,
        updated_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_seq INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_baby_seq ON events(baby_id, server_seq);
      CREATE INDEX IF NOT EXISTS idx_members_user ON baby_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_members_baby_seq ON baby_members(baby_id, server_seq);

      CREATE TABLE IF NOT EXISTS sync_mutations (
        mutation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('acked', 'rejected')),
        reason TEXT,
        server_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        val INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO sync_seq (id, val) VALUES (1, 0);
    `);

    const membersMaster = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'baby_members'",
      )
      .get() as { sql?: string } | undefined;
    if (membersMaster?.sql && !membersMaster.sql.includes("'parent'")) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        db.exec('BEGIN IMMEDIATE');
        const ownerRows = db
          .prepare("SELECT id FROM baby_members WHERE role = 'owner'")
          .all() as Array<{ id: string }>;
        const migratedSeq = ownerRows.length > 0 ? this.nextSeq(db) : null;
        const migratedAt = new Date().toISOString();

        db.exec(`
          CREATE TABLE baby_members_new (
            id TEXT PRIMARY KEY,
            baby_id TEXT NOT NULL REFERENCES babies(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            display_name TEXT,
            role TEXT NOT NULL CHECK (role IN ('parent', 'caregiver', 'viewer')),
            joined_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            server_seq INTEGER NOT NULL,
            UNIQUE(baby_id, user_id)
          );
        `);

        if (migratedSeq !== null) {
          db.prepare(
            `INSERT INTO baby_members_new (
               id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq
             )
             SELECT
               id,
               baby_id,
               user_id,
               display_name,
               CASE WHEN role = 'owner' THEN 'parent' ELSE role END,
               joined_at,
               CASE WHEN role = 'owner' THEN ? ELSE updated_at END,
               deleted_at,
               CASE WHEN role = 'owner' THEN ? ELSE server_seq END
             FROM baby_members`,
          ).run(migratedAt, migratedSeq);
        } else {
          db.exec(`
            INSERT INTO baby_members_new (
              id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq
            )
            SELECT
              id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq
            FROM baby_members;
          `);
        }

        db.exec(`
          DROP TABLE baby_members;
          ALTER TABLE baby_members_new RENAME TO baby_members;
          CREATE INDEX IF NOT EXISTS idx_members_user ON baby_members(user_id);
          CREATE INDEX IF NOT EXISTS idx_members_baby_seq ON baby_members(baby_id, server_seq);
        `);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    }

    const invitesMaster = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'baby_invites'",
      )
      .get() as { sql?: string } | undefined;
    if (invitesMaster?.sql && !invitesMaster.sql.includes("'parent'")) {
      db.exec('PRAGMA foreign_keys = OFF;');
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(`
          CREATE TABLE baby_invites_new (
            id TEXT PRIMARY KEY,
            baby_id TEXT NOT NULL REFERENCES babies(id),
            code TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK (role IN ('parent', 'caregiver', 'viewer')),
            created_by_user_id TEXT NOT NULL REFERENCES users(id),
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          INSERT INTO baby_invites_new (
            id, baby_id, code, role, created_by_user_id, expires_at, created_at
          )
          SELECT
            id, baby_id, code, role, created_by_user_id, expires_at, created_at
          FROM baby_invites;

          DROP TABLE baby_invites;
          ALTER TABLE baby_invites_new RENAME TO baby_invites;
        `);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    }

    this.db = db;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private runInTransaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  private nextSeq(db: DatabaseSync): number {
    db.prepare('UPDATE sync_seq SET val = val + 1 WHERE id = 1').run();
    const row = db
      .prepare('SELECT val FROM sync_seq WHERE id = 1')
      .get() as { val: number };
    return row.val;
  }

  private getLatestSeq(db: DatabaseSync): number {
    const row = db
      .prepare('SELECT val FROM sync_seq WHERE id = 1')
      .get() as { val: number } | undefined;
    return row?.val ?? 0;
  }

  async createUser(input: {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    createdAt: string;
  }): Promise<User> {
    const db = this.getDb();
    const normalizedEmail = input.email.trim().toLowerCase();
    try {
      db.prepare(
        `INSERT INTO users (id, email, display_name, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        normalizedEmail,
        input.displayName,
        input.passwordHash,
        input.createdAt,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE') || message.includes('constraint')) {
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
    const db = this.getDb();
    const normalizedEmail = email.trim().toLowerCase();
    const row = db
      .prepare(
        `SELECT id, email, display_name, password_hash, created_at
         FROM users WHERE email = ?`,
      )
      .get(normalizedEmail) as
      | {
          id: string;
          email: string;
          display_name: string;
          password_hash: string;
          created_at: string;
        }
      | undefined;

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
    const db = this.getDb();
    const row = db
      .prepare(
        `SELECT id, email, display_name, created_at
         FROM users WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          email: string;
          display_name: string;
          created_at: string;
        }
      | undefined;

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
    const db = this.getDb();
    db.prepare(
      `INSERT INTO baby_invites (id, baby_id, code, role, created_by_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.babyId,
      input.code,
      input.role,
      input.createdByUserId,
      input.expiresAt,
      input.createdAt,
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
    return this.runInTransaction((db) => {
      const invite = db
        .prepare(
          `SELECT id, baby_id, code, role, expires_at
           FROM baby_invites WHERE code = ?`,
        )
        .get(input.code) as
        | {
            id: string;
            baby_id: string;
            code: string;
            role: InviteRole;
            expires_at: string;
          }
        | undefined;

      if (!invite) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      if (Date.parse(invite.expires_at) <= Date.parse(input.now)) {
        return { ok: false, error: 'EXPIRED' };
      }

      const babyRow = db
        .prepare('SELECT * FROM babies WHERE id = ? AND deleted_at IS NULL')
        .get(invite.baby_id) as SqliteBabyRow | undefined;

      if (!babyRow) {
        return { ok: false, error: 'BABY_NOT_FOUND' };
      }

      const seq = this.nextSeq(db);

      const existingMember = db
        .prepare(
          'SELECT * FROM baby_members WHERE baby_id = ? AND user_id = ?',
        )
        .get(invite.baby_id, input.userId) as SqliteMemberRow | undefined;

      let memberRow: SqliteMemberRow;
      if (existingMember) {
        // Keep existing role if already an active member with a strictly higher role
        const existingRole = normalizeBabyRole(existingMember.role);
        const nextRole =
          existingMember.deleted_at === null &&
          ROLE_RANK[existingRole] > ROLE_RANK[invite.role]
            ? existingRole
            : invite.role;
        db.prepare(
          `UPDATE baby_members
           SET display_name = ?, role = ?, joined_at = ?, updated_at = ?, deleted_at = NULL, server_seq = ?
           WHERE id = ?`,
        ).run(
          input.displayName,
          nextRole,
          existingMember.deleted_at === null ? existingMember.joined_at : input.now,
          input.now,
          seq,
          existingMember.id,
        );
        memberRow = db
          .prepare('SELECT * FROM baby_members WHERE id = ?')
          .get(existingMember.id) as unknown as SqliteMemberRow;
      } else {
        db.prepare(
          `INSERT INTO baby_members (id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(
          input.memberId,
          invite.baby_id,
          input.userId,
          input.displayName,
          invite.role,
          input.now,
          input.now,
          seq,
        );
        memberRow = db
          .prepare('SELECT * FROM baby_members WHERE id = ?')
          .get(input.memberId) as unknown as SqliteMemberRow;
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
    const db = this.getDb();
    const row = db
      .prepare(
        `SELECT * FROM baby_members
         WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(babyId, userId) as SqliteMemberRow | undefined;
    return row ? mapMemberRow(row) : null;
  }

  async listBabyMembers(babyId: string): Promise<BabyMember[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM baby_members
         WHERE baby_id = ? AND deleted_at IS NULL
         ORDER BY joined_at ASC`,
      )
      .all(babyId) as unknown as SqliteMemberRow[];
    return rows.map(mapMemberRow);
  }

  async updateBabyMemberRole(input: {
    babyId: string;
    actorUserId: string;
    targetUserId: string;
    role: BabyRole;
    now: string;
  }): Promise<UpdateMemberRoleResult> {
    return this.runInTransaction((db) => {
      const actor = db
        .prepare(
          `SELECT * FROM baby_members
           WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .get(input.babyId, input.actorUserId) as SqliteMemberRow | undefined;

      if (!actor) {
        return { ok: false, error: 'FORBIDDEN' };
      }
      const actorRole = normalizeBabyRole(actor.role);
      if (!canAssignRole(actorRole, input.role)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const target = db
        .prepare(
          `SELECT * FROM baby_members
           WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .get(input.babyId, input.targetUserId) as SqliteMemberRow | undefined;

      if (!target) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      const targetRole = normalizeBabyRole(target.role);
      if (!canManageMember(actorRole, targetRole)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (targetRole === 'parent' && input.role !== 'parent') {
        const parentCountRow = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM baby_members
             WHERE baby_id = ? AND role = 'parent' AND deleted_at IS NULL`,
          )
          .get(input.babyId) as { cnt: number };
        if (parentCountRow.cnt <= 1) {
          return { ok: false, error: 'LAST_PARENT' };
        }
      }

      const seq = this.nextSeq(db);
      db.prepare(
        `UPDATE baby_members
         SET role = ?, updated_at = ?, server_seq = ?
         WHERE id = ?`,
      ).run(input.role, input.now, seq, target.id);

      const updated = db
        .prepare('SELECT * FROM baby_members WHERE id = ?')
        .get(target.id) as unknown as SqliteMemberRow;

      return { ok: true, member: mapMemberRow(updated) };
    });
  }

  async removeBabyMember(input: {
    babyId: string;
    targetUserId: string;
    actorUserId: string;
    now: string;
  }): Promise<RemoveMemberResult> {
    return this.runInTransaction((db) => {
      const actor = db
        .prepare(
          `SELECT * FROM baby_members
           WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .get(input.babyId, input.actorUserId) as SqliteMemberRow | undefined;

      if (!actor) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const actorRole = normalizeBabyRole(actor.role);
      const isSelf = input.actorUserId === input.targetUserId;
      if (!isSelf && !canInviteMembers(actorRole)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const target = db
        .prepare(
          `SELECT * FROM baby_members
           WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .get(input.babyId, input.targetUserId) as SqliteMemberRow | undefined;

      if (!target) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      const targetRole = normalizeBabyRole(target.role);
      if (!isSelf && !canManageMember(actorRole, targetRole)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (targetRole === 'parent') {
        const parentCountRow = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM baby_members
             WHERE baby_id = ? AND role = 'parent' AND deleted_at IS NULL`,
          )
          .get(input.babyId) as { cnt: number };
        if (parentCountRow.cnt <= 1) {
          return { ok: false, error: 'LAST_PARENT' };
        }
      }

      const seq = this.nextSeq(db);
      db.prepare(
        `UPDATE baby_members
         SET deleted_at = ?, updated_at = ?, server_seq = ?
         WHERE id = ?`,
      ).run(input.now, input.now, seq, target.id);

      return { ok: true };
    });
  }

  async promoteUserMembershipsToParent(input: {
    userId: string;
    now: string;
  }): Promise<number> {
    return this.runInTransaction((db) => {
      const rows = db
        .prepare(
          `SELECT id FROM baby_members
           WHERE user_id = ? AND deleted_at IS NULL AND role != 'parent'`,
        )
        .all(input.userId) as Array<{ id: string }>;

      if (rows.length === 0) return 0;

      const stmt = db.prepare(
        `UPDATE baby_members
         SET role = 'parent', updated_at = ?, server_seq = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        const seq = this.nextSeq(db);
        stmt.run(input.now, seq, row.id);
      }
      return rows.length;
    });
  }

  async applySyncMutations(input: {
    userId: string;
    userDisplayName: string;
    mutations: SyncMutation[];
    serverNowIso: string;
  }): Promise<SyncPushResponse> {
    return this.runInTransaction((db) => {
      const ackedMutationIds: string[] = [];
      const rejected: SyncRejectedMutation[] = [];
      const serverNowMs = Date.parse(input.serverNowIso);
      const maxAllowedMs = serverNowMs + 60_000;

      for (const mutation of input.mutations) {
        // 1. Idempotency check
        const existingMut = db
          .prepare(
            'SELECT user_id, status, reason FROM sync_mutations WHERE mutation_id = ?',
          )
          .get(mutation.mutationId) as
          | {
              user_id: string;
              status: 'acked' | 'rejected';
              reason: string | null;
            }
          | undefined;

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

        const recordAck = (seq: number) => {
          db.prepare(
            `INSERT INTO sync_mutations (mutation_id, user_id, status, reason, server_seq, created_at)
             VALUES (?, ?, 'acked', NULL, ?, ?)`,
          ).run(mutation.mutationId, input.userId, seq, input.serverNowIso);
          ackedMutationIds.push(mutation.mutationId);
        };

        const recordReject = (reason: string) => {
          db.prepare(
            `INSERT INTO sync_mutations (mutation_id, user_id, status, reason, server_seq, created_at)
             VALUES (?, ?, 'rejected', ?, 0, ?)`,
          ).run(mutation.mutationId, input.userId, reason, input.serverNowIso);
          rejected.push({ mutationId: mutation.mutationId, reason });
        };

        if (mutation.entityType === 'baby') {
          if (mutation.op === 'upsert') {
            const parsed = BabySchema.safeParse(mutation.data);
            if (!parsed.success) {
              recordReject(`Invalid baby payload: ${parsed.error.issues[0]?.message ?? 'validation error'}`);
              continue;
            }
            const baby = parsed.data;
            const existingBaby = db
              .prepare('SELECT * FROM babies WHERE id = ?')
              .get(baby.id) as SqliteBabyRow | undefined;

            if (!existingBaby) {
              const seq = this.nextSeq(db);
              db.prepare(
                `INSERT INTO babies (
                  id, name, dob, birth_weight_grams, avatar_color, notes, is_archived,
                  created_by_user_id, created_at, updated_at, deleted_at, server_seq
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                baby.id,
                baby.name,
                baby.dob,
                baby.birthWeightGrams ?? null,
                baby.avatarColor,
                baby.notes ?? null,
                baby.isArchived ? 1 : 0,
                input.userId,
                baby.createdAt,
                effectiveUpdatedAt,
                baby.deletedAt ?? null,
                seq,
              );

              // Auto-create parent membership
              db.prepare(
                `INSERT INTO baby_members (
                  id, baby_id, user_id, display_name, role, joined_at, updated_at, deleted_at, server_seq
                ) VALUES (?, ?, ?, ?, 'parent', ?, ?, NULL, ?)`,
              ).run(
                crypto.randomUUID(),
                baby.id,
                input.userId,
                input.userDisplayName,
                input.serverNowIso,
                input.serverNowIso,
                seq,
              );

              recordAck(seq);
            } else {
              const member = db
                .prepare(
                  `SELECT role FROM baby_members
                   WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
                )
                .get(baby.id, input.userId) as { role: string } | undefined;

              if (!member || !canManageBaby(normalizeBabyRole(member.role))) {
                recordReject('Forbidden: parent role required to modify baby');
                continue;
              }

              const existingUpdatedMs = Date.parse(existingBaby.updated_at);
              if (effectiveUpdatedAtMs < existingUpdatedMs) {
                // Stale LWW write: ack without overwriting newer state
                recordAck(existingBaby.server_seq);
                continue;
              }

              const seq = this.nextSeq(db);
              db.prepare(
                `UPDATE babies
                 SET name = ?, dob = ?, birth_weight_grams = ?, avatar_color = ?, notes = ?,
                     is_archived = ?, updated_at = ?, deleted_at = ?, server_seq = ?
                 WHERE id = ?`,
              ).run(
                baby.name,
                baby.dob,
                baby.birthWeightGrams ?? null,
                baby.avatarColor,
                baby.notes ?? null,
                baby.isArchived ? 1 : 0,
                effectiveUpdatedAt,
                baby.deletedAt ?? null,
                seq,
                baby.id,
              );
              recordAck(seq);
            }
          } else {
            // op === 'delete' for baby
            const rawId = mutation.data.id;
            const idParsed = uuidSchema.safeParse(rawId);
            if (!idParsed.success) {
              recordReject('Invalid baby id for delete');
              continue;
            }
            const babyId = idParsed.data;
            const existingBaby = db
              .prepare('SELECT * FROM babies WHERE id = ?')
              .get(babyId) as SqliteBabyRow | undefined;

            if (!existingBaby) {
              recordReject('Baby not found');
              continue;
            }

            const member = db
              .prepare(
                `SELECT role FROM baby_members
                 WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
              )
              .get(babyId, input.userId) as { role: string } | undefined;

            if (!member || !canManageBaby(normalizeBabyRole(member.role))) {
              recordReject('Forbidden: parent role required to delete baby');
              continue;
            }

            const existingUpdatedMs = Date.parse(existingBaby.updated_at);
            if (effectiveUpdatedAtMs < existingUpdatedMs) {
              recordAck(existingBaby.server_seq);
              continue;
            }

            const parsedDeletedAt = isoDateTimeSchema.safeParse(
              mutation.data.deletedAt,
            );
            const deletedAt = parsedDeletedAt.success
              ? parsedDeletedAt.data
              : effectiveUpdatedAt;
            const seq = this.nextSeq(db);
            db.prepare(
              `UPDATE babies
               SET deleted_at = ?, updated_at = ?, server_seq = ?
               WHERE id = ?`,
            ).run(deletedAt, effectiveUpdatedAt, seq, babyId);
            recordAck(seq);
          }
        } else {
          // entityType === 'event'
          if (mutation.op === 'upsert') {
            const parsed = TrackingEventSchema.safeParse(mutation.data);
            if (!parsed.success) {
              recordReject(`Invalid event payload: ${parsed.error.issues[0]?.message ?? 'validation error'}`);
              continue;
            }
            const evt = parsed.data;

            const member = db
              .prepare(
                `SELECT role FROM baby_members
                 WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
              )
              .get(evt.babyId, input.userId) as { role: string } | undefined;

            if (!member) {
              recordReject('Forbidden: not an active member of this baby');
              continue;
            }
            const memberRole = normalizeBabyRole(member.role);
            if (!canEditEvents(memberRole)) {
              recordReject('Forbidden: viewer role cannot mutate events');
              continue;
            }
            if (evt.type === 'pumping' && !canAccessPumping(memberRole)) {
              recordReject('Forbidden: parent role required to mutate pumping events');
              continue;
            }

            const babyRow = db
              .prepare('SELECT deleted_at FROM babies WHERE id = ?')
              .get(evt.babyId) as { deleted_at: string | null } | undefined;
            if (!babyRow || babyRow.deleted_at !== null) {
              recordReject('Forbidden: baby has been deleted');
              continue;
            }

            const existingEvt = db
              .prepare('SELECT * FROM events WHERE id = ?')
              .get(evt.id) as SqliteEventRow | undefined;

            if (existingEvt) {
              if (existingEvt.baby_id !== evt.babyId) {
                recordReject('Forbidden: cannot move event to another baby');
                continue;
              }
              if (
                existingEvt.type === 'pumping' &&
                !canAccessPumping(memberRole)
              ) {
                recordReject('Forbidden: parent role required to mutate pumping events');
                continue;
              }
              const existingUpdatedMs = Date.parse(existingEvt.updated_at);
              if (effectiveUpdatedAtMs < existingUpdatedMs) {
                recordAck(existingEvt.server_seq);
                continue;
              }
            }

            const seq = this.nextSeq(db);
            const payloadJson = JSON.stringify(evt.payload);

            if (!existingEvt) {
              db.prepare(
                `INSERT INTO events (
                  id, baby_id, type, started_at, ended_at, payload_json, notes,
                  logged_by_user_id, logged_by_name, updated_by_user_id,
                  created_at, updated_at, deleted_at, server_seq
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(
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
              );
            } else {
              db.prepare(
                `UPDATE events
                 SET type = ?, started_at = ?, ended_at = ?, payload_json = ?, notes = ?,
                     updated_by_user_id = ?, updated_at = ?, deleted_at = ?, server_seq = ?
                 WHERE id = ?`,
              ).run(
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
              );
            }
            recordAck(seq);
          } else {
            // op === 'delete' for event
            const idParsed = uuidSchema.safeParse(mutation.data.id);
            if (!idParsed.success) {
              recordReject('Invalid event id for delete');
              continue;
            }
            const eventId = idParsed.data;
            const existingEvt = db
              .prepare('SELECT * FROM events WHERE id = ?')
              .get(eventId) as SqliteEventRow | undefined;

            if (!existingEvt) {
              // If full event was sent, validate & store tombstone; otherwise ack idempotently
              const parsedFull = TrackingEventSchema.safeParse(mutation.data);
              if (parsedFull.success) {
                const evt = parsedFull.data;
                const member = db
                  .prepare(
                    `SELECT role FROM baby_members
                     WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
                  )
                  .get(evt.babyId, input.userId) as { role: string } | undefined;
                if (!member || !canEditEvents(normalizeBabyRole(member.role))) {
                  recordReject('Forbidden: cannot delete event');
                  continue;
                }
                if (
                  evt.type === 'pumping' &&
                  !canAccessPumping(normalizeBabyRole(member.role))
                ) {
                  recordReject('Forbidden: parent role required to delete pumping events');
                  continue;
                }
                const babyRow = db
                  .prepare('SELECT deleted_at FROM babies WHERE id = ?')
                  .get(evt.babyId) as { deleted_at: string | null } | undefined;
                if (!babyRow || babyRow.deleted_at !== null) {
                  recordReject('Forbidden: baby has been deleted');
                  continue;
                }
                const seq = this.nextSeq(db);
                const deletedAt = evt.deletedAt ?? effectiveUpdatedAt;
                db.prepare(
                  `INSERT INTO events (
                    id, baby_id, type, started_at, ended_at, payload_json, notes,
                    logged_by_user_id, logged_by_name, updated_by_user_id,
                    created_at, updated_at, deleted_at, server_seq
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ).run(
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
                );
                recordAck(seq);
              } else {
                recordAck(this.getLatestSeq(db));
              }
              continue;
            }

            const member = db
              .prepare(
                `SELECT role FROM baby_members
                 WHERE baby_id = ? AND user_id = ? AND deleted_at IS NULL`,
              )
              .get(existingEvt.baby_id, input.userId) as
              | { role: string }
              | undefined;

            if (!member || !canEditEvents(normalizeBabyRole(member.role))) {
              recordReject('Forbidden: cannot delete event');
              continue;
            }
            if (
              existingEvt.type === 'pumping' &&
              !canAccessPumping(normalizeBabyRole(member.role))
            ) {
              recordReject('Forbidden: parent role required to delete pumping events');
              continue;
            }

            const babyRow = db
              .prepare('SELECT deleted_at FROM babies WHERE id = ?')
              .get(existingEvt.baby_id) as { deleted_at: string | null } | undefined;
            if (!babyRow || babyRow.deleted_at !== null) {
              recordReject('Forbidden: baby has been deleted');
              continue;
            }

            const existingUpdatedMs = Date.parse(existingEvt.updated_at);
            if (effectiveUpdatedAtMs < existingUpdatedMs) {
              recordAck(existingEvt.server_seq);
              continue;
            }

            const parsedDeletedAt = isoDateTimeSchema.safeParse(
              mutation.data.deletedAt,
            );
            const deletedAt = parsedDeletedAt.success
              ? parsedDeletedAt.data
              : effectiveUpdatedAt;
            const seq = this.nextSeq(db);
            db.prepare(
              `UPDATE events
               SET deleted_at = ?, updated_at = ?, updated_by_user_id = ?, server_seq = ?
               WHERE id = ?`,
            ).run(deletedAt, effectiveUpdatedAt, input.userId, seq, eventId);
            recordAck(seq);
          }
        }
      }

      return {
        ackedMutationIds,
        rejected,
        latestSeq: this.getLatestSeq(db),
      };
    });
  }

  async pullSince(input: {
    userId: string;
    sinceSeq: number;
  }): Promise<SyncPullResponse> {
    const db = this.getDb();
    const latestSeq = this.getLatestSeq(db);

    const myMemberships = db
      .prepare('SELECT * FROM baby_members WHERE user_id = ?')
      .all(input.userId) as unknown as SqliteMemberRow[];

    const activeBabyIds: string[] = [];
    const activeRoleByBabyId = new Map<string, BabyRole>();
    const newlyJoinedBabyIds = new Set<string>();
    const removedMemberships: BabyMember[] = [];

    for (const m of myMemberships) {
      if (m.deleted_at === null) {
        activeBabyIds.push(m.baby_id);
        activeRoleByBabyId.set(m.baby_id, normalizeBabyRole(m.role));
        if (m.server_seq > input.sinceSeq) {
          newlyJoinedBabyIds.add(m.baby_id);
        }
      } else if (m.server_seq > input.sinceSeq) {
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

      const babyRows = (
        isNew
          ? db.prepare('SELECT * FROM babies WHERE id = ?').all(babyId)
          : db
              .prepare('SELECT * FROM babies WHERE id = ? AND server_seq > ?')
              .all(babyId, input.sinceSeq)
      ) as unknown as SqliteBabyRow[];
      for (const b of babyRows) {
        babies.push(mapBabyRow(b));
      }

      const memberRows = (
        isNew
          ? db
              .prepare('SELECT * FROM baby_members WHERE baby_id = ?')
              .all(babyId)
          : db
              .prepare(
                'SELECT * FROM baby_members WHERE baby_id = ? AND server_seq > ?',
              )
              .all(babyId, input.sinceSeq)
      ) as unknown as SqliteMemberRow[];
      for (const m of memberRows) {
        members.push(mapMemberRow(m));
      }

      const eventRows = (
        isNew
          ? db.prepare('SELECT * FROM events WHERE baby_id = ?').all(babyId)
          : db
              .prepare(
                'SELECT * FROM events WHERE baby_id = ? AND server_seq > ?',
              )
              .all(babyId, input.sinceSeq)
      ) as unknown as SqliteEventRow[];
      for (const e of eventRows) {
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
