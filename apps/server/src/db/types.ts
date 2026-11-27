import type {
  Baby,
  BabyInvitePublic,
  BabyMember,
  BabyRole,
  InviteRole,
  SyncMutation,
  SyncPullResponse,
  SyncPushResponse,
  User,
} from '@baby-tracker/shared';

export interface UserRecord extends User {
  passwordHash: string;
}

export interface InviteRecord extends BabyInvitePublic {
  createdByUserId: string;
  createdAt: string;
}

export type AcceptInviteResult =
  | { ok: true; baby: Baby; member: BabyMember }
  | { ok: false; error: 'NOT_FOUND' | 'EXPIRED' | 'BABY_NOT_FOUND' };

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; error: 'FORBIDDEN' | 'NOT_FOUND' | 'LAST_PARENT' };

export type UpdateMemberRoleResult =
  | { ok: true; member: BabyMember }
  | { ok: false; error: 'FORBIDDEN' | 'NOT_FOUND' | 'LAST_PARENT' };

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Email already registered: ${email}`);
    this.name = 'DuplicateEmailError';
  }
}

export interface StorageAdapter {
  readonly kind: 'sqlite' | 'postgres' | 'firestore';
  init(): Promise<void>;
  close(): Promise<void>;

  createUser(input: {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    createdAt: string;
  }): Promise<User>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<User | null>;

  createInvite(input: {
    id: string;
    babyId: string;
    code: string;
    role: InviteRole;
    createdByUserId: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<BabyInvitePublic>;

  acceptInvite(input: {
    code: string;
    userId: string;
    displayName: string;
    memberId: string;
    now: string;
  }): Promise<AcceptInviteResult>;

  getActiveMembership(babyId: string, userId: string): Promise<BabyMember | null>;
  listBabyMembers(babyId: string): Promise<BabyMember[]>;

  updateBabyMemberRole(input: {
    babyId: string;
    actorUserId: string;
    targetUserId: string;
    role: BabyRole;
    now: string;
  }): Promise<UpdateMemberRoleResult>;

  removeBabyMember(input: {
    babyId: string;
    targetUserId: string;
    actorUserId: string;
    now: string;
  }): Promise<RemoveMemberResult>;

  promoteUserMembershipsToParent(input: {
    userId: string;
    now: string;
  }): Promise<number>;

  applySyncMutations(input: {
    userId: string;
    userDisplayName: string;
    mutations: SyncMutation[];
    serverNowIso: string;
  }): Promise<SyncPushResponse>;

  pullSince(input: {
    userId: string;
    sinceSeq: number;
  }): Promise<SyncPullResponse>;
}
