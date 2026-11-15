import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  storageBackend?: 'sqlite' | 'postgres' | 'firestore';
  databaseUrl?: string;
  sqlitePath: string;
  firestoreProjectId?: string;
  firestoreDatabaseId?: string;
  sessionSecret: string;
  staticDir: string;
  cookieSecure: boolean;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const portRaw = process.env.PORT ?? '8080';
  const parsedPort = Number.parseInt(portRaw, 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;

  const host = process.env.HOST ?? '0.0.0.0';
  const rawBackend = process.env.STORAGE_BACKEND?.trim().toLowerCase();
  const storageBackend =
    rawBackend === 'firestore' || rawBackend === 'postgres' || rawBackend === 'sqlite'
      ? rawBackend
      : undefined;
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const sqlitePath = process.env.SQLITE_PATH?.trim() || './data/baby-tracker.sqlite';
  const firestoreProjectId =
    process.env.FIRESTORE_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    undefined;
  const firestoreDatabaseId = process.env.FIRESTORE_DATABASE_ID?.trim() || undefined;
  const envSessionSecret = process.env.SESSION_SECRET?.trim();
  if (
    process.env.NODE_ENV === 'production' &&
    !envSessionSecret &&
    !overrides.sessionSecret
  ) {
    console.warn(
      'WARNING: SESSION_SECRET is not set in production; using default session secret.',
    );
  }
  const sessionSecret =
    envSessionSecret || 'dev-baby-tracker-session-secret-change-in-production';

  const defaultStaticDir = path.resolve(import.meta.dirname, '../../web/dist');
  const staticDir = process.env.STATIC_DIR?.trim()
    ? path.resolve(process.env.STATIC_DIR.trim())
    : defaultStaticDir;

  const cookieSecure =
    process.env.COOKIE_SECURE === 'true' ||
    (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false');

  return {
    port,
    host,
    storageBackend,
    databaseUrl,
    sqlitePath,
    firestoreProjectId,
    firestoreDatabaseId,
    sessionSecret,
    staticDir,
    cookieSecure,
    ...overrides,
  };
}
