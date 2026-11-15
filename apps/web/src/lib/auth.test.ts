import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@baby-tracker/shared';
import {
  CURRENT_USER_META_KEY,
  getCachedUser,
  getCurrentUser,
  login,
  logout,
  register,
} from './auth.js';
import { closeDb, DB_NAME, getDb } from './db.js';
import { createBaby, listBabies, listEventsForBaby, logDiaper } from './store.js';

const MOCK_USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'parent@example.com',
  displayName: 'Parent One',
  createdAt: '2026-03-01T00:00:00.000Z',
};

async function clearDatabase(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('auth (offline cache + 401 IDB preservation)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('caches user on login and register, and clears cached user on logout', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/register' || url === '/api/auth/login') {
        return new Response(JSON.stringify({ user: MOCK_USER }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/auth/logout') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registered = await register({
      email: 'parent@example.com',
      password: 'password123',
      displayName: 'Parent One',
    });
    expect(registered).toEqual(MOCK_USER);
    expect(await getCachedUser()).toEqual(MOCK_USER);

    await logout();
    expect(await getCachedUser()).toBeNull();

    const loggedIn = await login({
      email: 'parent@example.com',
      password: 'password123',
    });
    expect(loggedIn).toEqual(MOCK_USER);
    const db = await getDb();
    expect((await db.get('sync_meta', CURRENT_USER_META_KEY))?.value).toEqual(
      MOCK_USER,
    );
  });

  it('returns cached user immediately when offline without blocking on /api/auth/me', async () => {
    const db = await getDb();
    await db.put('sync_meta', {
      key: CURRENT_USER_META_KEY,
      value: MOCK_USER,
    });

    vi.stubGlobal('navigator', { onLine: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCurrentUser();
    expect(result).toEqual({
      user: MOCK_USER,
      fromCache: true,
      unauthorized: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to cached user on 503 cold-start / network error', async () => {
    const db = await getDb();
    await db.put('sync_meta', {
      key: CURRENT_USER_META_KEY,
      value: MOCK_USER,
    });

    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const result = await getCurrentUser();
    expect(result).toEqual({
      user: MOCK_USER,
      fromCache: true,
      unauthorized: false,
    });
  });

  it('NEVER wipes IndexedDB data stores on 401 from /api/auth/me', async () => {
    const baby = await createBaby({
      name: 'Offline Baby',
      dob: '2026-01-15',
      createdByUserId: MOCK_USER.id,
    });
    await logDiaper({
      babyId: baby.id,
      kind: 'wet',
      userId: MOCK_USER.id,
    });

    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await getCurrentUser();
    expect(result).toEqual({
      user: null,
      fromCache: false,
      unauthorized: true,
    });

    // All local IndexedDB data & pending outbox mutations must remain intact!
    expect(await listBabies()).toHaveLength(1);
    expect(await listEventsForBaby(baby.id)).toHaveLength(1);
    const db = await getDb();
    expect(await db.count('outbox')).toBe(2);
  });
});
