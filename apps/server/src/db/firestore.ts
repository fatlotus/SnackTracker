import crypto from 'node:crypto';
import { Firestore, type Transaction } from '@google-cloud/firestore';
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

export interface FirestoreStorageOptions {
  projectId?: string;
  databaseId?: string;
}

interface FirestoreSyncMutationDoc {
  mutationId: string;
  userId: string;
  status: 'acked' | 'rejected';
  reason: string | null;
  serverSeq: number;
  createdAt: string;
}

interface FirestoreInviteDoc {
  id: string;
  babyId: string;
  code: string;
  role: InviteRole;
  createdByUserId: string;
  expiresAt: string;
  createdAt: string;
}

function normalizeMemberDoc(raw: BabyMember): BabyMember {
  return {
    ...raw,
    role: normalizeBabyRole(raw.role),
  };
}

export class FirestoreStorageAdapter implements StorageAdapter {
  readonly kind = 'firestore' as const;
  private db: Firestore | null = null;
  private readonly options: FirestoreStorageOptions;

  constructor(options: FirestoreStorageOptions = {}) {
    this.options = options;
  }

  private getDb(): Firestore {
    if (!this.db) {
      throw new Error('FirestoreStorageAdapter not initialized');
    }
    return this.db;
  }

  private seqDocRef(db: Firestore) {
    return db.collection('sync_meta').doc('seq');
  }

  private memberDocId(babyId: string, userId: string): string {
    return `${babyId}_${userId}`;
  }

  async init(): Promise<void> {
    if (this.db) return;

    const db = new Firestore({
      projectId: this.options.projectId,
      databaseId: this.options.databaseId,
      ignoreUndefinedProperties: true,
    });

    const seqRef = this.seqDocRef(db);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(seqRef);
      if (!snap.exists) {
        tx.set(seqRef, { val: 0 });
      }
    });

    // Idempotent legacy migration: convert role == 'owner' -> 'parent' (leave caregiver/viewer untouched)
    const legacyOwnersSnap = await db
      .collection('baby_members')
      .where('role', '==', 'owner')
      .get();
    if (!legacyOwnersSnap.empty) {
      const migratedAt = new Date().toISOString();
      for (const docSnap of legacyOwnersSnap.docs) {
        await db.runTransaction(async (tx) => {
          const freshSnap = await tx.get(docSnap.ref);
          if (!freshSnap.exists) return;
          const data = freshSnap.data() as { role?: string } | undefined;
          if (data?.role !== 'owner') return;
          const currentSeq = await this.getCurrentSeq(db, tx);
          const seq = this.allocateSeq(db, tx, currentSeq);
          tx.set(
            docSnap.ref,
            {
              role: 'parent',
              updatedAt: migratedAt,
              serverSeq: seq,
            },
            { merge: true },
          );
        });
      }
    }

    this.db = db;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
  }

  private async getCurrentSeq(db: Firestore, tx?: Transaction): Promise<number> {
    const ref = this.seqDocRef(db);
    const snap = tx ? await tx.get(ref) : await ref.get();
    if (!snap.exists) return 0;
    const val = snap.data()?.val;
    return typeof val === 'number' ? val : 0;
  }

  private allocateSeq(
    db: Firestore,
    tx: Transaction,
    currentVal: number,
  ): number {
    const next = currentVal + 1;
    tx.set(this.seqDocRef(db), { val: next }, { merge: true });
    return next;
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
    const emailIndexRef = db
      .collection('users_by_email')
      .doc(encodeURIComponent(normalizedEmail));
    const userRef = db.collection('users').doc(input.id);

    await db.runTransaction(async (tx) => {
      const existingEmailSnap = await tx.get(emailIndexRef);
      if (existingEmailSnap.exists) {
        throw new DuplicateEmailError(normalizedEmail);
      }

      const record: UserRecord = {
        id: input.id,
        email: normalizedEmail,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        createdAt: input.createdAt,
      };
      tx.set(emailIndexRef, { userId: input.id });
      tx.set(userRef, record);
    });

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
    const emailIndexSnap = await db
      .collection('users_by_email')
      .doc(encodeURIComponent(normalizedEmail))
      .get();

    if (!emailIndexSnap.exists) return null;
    const userId = emailIndexSnap.data()?.userId as string | undefined;
    if (!userId) return null;

    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) return null;
    return userSnap.data() as UserRecord;
  }

  async findUserById(id: string): Promise<User | null> {
    const db = this.getDb();
    const userSnap = await db.collection('users').doc(id).get();
    if (!userSnap.exists) return null;
    const data = userSnap.data() as UserRecord;
    return {
      id: data.id,
      email: data.email,
      displayName: data.displayName,
      createdAt: data.createdAt,
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
    const doc: FirestoreInviteDoc = {
      id: input.id,
      babyId: input.babyId,
      code: input.code,
      role: input.role,
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
    };
    await db.collection('baby_invites').doc(input.code).set(doc);

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
    const db = this.getDb();

    return db.runTransaction(async (tx) => {
      const inviteSnap = await tx.get(db.collection('baby_invites').doc(input.code));
      if (!inviteSnap.exists) {
        return { ok: false, error: 'NOT_FOUND' };
      }
      const invite = inviteSnap.data() as FirestoreInviteDoc;

      if (Date.parse(invite.expiresAt) <= Date.parse(input.now)) {
        return { ok: false, error: 'EXPIRED' };
      }

      const babySnap = await tx.get(db.collection('babies').doc(invite.babyId));
      if (!babySnap.exists) {
        return { ok: false, error: 'BABY_NOT_FOUND' };
      }
      const baby = babySnap.data() as Baby;
      if (baby.deletedAt !== null && baby.deletedAt !== undefined) {
        return { ok: false, error: 'BABY_NOT_FOUND' };
      }

      const memberRef = db
        .collection('baby_members')
        .doc(this.memberDocId(invite.babyId, input.userId));
      const existingMemberSnap = await tx.get(memberRef);
      const currentSeq = await this.getCurrentSeq(db, tx);
      const seq = this.allocateSeq(db, tx, currentSeq);

      let member: BabyMember;
      if (existingMemberSnap.exists) {
        const existingMember = existingMemberSnap.data() as BabyMember;
        const existingRole = normalizeBabyRole(existingMember.role);
        const nextRole =
          existingMember.deletedAt === null &&
          ROLE_RANK[existingRole] > ROLE_RANK[invite.role]
            ? existingRole
            : invite.role;
        member = {
          ...existingMember,
          displayName: input.displayName,
          role: nextRole,
          joinedAt:
            existingMember.deletedAt === null
              ? existingMember.joinedAt
              : input.now,
          updatedAt: input.now,
          deletedAt: null,
          serverSeq: seq,
        };
      } else {
        member = {
          id: input.memberId,
          babyId: invite.babyId,
          userId: input.userId,
          displayName: input.displayName,
          role: invite.role,
          joinedAt: input.now,
          updatedAt: input.now,
          deletedAt: null,
          serverSeq: seq,
        };
      }

      tx.set(memberRef, member);

      return {
        ok: true,
        baby,
        member,
      };
    });
  }

  async getActiveMembership(
    babyId: string,
    userId: string,
  ): Promise<BabyMember | null> {
    const db = this.getDb();
    const snap = await db
      .collection('baby_members')
      .doc(this.memberDocId(babyId, userId))
      .get();
    if (!snap.exists) return null;
    const member = normalizeMemberDoc(snap.data() as BabyMember);
    return member.deletedAt === null ? member : null;
  }

  async listBabyMembers(babyId: string): Promise<BabyMember[]> {
    const db = this.getDb();
    const snap = await db
      .collection('baby_members')
      .where('babyId', '==', babyId)
      .get();

    return snap.docs
      .map((d) => normalizeMemberDoc(d.data() as BabyMember))
      .filter((m) => m.deletedAt === null)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  async updateBabyMemberRole(input: {
    babyId: string;
    actorUserId: string;
    targetUserId: string;
    role: BabyRole;
    now: string;
  }): Promise<UpdateMemberRoleResult> {
    const db = this.getDb();

    return db.runTransaction(async (tx) => {
      const actorRef = db
        .collection('baby_members')
        .doc(this.memberDocId(input.babyId, input.actorUserId));
      const targetRef = db
        .collection('baby_members')
        .doc(this.memberDocId(input.babyId, input.targetUserId));
      const babyMembersQuery = db
        .collection('baby_members')
        .where('babyId', '==', input.babyId);

      const [actorSnap, targetSnap, allMembersSnap, currentSeq] =
        await Promise.all([
          tx.get(actorRef),
          tx.get(targetRef),
          tx.get(babyMembersQuery),
          this.getCurrentSeq(db, tx),
        ]);

      const actor = actorSnap.exists
        ? normalizeMemberDoc(actorSnap.data() as BabyMember)
        : null;
      if (!actor || actor.deletedAt !== null) {
        return { ok: false, error: 'FORBIDDEN' };
      }
      if (!canAssignRole(actor.role, input.role)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const target = targetSnap.exists
        ? normalizeMemberDoc(targetSnap.data() as BabyMember)
        : null;
      if (!target || target.deletedAt !== null) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      if (!canManageMember(actor.role, target.role)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (target.role === 'parent' && input.role !== 'parent') {
        const activeParents = allMembersSnap.docs
          .map((d) => normalizeMemberDoc(d.data() as BabyMember))
          .filter((m) => m.deletedAt === null && m.role === 'parent');
        if (activeParents.length <= 1) {
          return { ok: false, error: 'LAST_PARENT' };
        }
      }

      const seq = this.allocateSeq(db, tx, currentSeq);
      const updatedMember: BabyMember = {
        ...target,
        role: input.role,
        updatedAt: input.now,
        serverSeq: seq,
      };
      tx.set(targetRef, updatedMember, { merge: true });

      return { ok: true, member: updatedMember };
    });
  }

  async removeBabyMember(input: {
    babyId: string;
    targetUserId: string;
    actorUserId: string;
    now: string;
  }): Promise<RemoveMemberResult> {
    const db = this.getDb();

    return db.runTransaction(async (tx) => {
      const actorRef = db
        .collection('baby_members')
        .doc(this.memberDocId(input.babyId, input.actorUserId));
      const targetRef = db
        .collection('baby_members')
        .doc(this.memberDocId(input.babyId, input.targetUserId));
      const babyMembersQuery = db
        .collection('baby_members')
        .where('babyId', '==', input.babyId);

      const [actorSnap, targetSnap, allMembersSnap, currentSeq] =
        await Promise.all([
          tx.get(actorRef),
          tx.get(targetRef),
          tx.get(babyMembersQuery),
          this.getCurrentSeq(db, tx),
        ]);

      const actor = actorSnap.exists
        ? normalizeMemberDoc(actorSnap.data() as BabyMember)
        : null;
      if (!actor || actor.deletedAt !== null) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const isSelf = input.actorUserId === input.targetUserId;
      if (!isSelf && !canInviteMembers(actor.role)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      const target = targetSnap.exists
        ? normalizeMemberDoc(targetSnap.data() as BabyMember)
        : null;
      if (!target || target.deletedAt !== null) {
        return { ok: false, error: 'NOT_FOUND' };
      }

      if (!isSelf && !canManageMember(actor.role, target.role)) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (target.role === 'parent') {
        const activeParents = allMembersSnap.docs
          .map((d) => normalizeMemberDoc(d.data() as BabyMember))
          .filter((m) => m.deletedAt === null && m.role === 'parent');
        if (activeParents.length <= 1) {
          return { ok: false, error: 'LAST_PARENT' };
        }
      }

      const seq = this.allocateSeq(db, tx, currentSeq);
      tx.set(
        targetRef,
        {
          ...target,
          deletedAt: input.now,
          updatedAt: input.now,
          serverSeq: seq,
        },
        { merge: true },
      );

      return { ok: true };
    });
  }

  async promoteUserMembershipsToParent(input: {
    userId: string;
    now: string;
  }): Promise<number> {
    const db = this.getDb();
    const snap = await db
      .collection('baby_members')
      .where('userId', '==', input.userId)
      .get();

    let promoted = 0;
    for (const docSnap of snap.docs) {
      const didPromote = await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(docSnap.ref);
        if (!freshSnap.exists) return false;
        const member = normalizeMemberDoc(freshSnap.data() as BabyMember);
        if (member.deletedAt !== null || member.role === 'parent') {
          return false;
        }
        const currentSeq = await this.getCurrentSeq(db, tx);
        const seq = this.allocateSeq(db, tx, currentSeq);
        tx.set(
          docSnap.ref,
          {
            role: 'parent',
            updatedAt: input.now,
            serverSeq: seq,
          },
          { merge: true },
        );
        return true;
      });
      if (didPromote) promoted += 1;
    }
    return promoted;
  }

  async applySyncMutations(input: {
    userId: string;
    userDisplayName: string;
    mutations: SyncMutation[];
    serverNowIso: string;
  }): Promise<SyncPushResponse> {
    const db = this.getDb();
    const ackedMutationIds: string[] = [];
    const rejected: SyncRejectedMutation[] = [];
    const serverNowMs = Date.parse(input.serverNowIso);
    const maxAllowedMs = serverNowMs + 60_000;

    for (const mutation of input.mutations) {
      await db.runTransaction(async (tx) => {
        const mutRef = db.collection('sync_mutations').doc(mutation.mutationId);
        const existingMutSnap = await tx.get(mutRef);

        if (existingMutSnap.exists) {
          const existingMut = existingMutSnap.data() as FirestoreSyncMutationDoc;
          if (existingMut.userId !== input.userId) {
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
          return;
        }

        const clientMs = Date.parse(mutation.clientUpdatedAt);
        const effectiveUpdatedAtMs = Math.min(clientMs, maxAllowedMs);
        const effectiveUpdatedAt = new Date(effectiveUpdatedAtMs).toISOString();

        const recordAck = (seq: number) => {
          const mutDoc: FirestoreSyncMutationDoc = {
            mutationId: mutation.mutationId,
            userId: input.userId,
            status: 'acked',
            reason: null,
            serverSeq: seq,
            createdAt: input.serverNowIso,
          };
          tx.set(mutRef, mutDoc);
          ackedMutationIds.push(mutation.mutationId);
        };

        const recordReject = (reason: string) => {
          const mutDoc: FirestoreSyncMutationDoc = {
            mutationId: mutation.mutationId,
            userId: input.userId,
            status: 'rejected',
            reason,
            serverSeq: 0,
            createdAt: input.serverNowIso,
          };
          tx.set(mutRef, mutDoc);
          rejected.push({ mutationId: mutation.mutationId, reason });
        };

        if (mutation.entityType === 'baby') {
          if (mutation.op === 'upsert') {
            const parsed = BabySchema.safeParse(mutation.data);
            if (!parsed.success) {
              recordReject(
                `Invalid baby payload: ${parsed.error.issues[0]?.message ?? 'validation error'}`,
              );
              return;
            }
            const baby = parsed.data;
            const babyRef = db.collection('babies').doc(baby.id);
            const memberRef = db
              .collection('baby_members')
              .doc(this.memberDocId(baby.id, input.userId));

            const [existingBabySnap, memberSnap, currentSeq] = await Promise.all([
              tx.get(babyRef),
              tx.get(memberRef),
              this.getCurrentSeq(db, tx),
            ]);

            if (!existingBabySnap.exists) {
              const seq = this.allocateSeq(db, tx, currentSeq);
              const newBaby: Baby = {
                id: baby.id,
                name: baby.name,
                dob: baby.dob,
                birthWeightGrams: baby.birthWeightGrams ?? null,
                avatarColor: baby.avatarColor,
                notes: baby.notes ?? null,
                isArchived: baby.isArchived ?? false,
                createdByUserId: input.userId,
                createdAt: baby.createdAt,
                updatedAt: effectiveUpdatedAt,
                deletedAt: baby.deletedAt ?? null,
                serverSeq: seq,
              };
              const newMember: BabyMember = {
                id: crypto.randomUUID(),
                babyId: baby.id,
                userId: input.userId,
                displayName: input.userDisplayName,
                role: 'parent',
                joinedAt: input.serverNowIso,
                updatedAt: input.serverNowIso,
                deletedAt: null,
                serverSeq: seq,
              };
              tx.set(babyRef, newBaby);
              tx.set(memberRef, newMember);
              recordAck(seq);
            } else {
              const member = memberSnap.exists
                ? normalizeMemberDoc(memberSnap.data() as BabyMember)
                : null;
              if (
                !member ||
                member.deletedAt !== null ||
                !canManageBaby(member.role)
              ) {
                recordReject('Forbidden: parent role required to modify baby');
                return;
              }
              const existingBaby = existingBabySnap.data() as Baby;
              const existingUpdatedMs = Date.parse(existingBaby.updatedAt);
              if (effectiveUpdatedAtMs < existingUpdatedMs) {
                recordAck(existingBaby.serverSeq ?? 0);
                return;
              }

              const seq = this.allocateSeq(db, tx, currentSeq);
              const updatedBaby: Baby = {
                ...existingBaby,
                name: baby.name,
                dob: baby.dob,
                birthWeightGrams: baby.birthWeightGrams ?? null,
                avatarColor: baby.avatarColor,
                notes: baby.notes ?? null,
                isArchived: baby.isArchived ?? false,
                updatedAt: effectiveUpdatedAt,
                deletedAt: baby.deletedAt ?? null,
                serverSeq: seq,
              };
              tx.set(babyRef, updatedBaby);
              recordAck(seq);
            }
          } else {
            // op === 'delete' for baby
            const idParsed = uuidSchema.safeParse(mutation.data.id);
            if (!idParsed.success) {
              recordReject('Invalid baby id for delete');
              return;
            }
            const babyId = idParsed.data;
            const babyRef = db.collection('babies').doc(babyId);
            const memberRef = db
              .collection('baby_members')
              .doc(this.memberDocId(babyId, input.userId));

            const [existingBabySnap, memberSnap, currentSeq] = await Promise.all([
              tx.get(babyRef),
              tx.get(memberRef),
              this.getCurrentSeq(db, tx),
            ]);

            if (!existingBabySnap.exists) {
              recordReject('Baby not found');
              return;
            }
            const member = memberSnap.exists
              ? normalizeMemberDoc(memberSnap.data() as BabyMember)
              : null;
            if (
              !member ||
              member.deletedAt !== null ||
              !canManageBaby(member.role)
            ) {
              recordReject('Forbidden: parent role required to delete baby');
              return;
            }

            const existingBaby = existingBabySnap.data() as Baby;
            const existingUpdatedMs = Date.parse(existingBaby.updatedAt);
            if (effectiveUpdatedAtMs < existingUpdatedMs) {
              recordAck(existingBaby.serverSeq ?? 0);
              return;
            }

            const parsedDeletedAt = isoDateTimeSchema.safeParse(
              mutation.data.deletedAt,
            );
            const deletedAt = parsedDeletedAt.success
              ? parsedDeletedAt.data
              : effectiveUpdatedAt;
            const seq = this.allocateSeq(db, tx, currentSeq);
            tx.set(
              babyRef,
              {
                ...existingBaby,
                deletedAt,
                updatedAt: effectiveUpdatedAt,
                serverSeq: seq,
              },
              { merge: true },
            );
            recordAck(seq);
          }
        } else {
          // entityType === 'event'
          if (mutation.op === 'upsert') {
            const parsed = TrackingEventSchema.safeParse(mutation.data);
            if (!parsed.success) {
              recordReject(
                `Invalid event payload: ${parsed.error.issues[0]?.message ?? 'validation error'}`,
              );
              return;
            }
            const evt = parsed.data;
            const memberRef = db
              .collection('baby_members')
              .doc(this.memberDocId(evt.babyId, input.userId));
            const babyRef = db.collection('babies').doc(evt.babyId);
            const eventRef = db.collection('events').doc(evt.id);

            const [memberSnap, babySnap, existingEvtSnap, currentSeq] =
              await Promise.all([
                tx.get(memberRef),
                tx.get(babyRef),
                tx.get(eventRef),
                this.getCurrentSeq(db, tx),
              ]);

            const member = memberSnap.exists
              ? normalizeMemberDoc(memberSnap.data() as BabyMember)
              : null;
            if (!member || member.deletedAt !== null) {
              recordReject('Forbidden: not an active member of this baby');
              return;
            }
            if (!canEditEvents(member.role)) {
              recordReject('Forbidden: viewer role cannot mutate events');
              return;
            }
            if (evt.type === 'pumping' && !canAccessPumping(member.role)) {
              recordReject(
                'Forbidden: parent role required to mutate pumping events',
              );
              return;
            }

            const baby = babySnap.exists ? (babySnap.data() as Baby) : null;
            if (!baby || baby.deletedAt != null) {
              recordReject('Forbidden: baby has been deleted');
              return;
            }

            const existingEvt = existingEvtSnap.exists
              ? (existingEvtSnap.data() as TrackingEvent)
              : null;

            if (existingEvt) {
              if (existingEvt.babyId !== evt.babyId) {
                recordReject('Forbidden: cannot move event to another baby');
                return;
              }
              if (
                existingEvt.type === 'pumping' &&
                !canAccessPumping(member.role)
              ) {
                recordReject(
                  'Forbidden: parent role required to mutate pumping events',
                );
                return;
              }
              const existingUpdatedMs = Date.parse(existingEvt.updatedAt);
              if (effectiveUpdatedAtMs < existingUpdatedMs) {
                recordAck(existingEvt.serverSeq ?? 0);
                return;
              }
            }

            const seq = this.allocateSeq(db, tx, currentSeq);
            const nextEvt: TrackingEvent = existingEvt
              ? {
                  ...existingEvt,
                  type: evt.type,
                  startedAt: evt.startedAt,
                  endedAt: evt.endedAt,
                  payload: evt.payload,
                  notes: evt.notes ?? null,
                  updatedByUserId: input.userId,
                  updatedAt: effectiveUpdatedAt,
                  deletedAt: evt.deletedAt ?? null,
                  serverSeq: seq,
                } as TrackingEvent
              : ({
                  id: evt.id,
                  babyId: evt.babyId,
                  type: evt.type,
                  startedAt: evt.startedAt,
                  endedAt: evt.endedAt,
                  payload: evt.payload,
                  notes: evt.notes ?? null,
                  loggedByUserId: input.userId,
                  loggedByName: evt.loggedByName ?? input.userDisplayName,
                  updatedByUserId: input.userId,
                  createdAt: evt.createdAt,
                  updatedAt: effectiveUpdatedAt,
                  deletedAt: evt.deletedAt ?? null,
                  serverSeq: seq,
                } as TrackingEvent);

            tx.set(eventRef, nextEvt);
            recordAck(seq);
          } else {
            // op === 'delete' for event
            const idParsed = uuidSchema.safeParse(mutation.data.id);
            if (!idParsed.success) {
              recordReject('Invalid event id for delete');
              return;
            }
            const eventId = idParsed.data;
            const eventRef = db.collection('events').doc(eventId);
            const existingEvtSnap = await tx.get(eventRef);

            if (!existingEvtSnap.exists) {
              const parsedFull = TrackingEventSchema.safeParse(mutation.data);
              if (parsedFull.success) {
                const evt = parsedFull.data;
                const memberRef = db
                  .collection('baby_members')
                  .doc(this.memberDocId(evt.babyId, input.userId));
                const babyRef = db.collection('babies').doc(evt.babyId);

                const [memberSnap, babySnap, currentSeq] = await Promise.all([
                  tx.get(memberRef),
                  tx.get(babyRef),
                  this.getCurrentSeq(db, tx),
                ]);

                const member = memberSnap.exists
                  ? normalizeMemberDoc(memberSnap.data() as BabyMember)
                  : null;
                if (
                  !member ||
                  member.deletedAt !== null ||
                  !canEditEvents(member.role)
                ) {
                  recordReject('Forbidden: cannot delete event');
                  return;
                }
                if (evt.type === 'pumping' && !canAccessPumping(member.role)) {
                  recordReject(
                    'Forbidden: parent role required to delete pumping events',
                  );
                  return;
                }
                const baby = babySnap.exists ? (babySnap.data() as Baby) : null;
                if (!baby || baby.deletedAt != null) {
                  recordReject('Forbidden: baby has been deleted');
                  return;
                }

                const seq = this.allocateSeq(db, tx, currentSeq);
                const deletedAt = evt.deletedAt ?? effectiveUpdatedAt;
                const tombstone: TrackingEvent = {
                  id: evt.id,
                  babyId: evt.babyId,
                  type: evt.type,
                  startedAt: evt.startedAt,
                  endedAt: evt.endedAt,
                  payload: evt.payload,
                  notes: evt.notes ?? null,
                  loggedByUserId: input.userId,
                  loggedByName: evt.loggedByName ?? input.userDisplayName,
                  updatedByUserId: input.userId,
                  createdAt: evt.createdAt,
                  updatedAt: effectiveUpdatedAt,
                  deletedAt,
                  serverSeq: seq,
                } as TrackingEvent;
                tx.set(eventRef, tombstone);
                recordAck(seq);
              } else {
                const currentSeq = await this.getCurrentSeq(db, tx);
                recordAck(currentSeq);
              }
              return;
            }

            const existingEvt = existingEvtSnap.data() as TrackingEvent;
            const memberRef = db
              .collection('baby_members')
              .doc(this.memberDocId(existingEvt.babyId, input.userId));
            const babyRef = db.collection('babies').doc(existingEvt.babyId);

            const [memberSnap, babySnap, currentSeq] = await Promise.all([
              tx.get(memberRef),
              tx.get(babyRef),
              this.getCurrentSeq(db, tx),
            ]);

            const member = memberSnap.exists
              ? normalizeMemberDoc(memberSnap.data() as BabyMember)
              : null;
            if (
              !member ||
              member.deletedAt !== null ||
              !canEditEvents(member.role)
            ) {
              recordReject('Forbidden: cannot delete event');
              return;
            }
            if (
              existingEvt.type === 'pumping' &&
              !canAccessPumping(member.role)
            ) {
              recordReject(
                'Forbidden: parent role required to delete pumping events',
              );
              return;
            }
            const baby = babySnap.exists ? (babySnap.data() as Baby) : null;
            if (!baby || baby.deletedAt != null) {
              recordReject('Forbidden: baby has been deleted');
              return;
            }

            const existingUpdatedMs = Date.parse(existingEvt.updatedAt);
            if (effectiveUpdatedAtMs < existingUpdatedMs) {
              recordAck(existingEvt.serverSeq ?? 0);
              return;
            }

            const parsedDeletedAt = isoDateTimeSchema.safeParse(
              mutation.data.deletedAt,
            );
            const deletedAt = parsedDeletedAt.success
              ? parsedDeletedAt.data
              : effectiveUpdatedAt;
            const seq = this.allocateSeq(db, tx, currentSeq);
            tx.set(
              eventRef,
              {
                ...existingEvt,
                deletedAt,
                updatedAt: effectiveUpdatedAt,
                updatedByUserId: input.userId,
                serverSeq: seq,
              },
              { merge: true },
            );
            recordAck(seq);
          }
        }
      });
    }

    const latestSeq = await this.getCurrentSeq(db);
    return {
      ackedMutationIds,
      rejected,
      latestSeq,
    };
  }

  async pullSince(input: {
    userId: string;
    sinceSeq: number;
  }): Promise<SyncPullResponse> {
    const db = this.getDb();
    const latestSeq = await this.getCurrentSeq(db);

    const myMembershipsSnap = await db
      .collection('baby_members')
      .where('userId', '==', input.userId)
      .get();

    const activeBabyIds: string[] = [];
    const activeRoleByBabyId = new Map<string, BabyRole>();
    const newlyJoinedBabyIds = new Set<string>();
    const removedMemberships: BabyMember[] = [];

    for (const doc of myMembershipsSnap.docs) {
      const m = normalizeMemberDoc(doc.data() as BabyMember);
      const mSeq = m.serverSeq ?? 0;
      if (m.deletedAt === null) {
        activeBabyIds.push(m.babyId);
        activeRoleByBabyId.set(m.babyId, m.role);
        if (mSeq > input.sinceSeq) {
          newlyJoinedBabyIds.add(m.babyId);
        }
      } else if (mSeq > input.sinceSeq) {
        removedMemberships.push(m);
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

      const [babySnap, membersSnap, eventsSnap] = await Promise.all([
        db.collection('babies').doc(babyId).get(),
        db.collection('baby_members').where('babyId', '==', babyId).get(),
        db.collection('events').where('babyId', '==', babyId).get(),
      ]);

      if (babySnap.exists) {
        const b = babySnap.data() as Baby;
        if (isNew || (b.serverSeq ?? 0) > input.sinceSeq) {
          babies.push(b);
        }
      }

      for (const d of membersSnap.docs) {
        const m = normalizeMemberDoc(d.data() as BabyMember);
        if (isNew || (m.serverSeq ?? 0) > input.sinceSeq) {
          members.push(m);
        }
      }

      for (const d of eventsSnap.docs) {
        const e = d.data() as TrackingEvent;
        if (e.type === 'pumping' && !allowPumping) {
          continue;
        }
        if (isNew || (e.serverSeq ?? 0) > input.sinceSeq) {
          events.push(e);
        }
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
