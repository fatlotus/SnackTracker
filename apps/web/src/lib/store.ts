import {
  BabySchema,
  localDayBounds,
  toLocalDateKey,
  TrackingEventSchema,
  type Baby,
  type BabyMember,
  type BottleFeedEvent,
  type BreastFeedEvent,
  type BreastFeedSegment,
  type BreastSide,
  type CreateBabyInput,
  type DiaperAmount,
  type DiaperEvent,
  type DiaperKind,
  type MilkType,
  type PumpingEvent,
  type PumpingSide,
  type RelatedFeedType,
  type SleepCategory,
  type SleepEvent,
  type SleepLocation,
  type SpitUpEvent,
  type SpitUpSeverity,
  type TrackingEvent,
  type TummyTimeEvent,
  type TummyTimeMood,
  type UpdateBabyInput,
  type VitaminEvent,
} from '@baby-tracker/shared';
import { getDb, nowIso, uuidv4, type OutboxItem } from './db.js';

type StoreListener = () => void;
const storeListeners = new Set<StoreListener>();

export function subscribeStore(listener: StoreListener): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

export function notifyStoreChange(): void {
  for (const listener of storeListeners) {
    try {
      listener();
    } catch {
      // Ignore subscriber errors so other listeners still receive updates
    }
  }
}

function makeOutboxItem(
  entityType: 'baby' | 'event',
  entityId: string,
  op: 'upsert' | 'delete',
  data: Record<string, unknown>,
  clientUpdatedAt: string,
): OutboxItem {
  return {
    mutationId: uuidv4(),
    entityType,
    entityId,
    op,
    data,
    clientUpdatedAt,
    createdAt: clientUpdatedAt,
    attempts: 0,
    lastError: null,
  };
}

// ============================================================================
// Babies (Atomic IDB + Outbox)
// ============================================================================

export async function createBaby(
  input: CreateBabyInput & { createdByUserId: string },
): Promise<Baby> {
  const now = nowIso();
  const baby = BabySchema.parse({
    id: input.id ?? uuidv4(),
    name: input.name,
    dob: input.dob,
    birthWeightGrams: input.birthWeightGrams ?? null,
    avatarColor: input.avatarColor ?? '#0f766e',
    notes: input.notes ?? null,
    isArchived: false,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
  });

  const outboxItem = makeOutboxItem(
    'baby',
    baby.id,
    'upsert',
    baby as unknown as Record<string, unknown>,
    now,
  );

  const db = await getDb();
  const tx = db.transaction(['babies', 'outbox'], 'readwrite');
  await Promise.all([
    tx.objectStore('babies').put(baby),
    tx.objectStore('outbox').put(outboxItem),
    tx.done,
  ]);

  notifyStoreChange();
  return baby;
}

export async function updateBaby(
  babyId: string,
  patch: UpdateBabyInput,
): Promise<Baby> {
  const db = await getDb();
  const tx = db.transaction(['babies', 'outbox'], 'readwrite');
  const existing = await tx.objectStore('babies').get(babyId);
  if (!existing || existing.deletedAt) {
    throw new Error(`Baby not found: ${babyId}`);
  }

  const now = nowIso();
  const updated = BabySchema.parse({
    ...existing,
    ...patch,
    id: existing.id,
    createdByUserId: existing.createdByUserId,
    createdAt: existing.createdAt,
    updatedAt: now,
  });

  const outboxItem = makeOutboxItem(
    'baby',
    updated.id,
    'upsert',
    updated as unknown as Record<string, unknown>,
    now,
  );

  await Promise.all([
    tx.objectStore('babies').put(updated),
    tx.objectStore('outbox').put(outboxItem),
    tx.done,
  ]);

  notifyStoreChange();
  return updated;
}

export async function deleteBaby(babyId: string): Promise<Baby> {
  const db = await getDb();
  const tx = db.transaction(['babies', 'outbox'], 'readwrite');
  const existing = await tx.objectStore('babies').get(babyId);
  if (!existing) {
    throw new Error(`Baby not found: ${babyId}`);
  }

  const now = nowIso();
  const deleted = BabySchema.parse({
    ...existing,
    deletedAt: existing.deletedAt ?? now,
    updatedAt: now,
  });

  const outboxItem = makeOutboxItem(
    'baby',
    deleted.id,
    'delete',
    deleted as unknown as Record<string, unknown>,
    now,
  );

  await Promise.all([
    tx.objectStore('babies').put(deleted),
    tx.objectStore('outbox').put(outboxItem),
    tx.done,
  ]);

  notifyStoreChange();
  return deleted;
}

// ============================================================================
// Events (Atomic IDB + Outbox)
// ============================================================================

const AUTO_END_SLEEP_TYPES = new Set<TrackingEvent['type']>([
  'breast_feed',
  'bottle_feed',
  'diaper',
  'tummy_time',
]);

async function putEventAtomic(
  event: TrackingEvent,
  op: 'upsert' | 'delete' = 'upsert',
): Promise<TrackingEvent> {
  const validated = TrackingEventSchema.parse(event);
  const outboxItem = makeOutboxItem(
    'event',
    validated.id,
    op,
    validated as unknown as Record<string, unknown>,
    validated.updatedAt,
  );

  const db = await getDb();
  const tx = db.transaction(['events', 'outbox'], 'readwrite');
  const writes: Promise<unknown>[] = [
    tx.objectStore('events').put(validated),
    tx.objectStore('outbox').put(outboxItem),
  ];

  if (op === 'upsert' && AUTO_END_SLEEP_TYPES.has(validated.type)) {
    const babyEvents = await tx
      .objectStore('events')
      .index('by-babyId')
      .getAll(validated.babyId);
    const newStartMs = Date.parse(validated.startedAt);
    for (const existing of babyEvents) {
      if (
        existing.type === 'sleep' &&
        !existing.deletedAt &&
        existing.endedAt === null &&
        Date.parse(existing.startedAt) <= newStartMs
      ) {
        const endedSleep = TrackingEventSchema.parse({
          ...existing,
          endedAt: validated.startedAt,
          updatedAt: validated.updatedAt,
          updatedByUserId: validated.updatedByUserId,
        });
        const sleepOutbox = makeOutboxItem(
          'event',
          endedSleep.id,
          'upsert',
          endedSleep as unknown as Record<string, unknown>,
          endedSleep.updatedAt,
        );
        writes.push(
          tx.objectStore('events').put(endedSleep),
          tx.objectStore('outbox').put(sleepOutbox),
        );
      }
    }
  }

  writes.push(tx.done);
  await Promise.all(writes);

  notifyStoreChange();
  return validated;
}

export async function createEvent(event: TrackingEvent): Promise<TrackingEvent> {
  return putEventAtomic(event, 'upsert');
}

export async function updateEvent(
  eventId: string,
  updater: (existing: TrackingEvent) => TrackingEvent,
): Promise<TrackingEvent> {
  const db = await getDb();
  const tx = db.transaction(['events', 'outbox'], 'readwrite');
  const existing = await tx.objectStore('events').get(eventId);
  if (!existing || existing.deletedAt) {
    throw new Error(`Event not found: ${eventId}`);
  }

  const now = nowIso();
  const nextRaw = updater(existing);
  const validated = TrackingEventSchema.parse({
    ...nextRaw,
    id: existing.id,
    babyId: existing.babyId,
    createdAt: existing.createdAt,
    updatedAt: now,
  });

  const outboxItem = makeOutboxItem(
    'event',
    validated.id,
    'upsert',
    validated as unknown as Record<string, unknown>,
    now,
  );

  await Promise.all([
    tx.objectStore('events').put(validated),
    tx.objectStore('outbox').put(outboxItem),
    tx.done,
  ]);

  notifyStoreChange();
  return validated;
}

export async function deleteEvent(
  eventId: string,
  userId?: string,
): Promise<TrackingEvent> {
  const db = await getDb();
  const tx = db.transaction(['events', 'outbox'], 'readwrite');
  const existing = await tx.objectStore('events').get(eventId);
  if (!existing) {
    throw new Error(`Event not found: ${eventId}`);
  }

  const now = nowIso();
  const deleted = TrackingEventSchema.parse({
    ...existing,
    deletedAt: existing.deletedAt ?? now,
    updatedAt: now,
    updatedByUserId: userId ?? existing.updatedByUserId,
  });

  const outboxItem = makeOutboxItem(
    'event',
    deleted.id,
    'delete',
    deleted as unknown as Record<string, unknown>,
    now,
  );

  await Promise.all([
    tx.objectStore('events').put(deleted),
    tx.objectStore('outbox').put(outboxItem),
    tx.done,
  ]);

  notifyStoreChange();
  return deleted;
}

// ============================================================================
// Queries
// ============================================================================

export async function listBabies(
  options: { includeArchived?: boolean } = {},
): Promise<Baby[]> {
  const db = await getDb();
  const all = await db.getAll('babies');
  return all
    .filter((b) => !b.deletedAt && (options.includeArchived || !b.isArchived))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getBaby(babyId: string): Promise<Baby | null> {
  const db = await getDb();
  const baby = await db.get('babies', babyId);
  if (!baby || baby.deletedAt) {
    return null;
  }
  return baby;
}

export async function listBabyMembers(babyId: string): Promise<BabyMember[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('baby_members', 'by-babyId', babyId);
  return rows
    .filter((m) => !m.deletedAt)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

export async function listEventsForBaby(
  babyId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<TrackingEvent[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('events', 'by-babyId', babyId);
  return rows
    .filter((e) => options.includeDeleted || !e.deletedAt)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface ActiveTimersForBaby {
  breastFeed: BreastFeedEvent | null;
  bottleFeed: BottleFeedEvent | null;
  sleep: SleepEvent | null;
  pumping: PumpingEvent | null;
  tummyTime: TummyTimeEvent | null;
}

export async function getActiveTimersForBaby(
  babyId: string,
): Promise<ActiveTimersForBaby> {
  const events = await listEventsForBaby(babyId);
  let breastFeed: BreastFeedEvent | null = null;
  let bottleFeed: BottleFeedEvent | null = null;
  let sleep: SleepEvent | null = null;
  let pumping: PumpingEvent | null = null;
  let tummyTime: TummyTimeEvent | null = null;

  for (const event of events) {
    if (event.endedAt !== null) continue;
    if (event.type === 'breast_feed' && !breastFeed) {
      breastFeed = event;
    } else if (event.type === 'bottle_feed' && !bottleFeed) {
      bottleFeed = event;
    } else if (event.type === 'sleep' && !sleep) {
      sleep = event;
    } else if (event.type === 'pumping' && !pumping) {
      pumping = event;
    } else if (event.type === 'tummy_time' && !tummyTime) {
      tummyTime = event;
    }
  }

  return { breastFeed, bottleFeed, sleep, pumping, tummyTime };
}

// ============================================================================
// Breastfeeding Timer Helpers
// ============================================================================

function clampAtIso(minIso: string, candidateIso?: string): string {
  const iso = candidateIso ?? nowIso();
  const minMs = Date.parse(minIso);
  const candMs = Date.parse(iso);
  if (candMs < minMs) {
    return new Date(minMs).toISOString();
  }
  return iso;
}

function sumClosedSegments(segments: BreastFeedSegment[]): {
  totalLeftSeconds: number;
  totalRightSeconds: number;
} {
  let leftMs = 0;
  let rightMs = 0;
  for (const seg of segments) {
    if (seg.endedAt !== null) {
      const dur = Math.max(0, Date.parse(seg.endedAt) - Date.parse(seg.startedAt));
      if (seg.side === 'left') {
        leftMs += dur;
      } else {
        rightMs += dur;
      }
    }
  }
  return {
    totalLeftSeconds: leftMs / 1000,
    totalRightSeconds: rightMs / 1000,
  };
}

export function computeBreastFeedElapsed(
  event: BreastFeedEvent,
  nowMs: number = Date.now(),
): {
  leftSeconds: number;
  rightSeconds: number;
  totalSeconds: number;
  activeSide: BreastSide | null;
  isPaused: boolean;
} {
  let leftMs = 0;
  let rightMs = 0;
  let activeSide: BreastSide | null = null;

  for (const seg of event.payload.segments) {
    const startMs = Date.parse(seg.startedAt);
    if (seg.endedAt !== null) {
      const endMs = Math.max(startMs, Date.parse(seg.endedAt));
      if (seg.side === 'left') leftMs += endMs - startMs;
      else rightMs += endMs - startMs;
    } else {
      activeSide = seg.side;
      const endMs = Math.max(startMs, nowMs);
      if (seg.side === 'left') leftMs += endMs - startMs;
      else rightMs += endMs - startMs;
    }
  }

  const leftSeconds = leftMs / 1000;
  const rightSeconds = rightMs / 1000;
  return {
    leftSeconds,
    rightSeconds,
    totalSeconds: leftSeconds + rightSeconds,
    activeSide,
    isPaused: event.payload.pausedAt !== null,
  };
}

export async function startBreastFeed(input: {
  babyId: string;
  side: BreastSide;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  notes?: string | null;
}): Promise<BreastFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (active.breastFeed) {
    throw new Error('An active breast feed is already running for this baby');
  }

  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();
  const event: BreastFeedEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'breast_feed',
    startedAt,
    endedAt: null,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      segments: [
        {
          side: input.side,
          startedAt,
          endedAt: null,
        },
      ],
      pausedAt: null,
      totalLeftSeconds: 0,
      totalRightSeconds: 0,
    },
  };

  return (await putEventAtomic(event, 'upsert')) as BreastFeedEvent;
}

export async function switchBreastSide(input: {
  babyId: string;
  nextSide?: BreastSide;
  userId: string;
  at?: string;
}): Promise<BreastFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.breastFeed) {
    throw new Error('No active breast feed found for this baby');
  }

  return (await updateEvent(active.breastFeed.id, (existing) => {
    if (existing.type !== 'breast_feed') {
      throw new Error('Expected breast_feed event');
    }
    const atIso = clampAtIso(existing.startedAt, input.at);
    const segments = existing.payload.segments.map((s) => ({ ...s }));
    const lastSeg = segments[segments.length - 1];
    let targetSide: BreastSide;

    if (input.nextSide) {
      targetSide = input.nextSide;
    } else if (lastSeg) {
      targetSide = lastSeg.side === 'left' ? 'right' : 'left';
    } else {
      targetSide = 'left';
    }

    for (const seg of segments) {
      if (seg.endedAt === null) {
        seg.endedAt = clampAtIso(seg.startedAt, atIso);
      }
    }

    segments.push({
      side: targetSide,
      startedAt: atIso,
      endedAt: null,
    });

    const totals = sumClosedSegments(segments);
    return {
      ...existing,
      updatedByUserId: input.userId,
      payload: {
        segments,
        pausedAt: null,
        totalLeftSeconds: totals.totalLeftSeconds,
        totalRightSeconds: totals.totalRightSeconds,
      },
    };
  })) as BreastFeedEvent;
}

export async function pauseBreastFeed(input: {
  babyId: string;
  userId: string;
  at?: string;
}): Promise<BreastFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.breastFeed) {
    throw new Error('No active breast feed found for this baby');
  }
  if (active.breastFeed.payload.pausedAt !== null) {
    return active.breastFeed;
  }

  return (await updateEvent(active.breastFeed.id, (existing) => {
    if (existing.type !== 'breast_feed') {
      throw new Error('Expected breast_feed event');
    }
    const atIso = clampAtIso(existing.startedAt, input.at);
    const segments = existing.payload.segments.map((s) =>
      s.endedAt === null
        ? { ...s, endedAt: clampAtIso(s.startedAt, atIso) }
        : { ...s },
    );
    const totals = sumClosedSegments(segments);
    return {
      ...existing,
      updatedByUserId: input.userId,
      payload: {
        segments,
        pausedAt: atIso,
        totalLeftSeconds: totals.totalLeftSeconds,
        totalRightSeconds: totals.totalRightSeconds,
      },
    };
  })) as BreastFeedEvent;
}

export async function resumeBreastFeed(input: {
  babyId: string;
  side?: BreastSide;
  userId: string;
  at?: string;
}): Promise<BreastFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.breastFeed) {
    throw new Error('No active breast feed found for this baby');
  }
  if (active.breastFeed.payload.pausedAt === null) {
    return active.breastFeed;
  }

  return (await updateEvent(active.breastFeed.id, (existing) => {
    if (existing.type !== 'breast_feed') {
      throw new Error('Expected breast_feed event');
    }
    const atIso = clampAtIso(
      existing.payload.pausedAt ?? existing.startedAt,
      input.at,
    );
    const segments = existing.payload.segments.map((s) => ({ ...s }));
    const lastSeg = segments[segments.length - 1];
    const side = input.side ?? lastSeg?.side ?? 'left';

    segments.push({
      side,
      startedAt: atIso,
      endedAt: null,
    });

    const totals = sumClosedSegments(segments);
    return {
      ...existing,
      updatedByUserId: input.userId,
      payload: {
        segments,
        pausedAt: null,
        totalLeftSeconds: totals.totalLeftSeconds,
        totalRightSeconds: totals.totalRightSeconds,
      },
    };
  })) as BreastFeedEvent;
}

export async function finishBreastFeed(input: {
  babyId: string;
  userId: string;
  at?: string;
  notes?: string | null;
}): Promise<BreastFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.breastFeed) {
    throw new Error('No active breast feed found for this baby');
  }

  return (await updateEvent(active.breastFeed.id, (existing) => {
    if (existing.type !== 'breast_feed') {
      throw new Error('Expected breast_feed event');
    }
    const atIso = clampAtIso(existing.startedAt, input.at);
    let maxEndMs = Date.parse(atIso);
    const segments = existing.payload.segments.map((s) => {
      if (s.endedAt === null) {
        const segEnd = clampAtIso(s.startedAt, atIso);
        maxEndMs = Math.max(maxEndMs, Date.parse(segEnd));
        return { ...s, endedAt: segEnd };
      }
      maxEndMs = Math.max(maxEndMs, Date.parse(s.endedAt));
      return { ...s };
    });

    const totals = sumClosedSegments(segments);
    const finalEndedAt = new Date(
      Math.max(Date.parse(existing.startedAt), maxEndMs),
    ).toISOString();

    return {
      ...existing,
      endedAt: finalEndedAt,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      updatedByUserId: input.userId,
      payload: {
        segments,
        pausedAt: null,
        totalLeftSeconds: totals.totalLeftSeconds,
        totalRightSeconds: totals.totalRightSeconds,
      },
    };
  })) as BreastFeedEvent;
}

// ============================================================================
// Bottle Feed Helpers
// ============================================================================

export async function startBottleFeed(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  volumeMl?: number | null;
  milkType?: MilkType;
  startedAt?: string;
  notes?: string | null;
}): Promise<BottleFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (active.bottleFeed) {
    throw new Error('An active bottle feed is already running for this baby');
  }

  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();
  const event: BottleFeedEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'bottle_feed',
    startedAt,
    endedAt: null,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      volumeMl: input.volumeMl ?? null,
      ...(input.milkType !== undefined ? { milkType: input.milkType } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as BottleFeedEvent;
}

export async function finishBottleFeed(input: {
  babyId: string;
  userId: string;
  volumeMl?: number | null;
  milkType?: MilkType;
  at?: string;
  notes?: string | null;
}): Promise<BottleFeedEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.bottleFeed) {
    throw new Error('No active bottle feed found for this baby');
  }

  return (await updateEvent(active.bottleFeed.id, (existing) => {
    if (existing.type !== 'bottle_feed') {
      throw new Error('Expected bottle_feed event');
    }
    const endedAt = clampAtIso(existing.startedAt, input.at);
    return {
      ...existing,
      endedAt,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      updatedByUserId: input.userId,
      payload: {
        volumeMl:
          input.volumeMl !== undefined
            ? input.volumeMl
            : existing.payload.volumeMl,
        ...(input.milkType !== undefined
          ? { milkType: input.milkType }
          : existing.payload.milkType !== undefined
            ? { milkType: existing.payload.milkType }
            : {}),
      },
    };
  })) as BottleFeedEvent;
}

export async function logBottleFeed(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  endedAt?: string;
  volumeMl: number | null;
  milkType?: MilkType;
  notes?: string | null;
}): Promise<BottleFeedEvent> {
  const startedAt = input.startedAt ?? nowIso();
  const endedAt = clampAtIso(startedAt, input.endedAt ?? startedAt);
  const now = nowIso();

  const event: BottleFeedEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'bottle_feed',
    startedAt,
    endedAt,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      volumeMl: input.volumeMl,
      ...(input.milkType !== undefined ? { milkType: input.milkType } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as BottleFeedEvent;
}

// ============================================================================
// Sleep Helpers
// ============================================================================

export async function startSleep(input: {
  babyId: string;
  category: SleepCategory;
  location?: SleepLocation;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  notes?: string | null;
}): Promise<SleepEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (active.sleep) {
    throw new Error('An active sleep session is already running for this baby');
  }

  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();
  const event: SleepEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'sleep',
    startedAt,
    endedAt: null,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      category: input.category,
      ...(input.location !== undefined ? { location: input.location } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as SleepEvent;
}

export async function finishSleep(input: {
  babyId: string;
  userId: string;
  at?: string;
  category?: SleepCategory;
  location?: SleepLocation;
  notes?: string | null;
}): Promise<SleepEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.sleep) {
    throw new Error('No active sleep session found for this baby');
  }

  return (await updateEvent(active.sleep.id, (existing) => {
    if (existing.type !== 'sleep') {
      throw new Error('Expected sleep event');
    }
    const endedAt = clampAtIso(existing.startedAt, input.at);
    return {
      ...existing,
      endedAt,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      updatedByUserId: input.userId,
      payload: {
        category: input.category ?? existing.payload.category,
        ...(input.location !== undefined
          ? { location: input.location }
          : existing.payload.location !== undefined
            ? { location: existing.payload.location }
            : {}),
      },
    };
  })) as SleepEvent;
}

export async function logSleep(input: {
  babyId: string;
  category: SleepCategory;
  location?: SleepLocation;
  userId: string;
  userName?: string | null;
  startedAt: string;
  endedAt: string;
  notes?: string | null;
}): Promise<SleepEvent> {
  const endedAt = clampAtIso(input.startedAt, input.endedAt);
  const now = nowIso();

  const event: SleepEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'sleep',
    startedAt: input.startedAt,
    endedAt,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      category: input.category,
      ...(input.location !== undefined ? { location: input.location } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as SleepEvent;
}

// ============================================================================
// Diaper & Spit-Up Quick-Log Helpers
// ============================================================================

export async function logDiaper(input: {
  babyId: string;
  kind: DiaperKind;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  amount?: DiaperAmount;
  stoolColor?: string;
  stoolConsistency?: string;
  hasRash?: boolean;
  notes?: string | null;
}): Promise<DiaperEvent> {
  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();

  const event: DiaperEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'diaper',
    startedAt,
    endedAt: startedAt,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      kind: input.kind,
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.stoolColor !== undefined
        ? { stoolColor: input.stoolColor }
        : {}),
      ...(input.stoolConsistency !== undefined
        ? { stoolConsistency: input.stoolConsistency }
        : {}),
      ...(input.hasRash !== undefined ? { hasRash: input.hasRash } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as DiaperEvent;
}

export async function logSpitUp(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  severity?: SpitUpSeverity;
  relatedFeedId?: string | null;
  relatedFeedType?: RelatedFeedType | null;
  notes?: string | null;
}): Promise<SpitUpEvent> {
  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();

  const event: SpitUpEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'spit_up',
    startedAt,
    endedAt: startedAt,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.relatedFeedId !== undefined
        ? { relatedFeedId: input.relatedFeedId }
        : {}),
      ...(input.relatedFeedType !== undefined
        ? { relatedFeedType: input.relatedFeedType }
        : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as SpitUpEvent;
}

export async function logVitamin(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  notes?: string | null;
}): Promise<VitaminEvent> {
  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();

  const event: VitaminEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'vitamin',
    startedAt,
    endedAt: startedAt,
    notes: input.notes ?? null,
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {},
  };

  return (await putEventAtomic(event, 'upsert')) as VitaminEvent;
}

export async function toggleVitaminForLocalDay(input: {
  babyId: string;
  dateKey: string;
  timeZone: string;
  given: boolean;
  userId: string;
  userName?: string | null;
  nowMs?: number;
}): Promise<void> {
  const events = await listEventsForBaby(input.babyId);
  const matching = events.filter(
    (e) =>
      e.type === 'vitamin' &&
      e.deletedAt == null &&
      toLocalDateKey(Date.parse(e.startedAt), input.timeZone) === input.dateKey,
  );

  if (input.given) {
    if (matching.length > 0) return;
    const todayKey = toLocalDateKey(input.nowMs ?? Date.now(), input.timeZone);
    const startedAt =
      input.dateKey === todayKey
        ? nowIso()
        : new Date(
            localDayBounds(input.dateKey, input.timeZone).startMs +
              12 * 3600 * 1000,
          ).toISOString();
    await logVitamin({
      babyId: input.babyId,
      userId: input.userId,
      userName: input.userName,
      startedAt,
    });
  } else {
    for (const ev of matching) {
      await deleteEvent(ev.id, input.userId);
    }
  }
}

// ============================================================================
// Pumping Helpers
// ============================================================================

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function startPumping(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  side?: PumpingSide;
  volumeMl?: number | null;
  leftVolumeMl?: number | null;
  rightVolumeMl?: number | null;
  startedAt?: string;
  notes?: string | null;
}): Promise<PumpingEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (active.pumping) {
    throw new Error('An active pumping session is already running for this baby');
  }

  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();
  const event: PumpingEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'pumping',
    startedAt,
    endedAt: null,
    notes: normalizeNotes(input.notes),
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      side: input.side ?? 'both',
      volumeMl: input.volumeMl ?? null,
      ...(input.leftVolumeMl !== undefined
        ? { leftVolumeMl: input.leftVolumeMl }
        : {}),
      ...(input.rightVolumeMl !== undefined
        ? { rightVolumeMl: input.rightVolumeMl }
        : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as PumpingEvent;
}

export async function finishPumping(input: {
  babyId: string;
  userId: string;
  side?: PumpingSide;
  volumeMl?: number | null;
  leftVolumeMl?: number | null;
  rightVolumeMl?: number | null;
  at?: string;
  notes?: string | null;
}): Promise<PumpingEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.pumping) {
    throw new Error('No active pumping session found for this baby');
  }

  return (await updateEvent(active.pumping.id, (existing) => {
    if (existing.type !== 'pumping') {
      throw new Error('Expected pumping event');
    }
    const endedAt = clampAtIso(existing.startedAt, input.at);
    const nextSide =
      input.side !== undefined ? input.side : existing.payload.side;
    const nextLeft =
      input.leftVolumeMl !== undefined
        ? input.leftVolumeMl
        : existing.payload.leftVolumeMl;
    const nextRight =
      input.rightVolumeMl !== undefined
        ? input.rightVolumeMl
        : existing.payload.rightVolumeMl;

    return {
      ...existing,
      endedAt,
      notes:
        input.notes !== undefined
          ? normalizeNotes(input.notes)
          : existing.notes,
      updatedByUserId: input.userId,
      payload: {
        ...(nextSide !== undefined ? { side: nextSide } : {}),
        volumeMl:
          input.volumeMl !== undefined
            ? input.volumeMl
            : existing.payload.volumeMl,
        ...(nextLeft !== undefined ? { leftVolumeMl: nextLeft } : {}),
        ...(nextRight !== undefined ? { rightVolumeMl: nextRight } : {}),
      },
    };
  })) as PumpingEvent;
}

export async function logPumping(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  startedAt?: string;
  endedAt?: string;
  side?: PumpingSide;
  volumeMl: number | null;
  leftVolumeMl?: number | null;
  rightVolumeMl?: number | null;
  notes?: string | null;
}): Promise<PumpingEvent> {
  const startedAt = input.startedAt ?? nowIso();
  const endedAt = clampAtIso(startedAt, input.endedAt ?? startedAt);
  const now = nowIso();

  const event: PumpingEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'pumping',
    startedAt,
    endedAt,
    notes: normalizeNotes(input.notes),
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      ...(input.side !== undefined ? { side: input.side } : {}),
      volumeMl: input.volumeMl,
      ...(input.leftVolumeMl !== undefined
        ? { leftVolumeMl: input.leftVolumeMl }
        : {}),
      ...(input.rightVolumeMl !== undefined
        ? { rightVolumeMl: input.rightVolumeMl }
        : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as PumpingEvent;
}

// ============================================================================
// Tummy Time Helpers
// ============================================================================

export async function startTummyTime(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  mood?: TummyTimeMood;
  startedAt?: string;
  notes?: string | null;
}): Promise<TummyTimeEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (active.tummyTime) {
    throw new Error(
      'An active tummy time session is already running for this baby',
    );
  }

  const startedAt = input.startedAt ?? nowIso();
  const now = nowIso();
  const event: TummyTimeEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'tummy_time',
    startedAt,
    endedAt: null,
    notes: normalizeNotes(input.notes),
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      ...(input.mood !== undefined ? { mood: input.mood } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as TummyTimeEvent;
}

export async function finishTummyTime(input: {
  babyId: string;
  userId: string;
  mood?: TummyTimeMood;
  at?: string;
  notes?: string | null;
}): Promise<TummyTimeEvent> {
  const active = await getActiveTimersForBaby(input.babyId);
  if (!active.tummyTime) {
    throw new Error('No active tummy time session found for this baby');
  }

  return (await updateEvent(active.tummyTime.id, (existing) => {
    if (existing.type !== 'tummy_time') {
      throw new Error('Expected tummy_time event');
    }
    const endedAt = clampAtIso(existing.startedAt, input.at);
    const nextMood =
      input.mood !== undefined ? input.mood : existing.payload.mood;

    return {
      ...existing,
      endedAt,
      notes:
        input.notes !== undefined
          ? normalizeNotes(input.notes)
          : existing.notes,
      updatedByUserId: input.userId,
      payload: {
        ...(nextMood !== undefined ? { mood: nextMood } : {}),
      },
    };
  })) as TummyTimeEvent;
}

export async function logTummyTime(input: {
  babyId: string;
  userId: string;
  userName?: string | null;
  startedAt: string;
  endedAt: string;
  mood?: TummyTimeMood;
  notes?: string | null;
}): Promise<TummyTimeEvent> {
  const endedAt = clampAtIso(input.startedAt, input.endedAt);
  const now = nowIso();

  const event: TummyTimeEvent = {
    id: uuidv4(),
    babyId: input.babyId,
    type: 'tummy_time',
    startedAt: input.startedAt,
    endedAt,
    notes: normalizeNotes(input.notes),
    loggedByUserId: input.userId,
    loggedByName: input.userName ?? null,
    updatedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    serverSeq: 0,
    payload: {
      ...(input.mood !== undefined ? { mood: input.mood } : {}),
    },
  };

  return (await putEventAtomic(event, 'upsert')) as TummyTimeEvent;
}
