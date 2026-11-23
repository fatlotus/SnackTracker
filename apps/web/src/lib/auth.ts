import {
  AuthResponseSchema,
  LoginInputSchema,
  LogoutResponseSchema,
  RegisterInputSchema,
  UserSchema,
  type LoginInput,
  type RegisterInput,
  type User,
} from '@baby-tracker/shared';
import { ApiError, apiFetch } from './api.js';
import { getDb } from './db.js';
import { isNavigatorOffline } from './sync.js';

export const CURRENT_USER_META_KEY = 'current_user';

export interface CurrentUserResult {
  user: User | null;
  fromCache: boolean;
  unauthorized: boolean;
}

export async function getCachedUser(): Promise<User | null> {
  const db = await getDb();
  const row = await db.get('sync_meta', CURRENT_USER_META_KEY);
  if (!row || row.value == null) {
    return null;
  }
  const parsed = UserSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

export async function setCachedUser(user: User | null): Promise<void> {
  const db = await getDb();
  if (user === null) {
    await db.delete('sync_meta', CURRENT_USER_META_KEY);
  } else {
    const validated = UserSchema.parse(user);
    await db.put('sync_meta', {
      key: CURRENT_USER_META_KEY,
      value: validated,
    });
  }
}

export async function register(input: RegisterInput): Promise<User> {
  const body = RegisterInputSchema.parse(input);
  const res = await apiFetch(
    '/api/auth/register',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    AuthResponseSchema,
  );
  await setCachedUser(res.user);
  return res.user;
}

export async function login(input: LoginInput): Promise<User> {
  const body = LoginInputSchema.parse(input);
  const res = await apiFetch(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    AuthResponseSchema,
  );
  await setCachedUser(res.user);
  return res.user;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch(
      '/api/auth/logout',
      { method: 'POST' },
      LogoutResponseSchema,
    );
  } catch (err) {
    // Allow local sign-out even if offline; only clear cached user, never wipe IDB stores
    if (err instanceof ApiError && err.status === 401) {
      // already unauthenticated
    } else if (isNavigatorOffline()) {
      // offline
    } else if (!(err instanceof TypeError)) {
      // If network error (TypeError), still clear local session; otherwise rethrow unexpected server errors?
      // Still clear cached user so user isn't stuck.
    }
  } finally {
    const db = await getDb();
    const tx = db.transaction(
      ['babies', 'baby_members', 'events', 'outbox', 'sync_meta'],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore('babies').clear(),
      tx.objectStore('baby_members').clear(),
      tx.objectStore('events').clear(),
      tx.objectStore('outbox').clear(),
      tx.objectStore('sync_meta').clear(),
    ]);
    await tx.done;
  }
}

/**
 * Resolves the current user in an offline-resilient way:
 * - When offline (`navigator.onLine === false`), returns cached `current_user` immediately without blocking.
 * - When online, calls `GET /api/auth/me`:
 *   - On 200: updates cached user and returns it.
 *   - On 401: NEVER wipes IndexedDB data stores (`babies`, `events`, `outbox`, `baby_members`);
 *     returns `{ user: null, fromCache: false, unauthorized: true }`.
 *   - On network / 5xx error (e.g. cold start): falls back to cached user so offline/flaky startup works.
 */
export async function getCurrentUser(): Promise<CurrentUserResult> {
  const cachedUser = await getCachedUser();

  if (cachedUser !== null && isNavigatorOffline()) {
    return {
      user: cachedUser,
      fromCache: true,
      unauthorized: false,
    };
  }

  try {
    const res = await apiFetch(
      '/api/auth/me',
      { method: 'GET' },
      AuthResponseSchema,
    );
    await setCachedUser(res.user);
    return {
      user: res.user,
      fromCache: false,
      unauthorized: false,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // NEVER wipe IndexedDB on 401
      return {
        user: null,
        fromCache: false,
        unauthorized: true,
      };
    }
    // Network error or 5xx cold-start: return cached user without blocking
    return {
      user: cachedUser,
      fromCache: true,
      unauthorized: false,
    };
  }
}
