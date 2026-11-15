import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Baby,
  BabyMember,
  SyncEntityType,
  SyncOp,
  TrackingEvent,
} from '@baby-tracker/shared';

export const DB_NAME = 'baby-tracker-db';
export const DB_VERSION = 1;

export interface OutboxItem {
  mutationId: string;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  data: Record<string, unknown>;
  clientUpdatedAt: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export interface SyncMetaItem {
  key: string;
  value: unknown;
}

export interface BabyTrackerDB extends DBSchema {
  babies: {
    key: string;
    value: Baby;
  };
  baby_members: {
    key: string;
    value: BabyMember;
    indexes: {
      'by-babyId': string;
    };
  };
  events: {
    key: string;
    value: TrackingEvent;
    indexes: {
      'by-babyId': string;
      'by-babyId-startedAt': [string, string];
    };
  };
  outbox: {
    key: string;
    value: OutboxItem;
    indexes: {
      'by-entityId': string;
      'by-createdAt': string;
    };
  };
  sync_meta: {
    key: string;
    value: SyncMetaItem;
  };
}

let dbPromise: Promise<IDBPDatabase<BabyTrackerDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<BabyTrackerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BabyTrackerDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('babies')) {
          db.createObjectStore('babies', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('baby_members')) {
          const membersStore = db.createObjectStore('baby_members', {
            keyPath: 'id',
          });
          membersStore.createIndex('by-babyId', 'babyId', { unique: false });
        }

        if (!db.objectStoreNames.contains('events')) {
          const eventsStore = db.createObjectStore('events', {
            keyPath: 'id',
          });
          eventsStore.createIndex('by-babyId', 'babyId', { unique: false });
          eventsStore.createIndex(
            'by-babyId-startedAt',
            ['babyId', 'startedAt'],
            { unique: false },
          );
        }

        if (!db.objectStoreNames.contains('outbox')) {
          const outboxStore = db.createObjectStore('outbox', {
            keyPath: 'mutationId',
          });
          outboxStore.createIndex('by-entityId', 'entityId', { unique: false });
          outboxStore.createIndex('by-createdAt', 'createdAt', {
            unique: false,
          });
        }

        if (!db.objectStoreNames.contains('sync_meta')) {
          db.createObjectStore('sync_meta', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

export async function closeDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

export function uuidv4(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback RFC4122 v4 generator
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}
