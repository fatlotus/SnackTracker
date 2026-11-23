import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Baby, TrackingEvent } from '@baby-tracker/shared';
import { closeDb, DB_NAME, getDb } from './db.js';
import { createBaby, logDiaper } from './store.js';
import {
  computeBackoffDelayMs,
  LAST_SYNC_SEQ_META_KEY,
  resetSyncStateForTest,
  startSyncLoop,
  syncOnce,
} from './sync.js';

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

describe('sync engine', () => {
  beforeEach(async () => {
    resetSyncStateForTest();
    await clearDatabase();
  });

  afterEach(() => {
    resetSyncStateForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('pushes outbox mutations, removes acked items, pulls deltas, and updates last_sync_seq', async () => {
    const baby = await createBaby({
      name: 'Oliver',
      dob: '2026-01-20',
      createdByUserId: USER_ID,
    });
    const diaper = await logDiaper({
      babyId: baby.id,
      kind: 'wet',
      userId: USER_ID,
    });

    const db = await getDb();
    const outboxBefore = await db.getAll('outbox');
    expect(outboxBefore).toHaveLength(2);

    const remoteBaby: Baby = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Remote Baby',
      dob: '2026-02-02',
      birthWeightGrams: null,
      avatarColor: '#2563eb',
      notes: null,
      isArchived: false,
      createdByUserId: USER_ID,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      deletedAt: null,
      serverSeq: 5,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/sync/push') {
        return new Response(
          JSON.stringify({
            ackedMutationIds: outboxBefore.map((m) => m.mutationId),
            rejected: [],
            latestSeq: 4,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/sync/pull?since_seq=0')) {
        return new Response(
          JSON.stringify({
            babies: [remoteBaby],
            members: [],
            events: [{ ...diaper, serverSeq: 4 }],
            latestSeq: 5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const status = await syncOnce();
    expect(status.state).toBe('idle');
    expect(status.pendingCount).toBe(0);
    expect(status.consecutiveFailures).toBe(0);

    expect(await db.count('outbox')).toBe(0);
    expect((await db.get('babies', remoteBaby.id))?.name).toBe('Remote Baby');
    expect((await db.get('sync_meta', LAST_SYNC_SEQ_META_KEY))?.value).toBe(5);
  });

  it('defers pull overwrite for entityIds still present in outbox', async () => {
    const baby = await createBaby({
      name: 'Local Name',
      dob: '2026-01-20',
      createdByUserId: USER_ID,
    });
    const diaper = await logDiaper({
      babyId: baby.id,
      kind: 'poopy',
      userId: USER_ID,
      notes: 'local pending edit',
    });

    const db = await getDb();
    const outboxItems = await db.getAll('outbox');
    const diaperMutation = outboxItems.find((m) => m.entityId === diaper.id)!;
    const babyMutation = outboxItems.find((m) => m.entityId === baby.id)!;

    // Server rejects diaperMutation so it stays in outbox, while acking babyMutation
    const staleServerDiaper: TrackingEvent = {
      ...diaper,
      notes: 'stale server note that must NOT overwrite local',
      serverSeq: 10,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/sync/push') {
        return new Response(
          JSON.stringify({
            ackedMutationIds: [babyMutation.mutationId],
            rejected: [
              {
                mutationId: diaperMutation.mutationId,
                reason: 'temporary conflict',
              },
            ],
            latestSeq: 10,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/sync/pull')) {
        return new Response(
          JSON.stringify({
            babies: [{ ...baby, name: 'Server Synced Name', serverSeq: 9 }],
            members: [],
            events: [staleServerDiaper],
            latestSeq: 10,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const status = await syncOnce();
    expect(status.pendingCount).toBe(1);

    // Acked baby WAS updated by pull
    expect((await db.get('babies', baby.id))?.name).toBe('Server Synced Name');

    // Pending diaper in outbox was NOT overwritten by pull
    const storedDiaper = await db.get('events', diaper.id);
    expect(storedDiaper?.notes).toBe('local pending edit');

    const remainingOutbox = await db.get('outbox', diaperMutation.mutationId);
    expect(remainingOutbox?.attempts).toBe(1);
    expect(remainingOutbox?.lastError).toBe('temporary conflict');
  });

  it('computes exponential backoff and retries failed syncs', async () => {
    expect(computeBackoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(computeBackoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(computeBackoffDelayMs(3, 1000, 60_000)).toBe(4000);
    expect(computeBackoffDelayMs(10, 1000, 60_000)).toBe(60_000);

    vi.useFakeTimers();

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ message: 'Cold start' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          babies: [],
          members: [],
          events: [],
          latestSeq: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const stop = startSyncLoop({
      pollIntervalMs: 60_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
    });

    // Flush initial syncOnce failure
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Advance past 100ms backoff retry
    await vi.advanceTimersByTimeAsync(120);
    expect(callCount).toBe(2);

    stop();
  });

  it('defers mid-sync local writes and preserves offline state if offline event fires during pull', async () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { onLine: true });

    const baby = await createBaby({
      name: 'Oliver',
      dob: '2026-01-20',
      createdByUserId: USER_ID,
    });

    let midPullDiaperId = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/sync/push') {
        return new Response(
          JSON.stringify({
            ackedMutationIds: [],
            rejected: [],
            latestSeq: 5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/sync/pull')) {
        // Concurrent local write + offline transition while pull is in flight
        const diaper = await logDiaper({
          babyId: baby.id,
          kind: 'wet',
          userId: USER_ID,
          notes: 'local mid-pull write',
        });
        midPullDiaperId = diaper.id;
        fakeWindow.dispatchEvent(new Event('offline'));

        const staleServerDiaper: TrackingEvent = {
          ...diaper,
          notes: 'stale server note that must NOT overwrite local',
          serverSeq: 6,
        };
        return new Response(
          JSON.stringify({
            babies: [],
            members: [],
            events: [staleServerDiaper],
            latestSeq: 6,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Trigger initial syncOnce via startSyncLoop so offline listener is active
    const stop = startSyncLoop({ pollIntervalMs: 60_000 });
    await vi.waitFor(() => {
      expect(midPullDiaperId).not.toBe('');
    });
    // Wait for the in-flight syncOnce to settle
    const finalStatus = await syncOnce();

    expect(finalStatus.state).toBe('offline');
    const db = await getDb();
    const storedDiaper = await db.get('events', midPullDiaperId);
    expect(storedDiaper?.notes).toBe('local mid-pull write');
    const outbox = await db.getAll('outbox');
    expect(outbox.some((item) => item.entityId === midPullDiaperId)).toBe(true);

    stop();
  });

  it('does not schedule retryTimer on non-retryable 401 error and preserves outbox', async () => {
    const baby = await createBaby({
      name: 'Oliver',
      dob: '2026-01-20',
      createdByUserId: USER_ID,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const status = await syncOnce();
    expect(status.state).toBe('error');
    expect(status.nextRetryAt).toBeNull();
    expect(status.pendingCount).toBe(1);

    const db = await getDb();
    const outbox = await db.getAll('outbox');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.entityId).toBe(baby.id);
  });

  it('still syncs when navigator.onLine is falsely false and the network succeeds', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('window', {
      location: { hostname: 'babysnacktrack.com' },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/sync/pull')) {
        return new Response(
          JSON.stringify({
            babies: [],
            members: [],
            events: [],
            latestSeq: 3,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const status = await syncOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('idle');
    expect(status.lastError).toBeNull();
  });

  it('enters offline state when navigator.onLine is false and fetch throws a network error', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('window', {
      location: { hostname: 'babysnacktrack.com' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const status = await syncOnce();
    expect(status.state).toBe('offline');
  });
});
