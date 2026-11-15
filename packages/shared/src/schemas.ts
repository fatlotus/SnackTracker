import { z } from 'zod';

// ============================================================================
// Primitives
// ============================================================================

export const uuidSchema = z.string().uuid();

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date')
  .refine((val) => {
    const [yStr, mStr, dStr] = val.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, 'Invalid calendar date');

export const serverSeqSchema = z.number().int().nonnegative();

// ============================================================================
// Auth & User
// ============================================================================

export const UserSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  createdAt: isoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

export const RegisterInputSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(100),
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const LoginInputSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const AuthResponseSchema = z.object({
  user: UserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const LogoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

// ============================================================================
// Baby, Members & Invites
// ============================================================================

export const BabyRoleSchema = z.enum(['owner', 'caregiver', 'viewer']);
export type BabyRole = z.infer<typeof BabyRoleSchema>;

export const InviteRoleSchema = z.enum(['caregiver', 'viewer']);
export type InviteRole = z.infer<typeof InviteRoleSchema>;

export const BabySchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(100),
  dob: isoDateSchema,
  birthWeightGrams: z.number().int().positive().max(20000).nullable().optional(),
  avatarColor: z.string().min(1).max(32),
  notes: z.string().max(2000).nullable().optional(),
  isArchived: z.boolean(),
  createdByUserId: uuidSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable().optional(),
  serverSeq: serverSeqSchema.optional(),
});
export type Baby = z.infer<typeof BabySchema>;

export const CreateBabyInputSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(100),
  dob: isoDateSchema,
  birthWeightGrams: z.number().int().positive().max(20000).nullable().optional(),
  avatarColor: z.string().min(1).max(32).optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type CreateBabyInput = z.infer<typeof CreateBabyInputSchema>;

export const UpdateBabyInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  dob: isoDateSchema.optional(),
  birthWeightGrams: z.number().int().positive().max(20000).nullable().optional(),
  avatarColor: z.string().min(1).max(32).optional(),
  notes: z.string().max(2000).nullable().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateBabyInput = z.infer<typeof UpdateBabyInputSchema>;

export const BabyMemberSchema = z.object({
  id: uuidSchema,
  babyId: uuidSchema,
  userId: uuidSchema,
  displayName: z.string().min(1).max(100).nullable().optional(),
  role: BabyRoleSchema,
  joinedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable().optional(),
  serverSeq: serverSeqSchema.optional(),
});
export type BabyMember = z.infer<typeof BabyMemberSchema>;

export const BabyInvitePublicSchema = z.object({
  id: uuidSchema,
  babyId: uuidSchema,
  code: z.string().min(4).max(64),
  role: InviteRoleSchema,
  expiresAt: isoDateTimeSchema,
});
export type BabyInvitePublic = z.infer<typeof BabyInvitePublicSchema>;

export const CreateInviteInputSchema = z.object({
  role: InviteRoleSchema.optional().default('caregiver'),
  expiresInHours: z.number().int().min(1).max(720).optional().default(48),
});
export type CreateInviteInput = z.infer<typeof CreateInviteInputSchema>;

export const CreateInviteResponseSchema = z.object({
  invite: BabyInvitePublicSchema,
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

export const AcceptInviteInputSchema = z.object({
  code: z.string().trim().min(4).max(64),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInputSchema>;

export const AcceptInviteResponseSchema = z.object({
  baby: BabySchema,
  member: BabyMemberSchema,
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

export const ListMembersResponseSchema = z.object({
  members: z.array(BabyMemberSchema),
});
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;

// ============================================================================
// Tracking Events (Discriminated Union)
// ============================================================================

export const BreastSideSchema = z.enum(['left', 'right']);
export type BreastSide = z.infer<typeof BreastSideSchema>;

export const BreastFeedSegmentSchema = z.object({
  side: BreastSideSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable(),
});
export type BreastFeedSegment = z.infer<typeof BreastFeedSegmentSchema>;

export const BreastFeedPayloadSchema = z.object({
  segments: z.array(BreastFeedSegmentSchema),
  pausedAt: isoDateTimeSchema.nullable(),
  totalLeftSeconds: z.number().nonnegative(),
  totalRightSeconds: z.number().nonnegative(),
});
export type BreastFeedPayload = z.infer<typeof BreastFeedPayloadSchema>;

export const MilkTypeSchema = z.enum([
  'breastmilk',
  'formula',
  'mixed',
  'fortified',
  'other',
]);
export type MilkType = z.infer<typeof MilkTypeSchema>;

export const BottleFeedPayloadSchema = z.object({
  volumeMl: z.number().nonnegative().max(2000).nullable(),
  milkType: MilkTypeSchema.optional(),
});
export type BottleFeedPayload = z.infer<typeof BottleFeedPayloadSchema>;

export const SleepCategorySchema = z.enum(['nap', 'night']);
export type SleepCategory = z.infer<typeof SleepCategorySchema>;

export const SleepLocationSchema = z.enum([
  'crib',
  'bassinet',
  'contact',
  'stroller',
  'car_seat',
  'other',
]);
export type SleepLocation = z.infer<typeof SleepLocationSchema>;

export const SleepPayloadSchema = z.object({
  category: SleepCategorySchema,
  location: SleepLocationSchema.optional(),
});
export type SleepPayload = z.infer<typeof SleepPayloadSchema>;

export const DiaperKindSchema = z.enum(['wet', 'poopy', 'both']);
export type DiaperKind = z.infer<typeof DiaperKindSchema>;

export const DiaperAmountSchema = z.enum(['small', 'medium', 'large']);
export type DiaperAmount = z.infer<typeof DiaperAmountSchema>;

export const DiaperPayloadSchema = z.object({
  kind: DiaperKindSchema,
  amount: DiaperAmountSchema.optional(),
  stoolColor: z.string().max(64).optional(),
  stoolConsistency: z.string().max(64).optional(),
  hasRash: z.boolean().optional(),
});
export type DiaperPayload = z.infer<typeof DiaperPayloadSchema>;

export const SpitUpSeveritySchema = z.enum(['small', 'medium', 'large']);
export type SpitUpSeverity = z.infer<typeof SpitUpSeveritySchema>;

export const RelatedFeedTypeSchema = z.enum(['breast_feed', 'bottle_feed']);
export type RelatedFeedType = z.infer<typeof RelatedFeedTypeSchema>;

export const SpitUpPayloadSchema = z.object({
  severity: SpitUpSeveritySchema.optional(),
  relatedFeedId: uuidSchema.nullable().optional(),
  relatedFeedType: RelatedFeedTypeSchema.nullable().optional(),
});
export type SpitUpPayload = z.infer<typeof SpitUpPayloadSchema>;

const baseEventFields = {
  id: uuidSchema,
  babyId: uuidSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable(),
  notes: z.string().max(2000).nullable().optional(),
  loggedByUserId: uuidSchema,
  loggedByName: z.string().max(100).nullable().optional(),
  updatedByUserId: uuidSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable().optional(),
  serverSeq: serverSeqSchema.optional(),
};

export const BreastFeedEventSchema = z.object({
  ...baseEventFields,
  type: z.literal('breast_feed'),
  payload: BreastFeedPayloadSchema,
});
export type BreastFeedEvent = z.infer<typeof BreastFeedEventSchema>;

export const BottleFeedEventSchema = z.object({
  ...baseEventFields,
  type: z.literal('bottle_feed'),
  payload: BottleFeedPayloadSchema,
});
export type BottleFeedEvent = z.infer<typeof BottleFeedEventSchema>;

export const SleepEventSchema = z.object({
  ...baseEventFields,
  type: z.literal('sleep'),
  payload: SleepPayloadSchema,
});
export type SleepEvent = z.infer<typeof SleepEventSchema>;

export const DiaperEventSchema = z.object({
  ...baseEventFields,
  type: z.literal('diaper'),
  payload: DiaperPayloadSchema,
});
export type DiaperEvent = z.infer<typeof DiaperEventSchema>;

export const SpitUpEventSchema = z.object({
  ...baseEventFields,
  type: z.literal('spit_up'),
  payload: SpitUpPayloadSchema,
});
export type SpitUpEvent = z.infer<typeof SpitUpEventSchema>;

export const TrackingEventTypeSchema = z.enum([
  'breast_feed',
  'bottle_feed',
  'sleep',
  'diaper',
  'spit_up',
]);
export type TrackingEventType = z.infer<typeof TrackingEventTypeSchema>;

export const TrackingEventSchema = z
  .discriminatedUnion('type', [
    BreastFeedEventSchema,
    BottleFeedEventSchema,
    SleepEventSchema,
    DiaperEventSchema,
    SpitUpEventSchema,
  ])
  .superRefine((event, ctx) => {
    if (event.endedAt !== null) {
      const startMs = Date.parse(event.startedAt);
      const endMs = Date.parse(event.endedAt);
      if (endMs < startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endedAt must be greater than or equal to startedAt',
          path: ['endedAt'],
        });
      }
    }

    if (event.type === 'breast_feed') {
      event.payload.segments.forEach((segment, index) => {
        if (segment.endedAt !== null) {
          const segStartMs = Date.parse(segment.startedAt);
          const segEndMs = Date.parse(segment.endedAt);
          if (segEndMs < segStartMs) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'segment endedAt must be greater than or equal to segment startedAt',
              path: ['payload', 'segments', index, 'endedAt'],
            });
          }
        }
      });
    }
  });

export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

// ============================================================================
// Sync & Healthz
// ============================================================================

export const SyncEntityTypeSchema = z.enum(['baby', 'event']);
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;

export const SyncOpSchema = z.enum(['upsert', 'delete']);
export type SyncOp = z.infer<typeof SyncOpSchema>;

export const SyncMutationSchema = z.object({
  mutationId: uuidSchema,
  entityType: SyncEntityTypeSchema,
  op: SyncOpSchema,
  data: z.record(z.string(), z.unknown()),
  clientUpdatedAt: isoDateTimeSchema,
});
export type SyncMutation = z.infer<typeof SyncMutationSchema>;

export const SyncPushRequestSchema = z.object({
  mutations: z.array(SyncMutationSchema),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SyncRejectedMutationSchema = z.object({
  mutationId: uuidSchema,
  reason: z.string(),
});
export type SyncRejectedMutation = z.infer<typeof SyncRejectedMutationSchema>;

export const SyncPushResponseSchema = z.object({
  ackedMutationIds: z.array(uuidSchema),
  rejected: z.array(SyncRejectedMutationSchema),
  latestSeq: serverSeqSchema,
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

export const SyncPullQuerySchema = z.object({
  since_seq: z.coerce.number().int().nonnegative().default(0),
});
export type SyncPullQuery = z.infer<typeof SyncPullQuerySchema>;

export const SyncPullResponseSchema = z.object({
  babies: z.array(BabySchema),
  members: z.array(BabyMemberSchema),
  events: z.array(TrackingEventSchema),
  latestSeq: serverSeqSchema,
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;

export const HealthzResponseSchema = z.object({
  status: z.literal('ok'),
  storage: z.enum(['sqlite', 'postgres', 'firestore']),
});
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;
