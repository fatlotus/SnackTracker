import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, DB_NAME, getDb } from './db.js';
import {
  computeBreastFeedElapsed,
  createBaby,
  createEvent,
  deleteBaby,
  deleteEvent,
  finishBottleFeed,
  finishBreastFeed,
  finishPumping,
  finishSleep,
  finishTummyTime,
  getActiveTimersForBaby,
  getBaby,
  importEventsForBaby,
  listBabies,
  listBabyMembers,
  listEventsForBaby,
  logBottleFeed,
  logDiaper,
  logPumping,
  logSleep,
  logSpitUp,
  logTummyTime,
  logVitamin,
  pauseBreastFeed,
  resumeBreastFeed,
  startBottleFeed,
  startBreastFeed,
  startPumping,
  startSleep,
  startTummyTime,
  subscribeStore,
  switchBreastSide,
  toggleVitaminForLocalDay,
  updateBaby,
} from './store.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

async function clearDatabase(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('store (IndexedDB + atomic outbox + timers)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('writes baby create, update, and soft-delete atomically to babies and outbox', async () => {
    const listener = vi.fn();
    const unsub = subscribeStore(listener);

    const baby = await createBaby({
      name: 'Maya',
      dob: '2026-01-15',
      avatarColor: '#0f766e',
      createdByUserId: USER_ID,
    });

    expect(baby.name).toBe('Maya');
    expect(baby.deletedAt).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    const db = await getDb();
    let outbox = await db.getAll('outbox');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      entityType: 'baby',
      entityId: baby.id,
      op: 'upsert',
    });

    const updated = await updateBaby(baby.id, { name: 'Maya Rose' });
    expect(updated.name).toBe('Maya Rose');
    outbox = await db.getAll('outbox');
    expect(outbox).toHaveLength(2);

    const deleted = await deleteBaby(baby.id);
    expect(deleted.deletedAt).toBeTruthy();
    expect(await getBaby(baby.id)).toBeNull();
    expect(await listBabies()).toHaveLength(0);

    outbox = await db.getAllFromIndex('outbox', 'by-createdAt');
    expect(outbox).toHaveLength(3);
    expect(outbox[2]).toMatchObject({
      entityType: 'baby',
      entityId: baby.id,
      op: 'delete',
    });

    unsub();
  });

  it('handles timestamp-driven breast feed start, switch L<->R, pause, resume, finish, and elapsed', async () => {
    const baby = await createBaby({
      name: 'Leo',
      dob: '2026-02-01',
      createdByUserId: USER_ID,
    });

    const t0 = '2026-03-01T10:00:00.000Z';
    const t1 = '2026-03-01T10:05:00.000Z'; // +300s left
    const t2 = '2026-03-01T10:08:00.000Z'; // +180s right, then pause
    const t3 = '2026-03-01T10:10:00.000Z'; // resume right after 120s pause
    const t4 = '2026-03-01T10:12:30.000Z'; // +150s right, finish

    const started = await startBreastFeed({
      babyId: baby.id,
      side: 'left',
      userId: USER_ID,
      userName: 'Parent A',
      startedAt: t0,
    });
    expect(started.endedAt).toBeNull();
    expect(started.payload.segments).toHaveLength(1);

    // Mid-segment elapsed at t1
    const midElapsed = computeBreastFeedElapsed(started, Date.parse(t1));
    expect(midElapsed).toEqual({
      leftSeconds: 300,
      rightSeconds: 0,
      totalSeconds: 300,
      activeSide: 'left',
      isPaused: false,
    });

    const switched = await switchBreastSide({
      babyId: baby.id,
      userId: USER_ID,
      at: t1,
    });
    expect(switched.payload.segments).toHaveLength(2);
    expect(switched.payload.segments[0].endedAt).toBe(t1);
    expect(switched.payload.segments[1]).toEqual({
      side: 'right',
      startedAt: t1,
      endedAt: null,
    });

    const paused = await pauseBreastFeed({
      babyId: baby.id,
      userId: USER_ID,
      at: t2,
    });
    expect(paused.payload.pausedAt).toBe(t2);
    expect(computeBreastFeedElapsed(paused, Date.parse(t3))).toEqual({
      leftSeconds: 300,
      rightSeconds: 180,
      totalSeconds: 480,
      activeSide: null,
      isPaused: true,
    });

    const resumed = await resumeBreastFeed({
      babyId: baby.id,
      userId: USER_ID,
      at: t3,
    });
    expect(resumed.payload.pausedAt).toBeNull();
    expect(resumed.payload.segments).toHaveLength(3);
    expect(resumed.payload.segments[2].side).toBe('right');

    const finished = await finishBreastFeed({
      babyId: baby.id,
      userId: USER_ID,
      at: t4,
      notes: 'Good latch',
    });
    expect(finished.endedAt).toBe(t4);
    expect(finished.notes).toBe('Good latch');
    expect(finished.payload.pausedAt).toBeNull();
    expect(finished.payload.totalLeftSeconds).toBe(300);
    expect(finished.payload.totalRightSeconds).toBe(330);

    const active = await getActiveTimersForBaby(baby.id);
    expect(active.breastFeed).toBeNull();
  });

  it('tracks bottle, sleep, diaper, and spit-up events with atomic outbox writes', async () => {
    const baby = await createBaby({
      name: 'Nora',
      dob: '2026-01-10',
      createdByUserId: USER_ID,
    });

    await startBottleFeed({
      babyId: baby.id,
      userId: USER_ID,
      milkType: 'breastmilk',
      startedAt: '2026-03-02T08:00:00.000Z',
    });
    const bottleDone = await finishBottleFeed({
      babyId: baby.id,
      userId: USER_ID,
      volumeMl: 90,
      at: '2026-03-02T08:15:00.000Z',
    });
    expect(bottleDone.payload.volumeMl).toBe(90);
    expect(bottleDone.endedAt).toBe('2026-03-02T08:15:00.000Z');

    const manualBottle = await logBottleFeed({
      babyId: baby.id,
      userId: USER_ID,
      volumeMl: 0,
      milkType: 'formula',
      startedAt: '2026-03-02T11:00:00.000Z',
      endedAt: '2026-03-02T11:05:00.000Z',
    });
    expect(manualBottle.payload.volumeMl).toBe(0);

    await startSleep({
      babyId: baby.id,
      category: 'nap',
      location: 'crib',
      userId: USER_ID,
      startedAt: '2026-03-02T09:00:00.000Z',
    });
    const sleepDone = await finishSleep({
      babyId: baby.id,
      userId: USER_ID,
      at: '2026-03-02T10:00:00.000Z',
    });
    expect(sleepDone.payload.category).toBe('nap');
    expect(sleepDone.payload.location).toBe('crib');

    const nightSleep = await logSleep({
      babyId: baby.id,
      category: 'night',
      userId: USER_ID,
      startedAt: '2026-03-02T20:00:00.000Z',
      endedAt: '2026-03-03T06:00:00.000Z',
    });
    expect(nightSleep.payload.category).toBe('night');

    const diaper = await logDiaper({
      babyId: baby.id,
      kind: 'both',
      userId: USER_ID,
      startedAt: '2026-03-02T10:05:00.000Z',
      amount: 'medium',
      hasRash: false,
    });
    expect(diaper.payload.kind).toBe('both');

    const spitUp = await logSpitUp({
      babyId: baby.id,
      userId: USER_ID,
      startedAt: '2026-03-02T08:20:00.000Z',
      severity: 'small',
      relatedFeedId: bottleDone.id,
      relatedFeedType: 'bottle_feed',
    });
    expect(spitUp.payload.relatedFeedId).toBe(bottleDone.id);

    await deleteEvent(manualBottle.id, USER_ID);
    const events = await listEventsForBaby(baby.id);
    expect(events).toHaveLength(5);

    const db = await getDb();
    const outbox = await db.getAll('outbox');
    const deleteMutations = outbox.filter(
      (m) => m.entityId === manualBottle.id && m.op === 'delete',
    );
    expect(deleteMutations).toHaveLength(1);
  });

  it('scopes active timers independently per baby (twins safe)', async () => {
    const twinA = await createBaby({
      name: 'Twin A',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });
    const twinB = await createBaby({
      name: 'Twin B',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });

    const feedA = await startBreastFeed({
      babyId: twinA.id,
      side: 'left',
      userId: USER_ID,
    });
    const sleepB = await startSleep({
      babyId: twinB.id,
      category: 'nap',
      userId: USER_ID,
    });

    const activeA = await getActiveTimersForBaby(twinA.id);
    const activeB = await getActiveTimersForBaby(twinB.id);

    expect(activeA.breastFeed?.id).toBe(feedA.id);
    expect(activeA.sleep).toBeNull();

    expect(activeB.breastFeed).toBeNull();
    expect(activeB.sleep?.id).toBe(sleepB.id);

    // Finishing Twin A's feed does not affect Twin B's sleep
    await finishBreastFeed({ babyId: twinA.id, userId: USER_ID });
    expect((await getActiveTimersForBaby(twinA.id)).breastFeed).toBeNull();
    expect((await getActiveTimersForBaby(twinB.id)).sleep?.id).toBe(sleepB.id);
  });

  it('logs and toggles daily vitamins idempotently and soft-deletes all same-day vitamin events on No', async () => {
    const { logVitamin, toggleVitaminForLocalDay } = await import('./store.js');
    const baby = await createBaby({
      name: 'Vit Baby',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });

    const tz = 'America/New_York';
    const dateKey = '2026-03-08'; // Spring-forward DST day
    const nowMs = Date.parse('2026-03-10T15:00:00.000Z');

    // Toggle Yes for historical DST day -> creates 1 event at local noon
    await toggleVitaminForLocalDay({
      babyId: baby.id,
      dateKey,
      timeZone: tz,
      given: true,
      userId: USER_ID,
      userName: 'Parent',
      nowMs,
    });

    let events = await listEventsForBaby(baby.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('vitamin');
    expect(events[0]!.endedAt).toBe(events[0]!.startedAt);

    // Calling toggle Yes again on same day is idempotent
    await toggleVitaminForLocalDay({
      babyId: baby.id,
      dateKey,
      timeZone: tz,
      given: true,
      userId: USER_ID,
      nowMs,
    });
    events = await listEventsForBaby(baby.id);
    expect(events).toHaveLength(1);

    // Simulate second parent logging offline on same day
    await logVitamin({
      babyId: baby.id,
      userId: USER_ID,
      startedAt: '2026-03-08T18:00:00.000Z',
    });
    expect(await listEventsForBaby(baby.id)).toHaveLength(2);

    // Toggle No -> soft-deletes BOTH same-day vitamin events
    await toggleVitaminForLocalDay({
      babyId: baby.id,
      dateKey,
      timeZone: tz,
      given: false,
      userId: USER_ID,
      nowMs,
    });
    expect(await listEventsForBaby(baby.id)).toHaveLength(0);
  });

  it('auto-ends active sleep on startBreastFeed, manual createEvent(breast_feed), startBottleFeed, logBottleFeed, and logDiaper with outbox upserts', async () => {
    const baby = await createBaby({
      name: 'Sleepy Baby',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });

    const t0 = '2026-03-10T10:00:00.000Z';

    // 1. startBreastFeed ends active sleep
    const sleep1 = await startSleep({
      babyId: baby.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: t0,
    });
    const t1 = '2026-03-10T10:30:00.000Z';
    const bf1 = await startBreastFeed({
      babyId: baby.id,
      side: 'left',
      userId: USER_ID,
      startedAt: t1,
    });
    expect((await getActiveTimersForBaby(baby.id)).sleep).toBeNull();
    let events = await listEventsForBaby(baby.id);
    expect(events.find((e) => e.id === sleep1.id)?.endedAt).toBe(bf1.startedAt);
    await finishBreastFeed({
      babyId: baby.id,
      userId: USER_ID,
      at: '2026-03-10T10:40:00.000Z',
    });

    // Check outbox has an upsert for ended sleep1
    const db = await getDb();
    let outbox = await db.getAll('outbox');
    const sleep1Upserts = outbox.filter(
      (m) => m.entityId === sleep1.id && m.op === 'upsert',
    );
    expect(sleep1Upserts.length).toBeGreaterThanOrEqual(2);
    expect(
      sleep1Upserts.some(
        (m) => (m.data as { endedAt: string | null }).endedAt === bf1.startedAt,
      ),
    ).toBe(true);

    // 2. createEvent (manual breast_feed) ends active sleep
    const sleep2 = await startSleep({
      babyId: baby.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T11:00:00.000Z',
    });
    const manualBf = await createEvent({
      id: crypto.randomUUID(),
      babyId: baby.id,
      type: 'breast_feed',
      startedAt: '2026-03-10T11:45:00.000Z',
      endedAt: '2026-03-10T12:00:00.000Z',
      notes: null,
      loggedByUserId: USER_ID,
      loggedByName: null,
      updatedByUserId: USER_ID,
      createdAt: '2026-03-10T12:00:00.000Z',
      updatedAt: '2026-03-10T12:00:00.000Z',
      deletedAt: null,
      serverSeq: 0,
      payload: {
        segments: [
          {
            side: 'right',
            startedAt: '2026-03-10T11:45:00.000Z',
            endedAt: '2026-03-10T12:00:00.000Z',
          },
        ],
        pausedAt: null,
        totalLeftSeconds: 0,
        totalRightSeconds: 900,
      },
    });
    expect((await getActiveTimersForBaby(baby.id)).sleep).toBeNull();
    events = await listEventsForBaby(baby.id);
    expect(events.find((e) => e.id === sleep2.id)?.endedAt).toBe(manualBf.startedAt);

    // 3. startBottleFeed ends active sleep
    const sleep3 = await startSleep({
      babyId: baby.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T13:00:00.000Z',
    });
    const bottleStart = await startBottleFeed({
      babyId: baby.id,
      milkType: 'formula',
      userId: USER_ID,
      startedAt: '2026-03-10T13:20:00.000Z',
    });
    expect((await getActiveTimersForBaby(baby.id)).sleep).toBeNull();
    events = await listEventsForBaby(baby.id);
    expect(events.find((e) => e.id === sleep3.id)?.endedAt).toBe(
      bottleStart.startedAt,
    );
    await finishBottleFeed({
      babyId: baby.id,
      userId: USER_ID,
      volumeMl: 90,
      at: '2026-03-10T13:30:00.000Z',
    });

    // 4. logBottleFeed ends active sleep
    const sleep4 = await startSleep({
      babyId: baby.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T14:00:00.000Z',
    });
    const manualBottle = await logBottleFeed({
      babyId: baby.id,
      milkType: 'breastmilk',
      volumeMl: 100,
      userId: USER_ID,
      startedAt: '2026-03-10T14:25:00.000Z',
      endedAt: '2026-03-10T14:35:00.000Z',
    });
    expect((await getActiveTimersForBaby(baby.id)).sleep).toBeNull();
    events = await listEventsForBaby(baby.id);
    expect(events.find((e) => e.id === sleep4.id)?.endedAt).toBe(
      manualBottle.startedAt,
    );

    // 5. logDiaper ends active sleep
    const sleep5 = await startSleep({
      babyId: baby.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T15:00:00.000Z',
    });
    const diaper = await logDiaper({
      babyId: baby.id,
      kind: 'wet',
      userId: USER_ID,
      startedAt: '2026-03-10T15:15:00.000Z',
    });
    expect((await getActiveTimersForBaby(baby.id)).sleep).toBeNull();
    events = await listEventsForBaby(baby.id);
    expect(events.find((e) => e.id === sleep5.id)?.endedAt).toBe(diaper.startedAt);

    outbox = await db.getAll('outbox');
    const sleep5Upserts = outbox.filter(
      (m) => m.entityId === sleep5.id && m.op === 'upsert',
    );
    expect(
      sleep5Upserts.some(
        (m) =>
          (m.data as { endedAt: string | null }).endedAt === diaper.startedAt,
      ),
    ).toBe(true);
  });

  it('does NOT end active sleep on spit_up, vitamin, backdated events, or other twin events', async () => {
    const twinA = await createBaby({
      name: 'Twin A',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });
    const twinB = await createBaby({
      name: 'Twin B',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });

    const sleepA = await startSleep({
      babyId: twinA.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T12:00:00.000Z',
    });
    const sleepB = await startSleep({
      babyId: twinB.id,
      category: 'night',
      userId: USER_ID,
      startedAt: '2026-03-10T12:00:00.000Z',
    });

    // Spit up does NOT end active sleep
    await logSpitUp({
      babyId: twinA.id,
      severity: 'small',
      userId: USER_ID,
      startedAt: '2026-03-10T12:10:00.000Z',
    });
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Vitamin (direct logVitamin and toggleVitaminForLocalDay) does NOT end active sleep
    await logVitamin({
      babyId: twinA.id,
      userId: USER_ID,
      startedAt: '2026-03-10T12:15:00.000Z',
    });
    await toggleVitaminForLocalDay({
      babyId: twinA.id,
      dateKey: '2026-03-10',
      timeZone: 'UTC',
      given: true,
      userId: USER_ID,
      nowMs: Date.parse('2026-03-10T12:20:00.000Z'),
    });
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Backdated manual feed/diaper (startedAt < sleepA.startedAt) does NOT end active sleep
    await logDiaper({
      babyId: twinA.id,
      kind: 'poopy',
      userId: USER_ID,
      startedAt: '2026-03-10T11:30:00.000Z',
    });
    await logBottleFeed({
      babyId: twinA.id,
      milkType: 'formula',
      volumeMl: 50,
      userId: USER_ID,
      startedAt: '2026-03-10T11:00:00.000Z',
      endedAt: '2026-03-10T11:10:00.000Z',
    });
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Logging a feed/diaper for Twin A ends Twin A's sleep, NOT Twin B's sleep
    await logDiaper({
      babyId: twinA.id,
      kind: 'wet',
      userId: USER_ID,
      startedAt: '2026-03-10T12:30:00.000Z',
    });
    expect((await getActiveTimersForBaby(twinA.id)).sleep).toBeNull();
    expect((await getActiveTimersForBaby(twinB.id)).sleep?.id).toBe(sleepB.id);
  });

  it('tracks pumping and tummy_time timers, rejects duplicates, clamps endedAt, trims notes, and enforces asymmetric auto-end sleep', async () => {
    const twinA = await createBaby({
      name: 'Twin A',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });
    const twinB = await createBaby({
      name: 'Twin B',
      dob: '2026-01-01',
      createdByUserId: USER_ID,
    });

    // Start active sleep for both twins
    const sleepA = await startSleep({
      babyId: twinA.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T10:00:00.000Z',
    });
    const sleepB = await startSleep({
      babyId: twinB.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-03-10T10:00:00.000Z',
    });

    // Starting & logging pumping MUST NOT auto-end active sleep
    const activePump = await startPumping({
      babyId: twinA.id,
      userId: USER_ID,
      startedAt: '2026-03-10T10:05:00.000Z',
      notes: '   ',
    });
    expect(activePump.notes).toBeNull();
    expect(activePump.payload.side).toBe('both');
    expect((await getActiveTimersForBaby(twinA.id)).pumping?.id).toBe(activePump.id);
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Duplicate active pumping rejected
    await expect(
      startPumping({ babyId: twinA.id, userId: USER_ID }),
    ).rejects.toThrow(/already running/i);

    // Finishing pumping clamps endedAt >= startedAt and preserves volume/side
    const finishedPump = await finishPumping({
      babyId: twinA.id,
      userId: USER_ID,
      side: 'both',
      volumeMl: 120,
      leftVolumeMl: 55,
      rightVolumeMl: 65,
      at: '2026-03-10T10:00:00.000Z', // earlier than startedAt -> clamped
      notes: '  Double electric  ',
    });
    expect(finishedPump.endedAt).toBe(activePump.startedAt);
    expect(finishedPump.payload.volumeMl).toBe(120);
    expect(finishedPump.payload.leftVolumeMl).toBe(55);
    expect(finishedPump.payload.rightVolumeMl).toBe(65);
    expect(finishedPump.notes).toBe('Double electric');
    expect((await getActiveTimersForBaby(twinA.id)).pumping).toBeNull();
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Manual pumping log also preserves active sleep and distinguishes 0 ml
    const manualPump = await logPumping({
      babyId: twinA.id,
      userId: USER_ID,
      startedAt: '2026-03-10T10:10:00.000Z',
      endedAt: '2026-03-10T10:25:00.000Z',
      side: 'left',
      volumeMl: 0,
      notes: '',
    });
    expect(manualPump.payload.volumeMl).toBe(0);
    expect(manualPump.notes).toBeNull();
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Backdated tummy_time (startedAt < sleepA.startedAt) does NOT auto-end sleepA
    await logTummyTime({
      babyId: twinA.id,
      userId: USER_ID,
      startedAt: '2026-03-10T09:30:00.000Z',
      endedAt: '2026-03-10T09:35:00.000Z',
      mood: 'happy',
      notes: '  Morning mat  ',
    });
    expect((await getActiveTimersForBaby(twinA.id)).sleep?.id).toBe(sleepA.id);

    // Starting tummy_time DOES auto-end Twin A's active sleep, but NOT Twin B's
    const activeTummy = await startTummyTime({
      babyId: twinA.id,
      userId: USER_ID,
      startedAt: '2026-03-10T10:30:00.000Z',
    });
    expect((await getActiveTimersForBaby(twinA.id)).tummyTime?.id).toBe(activeTummy.id);
    expect((await getActiveTimersForBaby(twinA.id)).sleep).toBeNull();
    expect((await getActiveTimersForBaby(twinB.id)).sleep?.id).toBe(sleepB.id);

    const eventsA = await listEventsForBaby(twinA.id);
    expect(eventsA.find((e) => e.id === sleepA.id)?.endedAt).toBe(
      activeTummy.startedAt,
    );

    // Duplicate active tummy_time rejected
    await expect(
      startTummyTime({ babyId: twinA.id, userId: USER_ID }),
    ).rejects.toThrow(/already running/i);

    // Finish tummy_time
    const finishedTummy = await finishTummyTime({
      babyId: twinA.id,
      userId: USER_ID,
      mood: 'neutral',
      at: '2026-03-10T10:36:00.000Z',
      notes: '   ',
    });
    expect(finishedTummy.endedAt).toBe('2026-03-10T10:36:00.000Z');
    expect(finishedTummy.payload.mood).toBe('neutral');
    expect(finishedTummy.notes).toBeNull();
    expect((await getActiveTimersForBaby(twinA.id)).tummyTime).toBeNull();
  });

  it('inserts an optimistic parent BabyMember row when creating a baby', async () => {
    const baby = await createBaby({
      name: 'Ansel',
      dob: '2026-04-01',
      createdByUserId: USER_ID,
      createdByDisplayName: 'Jeremy',
    });

    const members = await listBabyMembers(baby.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      babyId: baby.id,
      userId: USER_ID,
      displayName: 'Jeremy',
      role: 'parent',
      deletedAt: null,
    });
  });

  it('imports JSON backup events idempotently, supports overwrite/soft-delete restore, does not auto-end active sleep, remaps cross-baby IDs, and enforces allowPumping', async () => {
    const babyA = await createBaby({
      name: 'Baby A',
      dob: '2026-03-01',
      createdByUserId: USER_ID,
    });
    const babyB = await createBaby({
      name: 'Baby B',
      dob: '2026-03-02',
      createdByUserId: USER_ID,
    });

    const feed = await logBottleFeed({
      babyId: babyA.id,
      userId: USER_ID,
      startedAt: '2026-04-01T10:00:00.000Z',
      endedAt: '2026-04-01T10:15:00.000Z',
      volumeMl: 90,
      milkType: 'breastmilk',
      notes: 'original note',
    });
    const spitUp = await logSpitUp({
      babyId: babyA.id,
      userId: USER_ID,
      startedAt: '2026-04-01T10:20:00.000Z',
      severity: 'small',
      relatedFeedId: feed.id,
    });
    const pump = await logPumping({
      babyId: babyA.id,
      userId: USER_ID,
      startedAt: '2026-04-01T11:00:00.000Z',
      endedAt: '2026-04-01T11:15:00.000Z',
      volumeMl: 120,
      side: 'both',
    });
    const deletedDiaper = await logDiaper({
      babyId: babyA.id,
      userId: USER_ID,
      kind: 'wet',
      startedAt: '2026-04-01T12:00:00.000Z',
    });
    await deleteEvent(deletedDiaper.id, USER_ID);

    // Start an active sleep BEFORE the imported historical events to verify no auto-end
    const activeSleep = await startSleep({
      babyId: babyA.id,
      category: 'nap',
      userId: USER_ID,
      startedAt: '2026-04-01T09:00:00.000Z',
    });

    // 1. Same-baby idempotency + soft-delete restore
    const backupEvents = [
      { ...feed, notes: 'edited in backup' },
      spitUp,
      pump,
      { ...deletedDiaper, deletedAt: null },
    ];

    const res1 = await importEventsForBaby({
      babyId: babyA.id,
      backupBabyId: babyA.id,
      events: backupEvents,
      userId: USER_ID,
      allowPumping: true,
      overwriteExisting: false,
    });
    expect(res1).toMatchObject({
      importedCount: 1, // restored deletedDiaper
      overwrittenCount: 0,
      skippedExistingCount: 3, // feed, spitUp, pump already active
      skippedPumpingCount: 0,
      skippedDeletedCount: 0,
    });

    // Active sleep must still be running (not auto-ended by import)
    expect((await getActiveTimersForBaby(babyA.id)).sleep?.id).toBe(
      activeSleep.id,
    );
    const afterRestore = await listEventsForBaby(babyA.id);
    expect(afterRestore.find((e) => e.id === deletedDiaper.id)?.deletedAt).toBeNull();
    expect(afterRestore.find((e) => e.id === feed.id)?.notes).toBe('original note');

    // 2. Same-baby overwriteExisting: true
    const res2 = await importEventsForBaby({
      babyId: babyA.id,
      backupBabyId: babyA.id,
      events: [{ ...feed, notes: 'edited in backup' }],
      userId: USER_ID,
      allowPumping: true,
      overwriteExisting: true,
    });
    expect(res2.overwrittenCount).toBe(1);
    const afterOverwrite = await listEventsForBaby(babyA.id);
    expect(afterOverwrite.find((e) => e.id === feed.id)?.notes).toBe(
      'edited in backup',
    );

    // 3. Different-baby import with allowPumping: false + relatedFeedId remapping
    const res3 = await importEventsForBaby({
      babyId: babyB.id,
      backupBabyId: babyA.id,
      events: [feed, spitUp, pump],
      userId: USER_ID,
      allowPumping: false,
    });
    expect(res3).toMatchObject({
      importedCount: 2, // feed + spitUp
      overwrittenCount: 0,
      skippedExistingCount: 0,
      skippedPumpingCount: 1, // pump skipped
      skippedDeletedCount: 0,
    });

    const babyBEvents = await listEventsForBaby(babyB.id);
    expect(babyBEvents).toHaveLength(2);
    expect(babyBEvents.some((e) => e.type === 'pumping')).toBe(false);
    const copiedFeed = babyBEvents.find((e) => e.type === 'bottle_feed')!;
    const copiedSpitUp = babyBEvents.find((e) => e.type === 'spit_up')!;
    expect(copiedFeed.id).not.toBe(feed.id);
    expect(copiedSpitUp.id).not.toBe(spitUp.id);
    expect(copiedSpitUp.type === 'spit_up' && copiedSpitUp.payload.relatedFeedId).toBe(
      copiedFeed.id,
    );
  });
});
