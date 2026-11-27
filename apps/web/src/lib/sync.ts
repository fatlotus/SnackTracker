import {
  canAccessPumping,
  SyncPullResponseSchema,
  SyncPushResponseSchema,
} from '@baby-tracker/shared';
import { ApiError, apiFetch } from './api.js';
import { getDb, nowIso } from './db.js';
import { notifyStoreChange, subscribeStore } from './store.js';

export const LAST_SYNC_SEQ_META_KEY = 'last_sync_seq';
const CURRENT_USER_META_KEY = 'current_user';
export const SYNC_PUSH_BATCH_SIZE = 100;
export const DEFAULT_POLL_INTERVAL_MS = 12_000;
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const STORE_SYNC_DEBOUNCE_MS = 150;

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline';
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRetryAt: number | null;
}

export interface SyncOptions {
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  currentUserId?: string;
}

type SyncStatusListener = (status: SyncStatus) => void;

const syncListeners = new Set<SyncStatusListener>();

let currentStatus: SyncStatus = {
  state: 'idle',
  pendingCount: 0,
  lastSyncedAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextRetryAt: null,
};

let inFlightSync: Promise<SyncStatus> | null = null;
let queuedSync: Promise<SyncStatus> | null = null;
let resyncRequested = false;
let notifyingFromSync = false;
let explicitOffline = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let activeLoopCleanup: (() => void) | null = null;
let activeBaseBackoffMs = DEFAULT_BASE_BACKOFF_MS;
let activeMaxBackoffMs = DEFAULT_MAX_BACKOFF_MS;

export function getSyncStatus(): SyncStatus {
  return { ...currentStatus };
}

export function subscribeSyncStatus(listener: SyncStatusListener): () => void {
  syncListeners.add(listener);
  listener(getSyncStatus());
  return () => {
    syncListeners.delete(listener);
  };
}

function setSyncStatus(patch: Partial<SyncStatus>): SyncStatus {
  currentStatus = { ...currentStatus, ...patch };
  const snapshot = getSyncStatus();
  for (const listener of syncListeners) {
    try {
      listener(snapshot);
    } catch {
      // Ignore subscriber errors
    }
  }
  return snapshot;
}

export function computeBackoffDelayMs(
  consecutiveFailures: number,
  baseMs: number = DEFAULT_BASE_BACKOFF_MS,
  maxMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return 0;
  const delay = baseMs * Math.pow(2, consecutiveFailures - 1);
  return Math.min(maxMs, delay);
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status >= 500 || err.status === 408 || err.status === 429;
  }
  return true;
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(delayMs: number): void {
  clearRetryTimer();
  if (!activeLoopCleanup) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncOnce();
  }, delayMs);
}

export function isNavigatorOffline(): boolean {
  if (explicitOffline) {
    return true;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const isLoopback =
      typeof window !== 'undefined' &&
      (window.location.hostname === '127.0.0.1' ||
        window.location.hostname === 'localhost');
    if (isLoopback) {
      return false;
    }
    return true;
  }
  return false;
}

export function resetSyncStateForTest(): void {
  stopSyncLoop();
  inFlightSync = null;
  queuedSync = null;
  resyncRequested = false;
  notifyingFromSync = false;
  explicitOffline = false;
  activeBaseBackoffMs = DEFAULT_BASE_BACKOFF_MS;
  activeMaxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
  currentStatus = {
    state: 'idle',
    pendingCount: 0,
    lastSyncedAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
  };
}

export async function syncOnce(options: SyncOptions = {}): Promise<SyncStatus> {
  if (inFlightSync) {
    if (explicitOffline) {
      return inFlightSync;
    }
    if (!queuedSync) {
      queuedSync = inFlightSync
        .catch(() => currentStatus)
        .then(() => {
          queuedSync = null;
          resyncRequested = false;
          return syncOnce(options);
        });
    }
    return queuedSync;
  }

  const baseBackoffMs = options.baseBackoffMs ?? activeBaseBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? activeMaxBackoffMs;

  inFlightSync = (async () => {
    const db = await getDb();
    const initialPending = await db.count('outbox');

    if (explicitOffline) {
      return setSyncStatus({
        state: 'offline',
        pendingCount: initialPending,
      });
    }

    setSyncStatus({
      state: 'syncing',
      pendingCount: initialPending,
      lastError: null,
    });

    try {
      // 1. Push outbox mutations in creation order, chunked to avoid body-size limits
      const outboxItems = await db.getAllFromIndex('outbox', 'by-createdAt');
      for (
        let offset = 0;
        offset < outboxItems.length;
        offset += SYNC_PUSH_BATCH_SIZE
      ) {
        const batch = outboxItems.slice(offset, offset + SYNC_PUSH_BATCH_SIZE);
        const pushRes = await apiFetch(
          '/api/sync/push',
          {
            method: 'POST',
            body: JSON.stringify({
              mutations: batch.map((item) => ({
                mutationId: item.mutationId,
                entityType: item.entityType,
                op: item.op,
                data: item.data,
                clientUpdatedAt: item.clientUpdatedAt,
              })),
            }),
          },
          SyncPushResponseSchema,
        );

        const ackedSet = new Set(pushRes.ackedMutationIds);
        const rejectedMap = new Map(
          pushRes.rejected.map((r) => [r.mutationId, r.reason]),
        );

        if (ackedSet.size > 0 || rejectedMap.size > 0) {
          const tx = db.transaction('outbox', 'readwrite');
          const store = tx.objectStore('outbox');
          for (const mutationId of ackedSet) {
            await store.delete(mutationId);
          }
          for (const [mutationId, reason] of rejectedMap.entries()) {
            const item = await store.get(mutationId);
            if (item) {
              await store.put({
                ...item,
                attempts: item.attempts + 1,
                lastError: reason,
              });
            }
          }
          await tx.done;
        }
      }

      // 2. Pull incremental deltas since last_sync_seq
      const seqMeta = await db.get('sync_meta', LAST_SYNC_SEQ_META_KEY);
      const sinceSeq =
        seqMeta && typeof seqMeta.value === 'number' && seqMeta.value >= 0
          ? seqMeta.value
          : 0;

      const pullRes = await apiFetch(
        `/api/sync/pull?since_seq=${sinceSeq}`,
        { method: 'GET' },
        SyncPullResponseSchema,
      );

      // Defer overwrite for any entityId that still has pending mutations in outbox
      // (read outbox inside the same readwrite tx for strict atomicity)
      const mergeTx = db.transaction(
        ['babies', 'baby_members', 'events', 'outbox', 'sync_meta'],
        'readwrite',
      );
      const babiesStore = mergeTx.objectStore('babies');
      const membersStore = mergeTx.objectStore('baby_members');
      const eventsStore = mergeTx.objectStore('events');
      const outboxStore = mergeTx.objectStore('outbox');
      const metaStore = mergeTx.objectStore('sync_meta');

      const remainingOutbox = await outboxStore.getAll();
      const pendingEntityIds = new Set(
        remainingOutbox.map((item) => item.entityId),
      );

      for (const baby of pullRes.babies) {
        if (!pendingEntityIds.has(baby.id)) {
          await babiesStore.put(baby);
        }
      }

      if (pullRes.members.length > 0) {
        const existingMembers = await membersStore.getAll();
        for (const member of pullRes.members) {
          for (const existing of existingMembers) {
            if (
              existing.babyId === member.babyId &&
              existing.userId === member.userId &&
              existing.id !== member.id
            ) {
              await membersStore.delete(existing.id);
            }
          }
          await membersStore.put(member);
        }
      }

      for (const event of pullRes.events) {
        if (!pendingEntityIds.has(event.id)) {
          await eventsStore.put(event);
        }
      }

      // Purge cached pumping events (including active pumping timers) for any
      // baby where the signed-in user's role does not allow pumping access.
      let signedInUserId = options.currentUserId ?? null;
      if (!signedInUserId) {
        const currentUserMeta = await metaStore.get(CURRENT_USER_META_KEY);
        if (
          currentUserMeta &&
          typeof currentUserMeta.value === 'object' &&
          currentUserMeta.value !== null &&
          'id' in currentUserMeta.value &&
          typeof (currentUserMeta.value as { id?: unknown }).id === 'string'
        ) {
          signedInUserId = (currentUserMeta.value as { id: string }).id;
        }
      }

      if (signedInUserId) {
        const allMembers = await membersStore.getAll();
        const restrictedBabyIds = new Set<string>();
        const parentBabyIds = new Set<string>();

        for (const m of allMembers) {
          if (m.userId !== signedInUserId) continue;
          if (!m.deletedAt && canAccessPumping(m.role)) {
            parentBabyIds.add(m.babyId);
          } else if (!m.deletedAt && !canAccessPumping(m.role)) {
            restrictedBabyIds.add(m.babyId);
          }
        }

        for (const babyId of restrictedBabyIds) {
          if (parentBabyIds.has(babyId)) continue;
          const babyEvents = await eventsStore
            .index('by-babyId')
            .getAll(babyId);
          for (const ev of babyEvents) {
            if (ev.type === 'pumping') {
              await eventsStore.delete(ev.id);
            }
          }
        }
      }

      const nextSeq = Math.max(sinceSeq, pullRes.latestSeq);
      await metaStore.put({
        key: LAST_SYNC_SEQ_META_KEY,
        value: nextSeq,
      });

      await mergeTx.done;

      clearRetryTimer();
      notifyingFromSync = true;
      try {
        notifyStoreChange();
      } finally {
        notifyingFromSync = false;
      }

      return setSyncStatus({
        state: explicitOffline ? 'offline' : 'idle',
        pendingCount: remainingOutbox.length,
        lastSyncedAt: nowIso(),
        lastError: null,
        consecutiveFailures: 0,
        nextRetryAt: null,
      });
    } catch (err) {
      const pendingCount = await db.count('outbox');
      if (explicitOffline || (!(err instanceof ApiError) && isNavigatorOffline())) {
        return setSyncStatus({
          state: 'offline',
          pendingCount,
        });
      }
      const failures = currentStatus.consecutiveFailures + 1;
      const message =
        err instanceof Error ? err.message : 'Sync failed with unknown error';

      let nextRetryAt: number | null = null;
      if (isRetryableError(err)) {
        const delayMs = computeBackoffDelayMs(
          failures,
          baseBackoffMs,
          maxBackoffMs,
        );
        nextRetryAt = Date.now() + delayMs;
        scheduleRetry(delayMs);
      }

      return setSyncStatus({
        state: 'error',
        pendingCount,
        lastError: message,
        consecutiveFailures: failures,
        nextRetryAt,
      });
    } finally {
      inFlightSync = null;
      if (resyncRequested && !queuedSync) {
        resyncRequested = false;
        if (!explicitOffline) {
          queueMicrotask(() => {
            void syncOnce();
          });
        }
      } else {
        resyncRequested = false;
      }
    }
  })();

  return inFlightSync;
}

export function startSyncLoop(options: SyncOptions = {}): () => void {
  stopSyncLoop();

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  activeBaseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  activeMaxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let disposed = false;
  let storeSyncTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStoreSyncTimer = () => {
    if (storeSyncTimer !== null) {
      clearTimeout(storeSyncTimer);
      storeSyncTimer = null;
    }
  };

  const handleOnline = () => {
    explicitOffline = false;
    clearRetryTimer();
    void syncOnce();
  };

  const handleOffline = () => {
    explicitOffline = true;
    clearRetryTimer();
    clearStoreSyncTimer();
    void (async () => {
      try {
        const db = await getDb();
        const pendingCount = await db.count('outbox');
        if (!disposed) {
          setSyncStatus({
            state: 'offline',
            pendingCount,
          });
        }
      } catch {
        if (!disposed) {
          setSyncStatus({ state: 'offline' });
        }
      }
    })();
  };

  const handleFocus = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    void syncOnce();
  };

  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void syncOnce();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleFocus);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (explicitOffline) {
      return;
    }
    if (
      currentStatus.nextRetryAt !== null &&
      Date.now() < currentStatus.nextRetryAt
    ) {
      return;
    }
    void syncOnce();
  }, pollIntervalMs);

  const unsubscribeStore = subscribeStore(() => {
    if (disposed || notifyingFromSync) return;
    if (explicitOffline) {
      return;
    }
    void (async () => {
      try {
        const db = await getDb();
        const pendingCount = await db.count('outbox');
        if (disposed || pendingCount <= 0) return;
        if (explicitOffline) {
          return;
        }
        if (inFlightSync !== null) {
          resyncRequested = true;
          return;
        }
        clearStoreSyncTimer();
        storeSyncTimer = setTimeout(() => {
          storeSyncTimer = null;
          if (!disposed) {
            void syncOnce();
          }
        }, STORE_SYNC_DEBOUNCE_MS);
      } catch {
        // Ignore IDB errors during teardown
      }
    })();
  });

  const cleanup = () => {
    disposed = true;
    resyncRequested = false;
    explicitOffline = false;
    clearStoreSyncTimer();
    unsubscribeStore();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    clearRetryTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleFocus);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    activeLoopCleanup = null;
  };

  activeLoopCleanup = cleanup;
  void syncOnce();
  return cleanup;
}

export function stopSyncLoop(): void {
  resyncRequested = false;
  explicitOffline = false;
  if (activeLoopCleanup) {
    activeLoopCleanup();
  }
}
