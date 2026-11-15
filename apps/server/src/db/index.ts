import type { ServerConfig } from '../config.js';
import { FirestoreStorageAdapter } from './firestore.js';
import { PostgresStorageAdapter } from './postgres.js';
import { SqliteStorageAdapter } from './sqlite.js';
import type { StorageAdapter } from './types.js';

export function createStorageAdapter(config: ServerConfig): StorageAdapter {
  if (
    config.storageBackend === 'firestore' ||
    (!config.storageBackend && !config.databaseUrl && config.firestoreProjectId)
  ) {
    return new FirestoreStorageAdapter({
      projectId: config.firestoreProjectId,
      databaseId: config.firestoreDatabaseId,
    });
  }
  if (config.storageBackend === 'postgres' || config.databaseUrl) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required when STORAGE_BACKEND=postgres');
    }
    return new PostgresStorageAdapter(config.databaseUrl);
  }
  return new SqliteStorageAdapter(config.sqlitePath);
}

export * from './types.js';
export { SqliteStorageAdapter } from './sqlite.js';
export { PostgresStorageAdapter } from './postgres.js';
export { FirestoreStorageAdapter } from './firestore.js';
