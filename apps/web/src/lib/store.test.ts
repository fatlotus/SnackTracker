import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, DB_NAME, getDb } from './db.js';
import {
  computeBreastFeedElapsed,
  createBaby,
  deleteBaby,
  deleteEvent,
  finishBottleFeed,
  finishBreastFeed,
  finishSleep,
  getActiveTimersForBaby,
  getBaby,
  listBabies,
  listEventsForBaby,
  logBottleFeed,
  logDiaper,
  logSleep,
  logSpitUp,
  pauseBreastFeed,
  resumeBreastFeed,
  startBottleFeed,
  startBreastFeed,
  startSleep,
  subscribeStore,
  switchBreastSide,
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
});
