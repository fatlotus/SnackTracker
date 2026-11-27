import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  registerUserViaAPI,
  setupAuthenticatedBaby,
  uniqueEmail,
} from '../helpers/app.js';

/**
 * Formats a Date into local `YYYY-MM-DDTHH:mm` for `<input type="datetime-local">` or `HH:mm`.
 */
function toLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toLocalTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fillTimeOrDateTime(
  locator: ReturnType<Page['locator']>,
  date: Date,
): Promise<void> {
  const inputType = await locator.getAttribute('type');
  if (inputType === 'time') {
    await locator.fill(toLocalTimeInput(date));
  } else {
    await locator.fill(toLocalDateTimeInput(date));
  }
}

test.describe('F1: Shared Domain & Validation (Tier 1)', () => {
  test('accepts valid UUIDv4 baby and all 5 tracking event types via sync push/pull', async ({
    page,
  }) => {
    const email = uniqueEmail('f1-valid');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'Password123!',
      displayName: 'F1 Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
    const babyId = crypto.randomUUID();

    const babyMutationId = crypto.randomUUID();
    const breastId = crypto.randomUUID();
    const bottleId = crypto.randomUUID();
    const sleepId = crypto.randomUUID();
    const diaperId = crypto.randomUUID();
    const spitUpId = crypto.randomUUID();

    const mutations = [
      {
        mutationId: babyMutationId,
        entityType: 'baby',
        op: 'upsert',
        clientUpdatedAt: now.toISOString(),
        data: {
          id: babyId,
          name: 'Liam',
          dob: '2026-07-15',
          avatarColor: '#3b82f6',
          isArchived: false,
          createdByUserId: userId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
        },
      },
      {
        mutationId: crypto.randomUUID(),
        entityType: 'event',
        op: 'upsert',
        clientUpdatedAt: now.toISOString(),
        data: {
          id: breastId,
          babyId,
          type: 'breast_feed',
          startedAt: tenMinAgo.toISOString(),
          endedAt: now.toISOString(),
          loggedByUserId: userId,
          updatedByUserId: userId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
          payload: {
            segments: [
              {
                side: 'left',
                startedAt: tenMinAgo.toISOString(),
                endedAt: now.toISOString(),
              },
            ],
            pausedAt: null,
            totalLeftSeconds: 600,
            totalRightSeconds: 0,
          },
        },
      },
      {
        mutationId: crypto.randomUUID(),
        entityType: 'event',
        op: 'upsert',
        clientUpdatedAt: now.toISOString(),
        data: {
          id: bottleId,
          babyId,
          type: 'bottle_feed',
          startedAt: tenMinAgo.toISOString(),
          endedAt: now.toISOString(),
          loggedByUserId: userId,
          updatedByUserId: userId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
          payload: {
            volumeMl: 120,
            milkType: 'formula',
          },
        },
      },
      {
        mutationId: crypto.randomUUID(),
        entityType: 'event',
        op: 'upsert',
        clientUpdatedAt: now.toISOString(),
        data: {
          id: sleepId,
          babyId,
          type: 'sleep',
          startedAt: tenMinAgo.toISOString(),
          endedAt: now.toISOString(),
          loggedByUserId: userId,
          updatedByUserId: userId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
          payload: {
            category: 'nap',
            location: 'crib',
          },
        },
      },
      {
        mutationId: crypto.randomUUID(),
        entityType: 'event',
        op: 'upsert',
        clientUpdatedAt: now.toISOString(),
        data: {
          id: diaperId,
          babyId,
          type: 'diaper',
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          loggedByUserId: userId,
          updatedByUserId: userId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
          payload: {
            kind: 'both',
            amount: 'medium',
            hasRash: false,
          },
        },
      },
      {
        mutationId: crypto.randomUUID(),
        entityType: 'event',
        op: 'upsert',
        clientUpdatedAt: now.toISOString(),
        data: {
          id: spitUpId,
          babyId,
          type: 'spit_up',
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          loggedByUserId: userId,
          updatedByUserId: userId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          deletedAt: null,
          payload: {
            severity: 'small',
            relatedFeedId: bottleId,
            relatedFeedType: 'bottle_feed',
          },
        },
      },
    ];

    const pushRes = await page.request.post('/api/sync/push', {
      data: { mutations },
    });
    expect(pushRes.status()).toBe(200);
    const pushBody = (await pushRes.json()) as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string; reason: string }>;
      latestSeq: number;
    };
    expect(pushBody.rejected).toEqual([]);
    expect(pushBody.ackedMutationIds).toHaveLength(6);
    expect(pushBody.latestSeq).toBeGreaterThan(0);

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    expect(pullRes.status()).toBe(200);
    const pullBody = (await pullRes.json()) as {
      babies: Array<{ id: string; name: string }>;
      events: Array<{ id: string; type: string }>;
    };
    expect(pullBody.babies.some((b) => b.id === babyId && b.name === 'Liam')).toBe(true);
    const eventIds = new Set(pullBody.events.map((e) => e.id));
    expect(eventIds.has(breastId)).toBe(true);
    expect(eventIds.has(bottleId)).toBe(true);
    expect(eventIds.has(sleepId)).toBe(true);
    expect(eventIds.has(diaperId)).toBe(true);
    expect(eventIds.has(spitUpId)).toBe(true);
  });

  test('rejects invalid event type and malformed UUIDv4', async ({ page }) => {
    const email = uniqueEmail('f1-invalid-type');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'Password123!',
      displayName: 'F1 Validator',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date().toISOString();
    const babyId = crypto.randomUUID();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Noah',
              dob: '2026-06-01',
              avatarColor: '#10b981',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          },
        ],
      },
    });

    const badMutation1 = crypto.randomUUID();
    const badMutation2 = crypto.randomUUID();
    const pushRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: badMutation1,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: 'not-a-valid-uuid',
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now,
              updatedAt: now,
              payload: { kind: 'wet' },
            },
          },
          {
            mutationId: badMutation2,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'unknown_event_type',
              startedAt: now,
              endedAt: now,
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now,
              updatedAt: now,
              payload: {},
            },
          },
        ],
      },
    });

    if (pushRes.status() === 400) {
      expect(pushRes.status()).toBe(400);
    } else {
      expect(pushRes.status()).toBe(200);
      const body = (await pushRes.json()) as {
        ackedMutationIds: string[];
        rejected: Array<{ mutationId: string; reason: string }>;
      };
      expect(body.ackedMutationIds).not.toContain(badMutation1);
      expect(body.ackedMutationIds).not.toContain(badMutation2);
      expect(body.rejected.map((r) => r.mutationId)).toEqual(
        expect.arrayContaining([badMutation1, badMutation2]),
      );
    }
  });

  test('rejects invalid baby dob format and empty baby name', async ({ page }) => {
    const email = uniqueEmail('f1-invalid-baby');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'Password123!',
      displayName: 'F1 Baby Check',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date().toISOString();

    const m1 = crypto.randomUUID();
    const m2 = crypto.randomUUID();
    const pushRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: m1,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              name: 'Valid Name',
              dob: '08/01/2026', // invalid YYYY-MM-DD
              avatarColor: '#f59e0b',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            mutationId: m2,
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              name: '   ', // empty/whitespace name
              dob: '2026-08-01',
              avatarColor: '#f59e0b',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      },
    });

    if (pushRes.status() === 400) {
      expect(pushRes.status()).toBe(400);
    } else {
      expect(pushRes.status()).toBe(200);
      const body = (await pushRes.json()) as {
        ackedMutationIds: string[];
        rejected: Array<{ mutationId: string }>;
      };
      expect(body.ackedMutationIds).toHaveLength(0);
      expect(body.rejected.map((r) => r.mutationId)).toEqual(
        expect.arrayContaining([m1, m2]),
      );
    }
  });

  test('rejects non-ISO-8601 startedAt timestamps', async ({ page }) => {
    const email = uniqueEmail('f1-bad-iso');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'Password123!',
      displayName: 'F1 ISO Check',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date().toISOString();
    const babyId = crypto.randomUUID();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Aria',
              dob: '2026-07-01',
              avatarColor: '#8b5cf6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      },
    });

    const badTsMutation = crypto.randomUUID();
    const pushRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: badTsMutation,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'diaper',
              startedAt: 'not-an-iso-timestamp',
              endedAt: now,
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now,
              updatedAt: now,
              payload: { kind: 'wet' },
            },
          },
        ],
      },
    });

    if (pushRes.status() === 400) {
      expect(pushRes.status()).toBe(400);
    } else {
      expect(pushRes.status()).toBe(200);
      const body = (await pushRes.json()) as {
        ackedMutationIds: string[];
        rejected: Array<{ mutationId: string }>;
      };
      expect(body.ackedMutationIds).not.toContain(badTsMutation);
      expect(body.rejected.some((r) => r.mutationId === badTsMutation)).toBe(true);
    }
  });

  test('enforces authentication on sync endpoints and persists soft-delete tombstones', async ({
    page,
    request,
  }) => {
    // Unauthenticated requests must be rejected
    const unauthPull = await request.get('/api/sync/pull?since_seq=0');
    expect(unauthPull.status()).toBe(401);

    const unauthPush = await request.post('/api/sync/push', {
      data: { mutations: [] },
    });
    expect(unauthPush.status()).toBe(401);

    // Authenticated soft-delete tombstone round-trip
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('f1-tombstone'),
      password: 'Password123!',
      displayName: 'F1 Tombstone',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date().toISOString();
    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'Leo',
              dob: '2026-08-10',
              avatarColor: '#ec4899',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now,
              updatedAt: now,
              payload: { kind: 'wet' },
            },
          },
        ],
      },
    });

    const deleteAt = new Date(Date.now() + 1000).toISOString();
    const delRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: deleteAt,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now,
              updatedAt: deleteAt,
              deletedAt: deleteAt,
              payload: { kind: 'wet' },
            },
          },
        ],
      },
    });
    expect(delRes.status()).toBe(200);

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    expect(pullRes.status()).toBe(200);
    const pullBody = (await pullRes.json()) as {
      events: Array<{ id: string; deletedAt: string | null }>;
    };
    const deletedEvent = pullBody.events.find((e) => e.id === eventId);
    expect(deletedEvent).toBeDefined();
    expect(deletedEvent?.deletedAt).not.toBeNull();
  });
});

test.describe('F2: Breastfeeding Tracking (Tier 1)', () => {
  test('starts left-side breastfeeding timer, shows active timer bar, and stops to log event', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    const startLeftBtn = page.getByRole('button', { name: /^Start Left$/i });
    await startLeftBtn.first().click();

    // Active timer bar should appear with timer digits and Finish button
    const finishBtn = page.getByRole('button', { name: /^Finish$/i });
    await expect(finishBtn.first()).toBeVisible();
    await expect(page.getByText(/\d{1,2}:\d{2}/).first()).toBeVisible();

    await page.waitForTimeout(1200);
    await finishBtn.first().click();

    // Verify logged in main timeline/dashboard
    await expect(
      page.getByRole('main').getByText(/breast|left/i).first(),
    ).toBeVisible();
  });

  test('switches sides (Left to Right) within a single breastfeeding session', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();

    await page.waitForTimeout(1100);

    const switchBtn = page
      .getByRole('button', { name: 'Switch breast side' })
      .or(page.getByRole('button', { name: /^Switch$/i }));
    await switchBtn.first().click();

    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: /^Finish$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/left|\bL\b/i).first()).toBeVisible();
    await expect(main.getByText(/right|\bR\b/i).first()).toBeVisible();
  });

  test('pauses and resumes an active breastfeeding timer', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();

    await page.waitForTimeout(1100);
    const pauseBtn = page.getByRole('button', { name: /pause/i });
    await pauseBtn.first().click();

    const resumeBtn = page.getByRole('button', { name: /resume/i });
    await expect(resumeBtn.first()).toBeVisible();
    await resumeBtn.first().click();

    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^Finish$/i }).first().click();

    await expect(
      page.getByRole('main').getByText(/breast/i).first(),
    ).toBeVisible();
  });

  test('logs a manual breastfeeding entry with start/end times and notes', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Breastfeeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const start = new Date(Date.now() - 15 * 60_000);
    await fillTimeOrDateTime(page.getByLabel(/start time/i).first(), start);

    await page.getByLabel(/left \(min\)/i).first().fill('15');
    await page.getByLabel(/right \(min\)/i).first().fill('0');
    await page.getByLabel(/notes/i).first().fill('Good latch on left side');

    await page.getByRole('button', { name: /save breastfeed/i }).last().click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/Good latch on left side/i).first(),
    ).toBeVisible();
  });

  test('displays last-side indicator after completing a breastfeeding session', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    const breastCard = page.getByRole('region', { name: /Breastfeeding/i });
    await page.getByRole('button', { name: /^Start Right$/i }).first().click();
    await expect(breastCard.getByText(/^Feeding now$/i)).toBeVisible();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /^Finish$/i }).first().click();

    // Check breastfeeding widget for last-side, duration, and time-ago indicator
    await expect(
      breastCard.getByText(/Last:\s*Right\s*·\s*(<1m|\d+m)\s*\(just now\)/i).first(),
    ).toBeVisible();
  });
});

test.describe('F3: Bottle Feeding Tracking (Tier 1)', () => {
  test('logs a bottle feed with volume in ml and milk type', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i));
    await volumeInput.first().fill('120');

    await page.getByLabel(/milk type/i).first().selectOption('formula');
    await page.getByRole('button', { name: /save bottle/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/120\s*ml/i).first()).toBeVisible();
    await expect(main.getByText(/formula/i).first()).toBeVisible();
  });

  test('allows 0 ml bottle feed entry', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i));
    await volumeInput.first().fill('0');

    await page.getByRole('button', { name: /save bottle/i }).click();

    await expect(
      page.getByRole('main').getByText(/0\s*ml|bottle/i).first(),
    ).toBeVisible();
  });

  test('starts and stops a bottle feeding timer', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /start bottle/i }).first().click();

    const finishBtn = page.getByRole('button', {
      name: /finish & log volume|^finish$/i,
    });
    await expect(finishBtn.first()).toBeVisible();
    await page.waitForTimeout(1100);
    await finishBtn.first().click();

    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i));
    await volumeInput.first().fill('100');
    await page.getByRole('button', { name: /save bottle/i }).click();

    await expect(
      page.getByRole('main').getByText(/100\s*ml|bottle/i).first(),
    ).toBeVisible();
  });

  test('logs a manual bottle feed with start/end times and notes', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i));
    await volumeInput.first().fill('90');

    const notesInput = page.getByLabel(/notes/i).or(page.getByPlaceholder(/notes/i));
    await notesInput.first().fill('Took 90ml eagerly');

    await page.getByRole('button', { name: /save bottle/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/Took 90ml eagerly/i).first(),
    ).toBeVisible();
  });

  test('displays optional oz conversion or ml total in daily stats', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i));
    await volumeInput.first().fill('150');
    await page.getByRole('button', { name: /save bottle/i }).click();

    const main = page.getByRole('main');
    await expect(main.getByText(/150\s*ml/i).first()).toBeVisible();
    const ozOrTotal = main.getByText(/oz|150\s*ml/i);
    await expect(ozOrTotal.first()).toBeVisible();
  });
});

test.describe('F4: Sleep Tracking (Tier 1)', () => {
  test('starts and stops a nap sleep timer', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /start nap/i }).first().click();

    const wakeUpBtn = page.getByRole('button', { name: /^Wake Up$/i });
    await expect(wakeUpBtn.first()).toBeVisible();
    await page.waitForTimeout(1100);
    await wakeUpBtn.first().click();

    await expect(
      page.getByRole('main').getByText(/nap|sleep/i).first(),
    ).toBeVisible();
  });

  test('logs a manual night sleep with location (crib)', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Sleep' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    await page.getByRole('dialog').getByRole('button', { name: /night sleep/i }).click();
    await page.getByLabel(/location/i).first().selectOption('crib');

    const end = new Date();
    const start = new Date(end.getTime() - 90 * 60_000);
    await fillTimeOrDateTime(page.getByLabel(/fell asleep/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/woke up/i).first(), end);

    await page.getByRole('button', { name: /save sleep/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/night/i).first()).toBeVisible();
    await expect(main.getByText(/crib/i).first()).toBeVisible();
  });

  test('automatically ends active sleep when a feed is started', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    // Start sleep timer
    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();

    // Start a bottle feed while sleep is active -> auto-ends sleep
    await page.getByRole('button', { name: /start bottle/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /finish.*log volume/i }).first(),
    ).toBeVisible();
  });

  test('keeps active sleep running on spit-up, then ends it on diaper', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    // Start sleep timer
    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();

    // Log spit-up -> sleep timer remains active
    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page.getByRole('button', { name: /save spit.?up/i }).click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();

    // Log wet diaper -> sleep timer automatically ends
    await page.getByRole('button', { name: /^wet$/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }),
    ).toHaveCount(0);
  });

  test('displays total sleep duration in daily stats', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Sleep' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60_000);
    await fillTimeOrDateTime(page.getByLabel(/fell asleep/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/woke up/i).first(), end);
    await page.getByRole('button', { name: /save sleep/i }).click();

    await expect(
      page.getByRole('main').getByText(/1\s*h|60\s*m/i).first(),
    ).toBeVisible();
  });

  test('allows editing an existing sleep entry category or location', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Sleep' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    const end = new Date();
    const start = new Date(end.getTime() - 45 * 60_000);
    await fillTimeOrDateTime(page.getByLabel(/fell asleep/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/woke up/i).first(), end);
    await page.getByRole('button', { name: /save sleep/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await main.getByRole('button', { name: /^Edit /i }).first().click();

    await page.getByLabel(/location/i).first().selectOption('bassinet');
    await page.getByRole('button', { name: /save sleep/i }).click();
    await expect(main.getByText(/bassinet/i).first()).toBeVisible();
  });
});

test.describe('F5: Diaper Tracking (Tier 1)', () => {
  test('1-tap logs a wet diaper and increments wet count', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^wet$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/wet/i).first()).toBeVisible();
    await expect(main.getByText(/1/).first()).toBeVisible();
  });

  test('1-tap logs a poopy diaper and increments poopy count', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^poopy$|^dirty$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/poopy|dirty/i).first()).toBeVisible();
    await expect(main.getByText(/1/).first()).toBeVisible();
  });

  test('1-tap logs a both diaper and increments BOTH wet and poopy counts', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^both$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/both/i).first()).toBeVisible();
    // Both wet and poopy clinical counters should show 1 (not static 0)
    const wetStat = main
      .getByText(/\b1W\b|(?:wet\b[\s:]*\b1\b|\b1\b[\s:]*wet)/i)
      .first();
    const poopyStat = main
      .getByText(/\b1P\b|(?:(?:poopy|dirty)\b[\s:]*\b1\b|\b1\b[\s:]*(?:poopy|dirty))/i)
      .first();
    await expect(wetStat).toBeVisible();
    await expect(poopyStat).toBeVisible();
  });

  test('logs a diaper with optional stool color, amount, rash flag, and notes', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: '1-Tap Diaper Log' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    await page.getByRole('dialog').getByRole('button', { name: /^poopy$/i }).click();

    const colorInput = page
      .getByLabel(/stool color|color/i)
      .or(page.getByPlaceholder(/color|mustard/i));
    await colorInput.first().fill('mustard');

    const rashToggle = page.getByLabel(/rash/i).or(
      page.getByRole('checkbox', { name: /rash/i }),
    );
    await rashToggle.first().check();

    const notesInput = page.getByLabel(/notes/i).or(page.getByPlaceholder(/notes/i));
    await notesInput.first().fill('Applied barrier cream');

    await page.getByRole('button', { name: /save diaper/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/Applied barrier cream|mustard|rash/i).first(),
    ).toBeVisible();
  });

  test('supports undoing a 1-tap diaper via the undo toast', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^wet$/i }).first().click();

    const undoBtn = page.getByRole('button', { name: /^Undo$/i });
    await expect(undoBtn.first()).toBeVisible();
    await undoBtn.first().click();

    await expect(
      page.getByRole('main').getByText(/0W · 0P|no diapers logged|0 wet|no events|empty/i).first(),
    ).toBeVisible();
  });
});

test.describe('F6: Spit-Up Tracking (Tier 1)', () => {
  test('logs a spit-up with severity small, medium, or large', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();

    await page.getByRole('button', { name: /^medium$/i }).first().click();
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    const main = page.getByRole('main');
    await expect(main.getByText(/spit.?up/i).first()).toBeVisible();
    await expect(main.getByText(/medium/i).first()).toBeVisible();
  });

  test('logs a standalone spit-up with notes', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();

    const notesInput = page.getByLabel(/notes/i).or(page.getByPlaceholder(/notes/i));
    await notesInput.first().fill('During tummy time');

    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/During tummy time/i).first(),
    ).toBeVisible();
  });

  test('links a spit-up to a recent bottle or breast feed', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    // First log a bottle feed
    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    await page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i))
      .first()
      .fill('100');
    await page.getByRole('button', { name: /save bottle/i }).click();
    await expect(page.getByRole('main').getByText(/100\s*ml/i).first()).toBeVisible();

    // Now log spit-up linked to that feed
    await page.getByRole('button', { name: /log spit.?up/i }).first().click();

    const linkSelect = page.getByLabel(/related recent feed|related feed|link.*feed/i);
    if (await linkSelect.first().isVisible().catch(() => false)) {
      const options = await linkSelect.first().locator('option').count();
      if (options > 1) {
        await linkSelect.first().selectOption({ index: 1 });
      }
    }

    await page.getByRole('button', { name: /save spit.?up/i }).click();
    await expect(
      page.getByRole('main').getByText(/spit.?up/i).first(),
    ).toBeVisible();
  });

  test('displays spit-up events in the daily timeline', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page.getByRole('button', { name: /^large$/i }).first().click();
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/spit.?up/i).first()).toBeVisible();
    await expect(main.getByText(/large/i).first()).toBeVisible();
  });

  test('allows deleting a spit-up event from the timeline', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first()
      .fill('Delete-me spit-up');
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/Delete-me spit-up/i).first()).toBeVisible();

    await main.getByRole('button', { name: /^Delete /i }).first().click();

    await expect(main.getByText(/Delete-me spit-up/i)).toHaveCount(0);
  });
});
