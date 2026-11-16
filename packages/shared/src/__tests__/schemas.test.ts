import { describe, expect, it } from 'vitest';
import {
  AcceptInviteInputSchema,
  AuthResponseSchema,
  BabyMemberSchema,
  BabySchema,
  CreateBabyInputSchema,
  CreateInviteInputSchema,
  HealthzResponseSchema,
  LoginInputSchema,
  LogoutResponseSchema,
  RegisterInputSchema,
  SyncPullQuerySchema,
  SyncPullResponseSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  TrackingEventSchema,
  UpdateBabyInputSchema,
  UserSchema,
  isoDateSchema,
  isoDateTimeSchema,
  serverSeqSchema,
  uuidSchema,
} from '../schemas.js';

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const TS_1 = '2026-06-01T10:00:00.000Z';
const TS_2 = '2026-06-01T10:30:00.000Z';
const TS_BEFORE = '2026-06-01T09:59:59.000Z';

describe('primitives', () => {
  it('validates uuid, isoDateTime, isoDate, serverSeq', () => {
    expect(uuidSchema.safeParse(UUID_1).success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);

    expect(isoDateTimeSchema.safeParse(TS_1).success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-06-01T10:00:00-04:00').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-06-01').success).toBe(false);

    expect(isoDateSchema.safeParse('2026-02-28').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(isoDateSchema.safeParse('2026/02/28').success).toBe(false);

    expect(serverSeqSchema.safeParse(0).success).toBe(true);
    expect(serverSeqSchema.safeParse(42).success).toBe(true);
    expect(serverSeqSchema.safeParse(-1).success).toBe(false);
    expect(serverSeqSchema.safeParse(1.5).success).toBe(false);
  });
});

describe('auth & baby schemas', () => {
  it('validates user, register, login, auth, logout', () => {
    const user = {
      id: UUID_1,
      email: 'parent@example.com',
      displayName: 'Alex',
      createdAt: TS_1,
    };
    expect(UserSchema.parse(user)).toEqual(user);
    expect(AuthResponseSchema.parse({ user })).toEqual({ user });
    expect(LogoutResponseSchema.parse({ ok: true })).toEqual({ ok: true });

    expect(
      RegisterInputSchema.safeParse({
        email: 'parent@example.com',
        password: 'password123',
        displayName: 'Alex',
      }).success,
    ).toBe(true);
    expect(
      RegisterInputSchema.safeParse({
        email: 'bad-email',
        password: 'short',
        displayName: '',
      }).success,
    ).toBe(false);

    expect(
      LoginInputSchema.safeParse({
        email: 'parent@example.com',
        password: 'secret',
      }).success,
    ).toBe(true);
  });

  it('validates baby, member, and invite schemas', () => {
    const baby = {
      id: UUID_1,
      name: 'Maya',
      dob: '2026-04-15',
      birthWeightGrams: 3400,
      avatarColor: '#4f46e5',
      notes: 'Born healthy',
      isArchived: false,
      createdByUserId: UUID_2,
      createdAt: TS_1,
      updatedAt: TS_1,
      deletedAt: null,
      serverSeq: 0,
    };
    expect(BabySchema.parse(baby)).toEqual(baby);
    expect(
      CreateBabyInputSchema.safeParse({ name: 'Maya', dob: '2026-04-15' }).success,
    ).toBe(true);
    expect(UpdateBabyInputSchema.safeParse({ isArchived: true }).success).toBe(true);

    const member = {
      id: UUID_3,
      babyId: UUID_1,
      userId: UUID_2,
      displayName: 'Alex',
      role: 'owner' as const,
      joinedAt: TS_1,
      updatedAt: TS_1,
      deletedAt: null,
    };
    expect(BabyMemberSchema.parse(member)).toEqual(member);

    const inviteDefaults = CreateInviteInputSchema.parse({});
    expect(inviteDefaults).toEqual({ role: 'caregiver', expiresInHours: 48 });
    expect(AcceptInviteInputSchema.safeParse({ code: 'AB12CD' }).success).toBe(true);
  });
});

describe('TrackingEventSchema', () => {
  const base = {
    id: UUID_1,
    babyId: UUID_2,
    startedAt: TS_1,
    endedAt: TS_2,
    notes: null,
    loggedByUserId: UUID_3,
    loggedByName: 'Alex',
    updatedByUserId: UUID_3,
    createdAt: TS_1,
    updatedAt: TS_2,
    deletedAt: null,
    serverSeq: 0,
  };

  it('accepts valid breast_feed event with segments and pause', () => {
    const ev = {
      ...base,
      type: 'breast_feed' as const,
      payload: {
        segments: [
          { side: 'left' as const, startedAt: TS_1, endedAt: '2026-06-01T10:15:00.000Z' },
          { side: 'right' as const, startedAt: '2026-06-01T10:15:00.000Z', endedAt: TS_2 },
        ],
        pausedAt: null,
        totalLeftSeconds: 900,
        totalRightSeconds: 900,
      },
    };
    expect(TrackingEventSchema.safeParse(ev).success).toBe(true);
  });

  it('accepts bottle_feed with volumeMl = 0 and volumeMl = null', () => {
    const evZero = {
      ...base,
      type: 'bottle_feed' as const,
      payload: { volumeMl: 0, milkType: 'formula' as const },
    };
    const evNull = {
      ...base,
      type: 'bottle_feed' as const,
      payload: { volumeMl: null },
    };
    expect(TrackingEventSchema.safeParse(evZero).success).toBe(true);
    expect(TrackingEventSchema.safeParse(evNull).success).toBe(true);

    const evNegative = {
      ...base,
      type: 'bottle_feed' as const,
      payload: { volumeMl: -10 },
    };
    expect(TrackingEventSchema.safeParse(evNegative).success).toBe(false);
  });

  it('accepts sleep, diaper, and spit_up events', () => {
    expect(
      TrackingEventSchema.safeParse({
        ...base,
        type: 'sleep',
        endedAt: null,
        payload: { category: 'nap', location: 'crib' },
      }).success,
    ).toBe(true);

    expect(
      TrackingEventSchema.safeParse({
        ...base,
        type: 'diaper',
        endedAt: TS_1,
        payload: {
          kind: 'both',
          amount: 'medium',
          stoolColor: 'yellow',
          stoolConsistency: 'seedy',
          hasRash: true,
        },
      }).success,
    ).toBe(true);

    expect(
      TrackingEventSchema.safeParse({
        ...base,
        type: 'spit_up',
        endedAt: TS_1,
        payload: {
          severity: 'large',
          relatedFeedId: UUID_2,
          relatedFeedType: 'bottle_feed',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects endedAt < startedAt', () => {
    const res = TrackingEventSchema.safeParse({
      ...base,
      type: 'sleep',
      endedAt: TS_BEFORE,
      payload: { category: 'nap' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects breast_feed segment with endedAt < startedAt', () => {
    const res = TrackingEventSchema.safeParse({
      ...base,
      type: 'breast_feed',
      payload: {
        segments: [{ side: 'left', startedAt: TS_2, endedAt: TS_1 }],
        pausedAt: null,
        totalLeftSeconds: 0,
        totalRightSeconds: 0,
      },
    });
    expect(res.success).toBe(false);
  });

  it('validates vitamin point-in-time event and rejects endedAt < startedAt', () => {
    const valid = TrackingEventSchema.safeParse({
      ...base,
      type: 'vitamin',
      startedAt: TS_1,
      endedAt: TS_1,
      payload: {},
    });
    expect(valid.success).toBe(true);

    const invalid = TrackingEventSchema.safeParse({
      ...base,
      type: 'vitamin',
      startedAt: TS_2,
      endedAt: TS_1,
      payload: {},
    });
    expect(invalid.success).toBe(false);
  });
});

describe('sync & healthz schemas', () => {
  it('validates push, pull, and healthz payloads', () => {
    expect(
      SyncPushRequestSchema.safeParse({
        mutations: [
          {
            mutationId: UUID_1,
            entityType: 'event',
            op: 'upsert',
            data: { id: UUID_2 },
            clientUpdatedAt: TS_1,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      SyncPushResponseSchema.safeParse({
        ackedMutationIds: [UUID_1],
        rejected: [],
        latestSeq: 5,
      }).success,
    ).toBe(true);

    expect(SyncPullQuerySchema.parse({ since_seq: '12' })).toEqual({ since_seq: 12 });
    expect(SyncPullQuerySchema.parse({})).toEqual({ since_seq: 0 });
    expect(
      SyncPullResponseSchema.safeParse({
        babies: [],
        members: [],
        events: [],
        latestSeq: 0,
      }).success,
    ).toBe(true);

    expect(
      HealthzResponseSchema.safeParse({ status: 'ok', storage: 'sqlite' }).success,
    ).toBe(true);
  });
});
