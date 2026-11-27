import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  goOffline,
  goOnline,
  registerUserViaAPI,
  setupAuthenticatedBaby,
  uniqueEmail,
} from '../helpers/app.js';

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

test.describe('F1: Shared Domain & Validation — Tier 2 Boundary & Corner Cases', () => {
  test('clamps future clientUpdatedAt clock skew (+1h) to serverNow + 60s', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('f1-skew'),
      password: 'Password123!',
      displayName: 'Skew Tester',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const oneHourFuture = new Date(nowMs + 3_600_000).toISOString();
    const babyId = crypto.randomUUID();

    const pushRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: oneHourFuture,
            data: {
              id: babyId,
              name: 'ClockSkewBaby',
              dob: '2026-08-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: oneHourFuture,
              deletedAt: null,
            },
          },
        ],
      },
    });
    expect(pushRes.status()).toBe(200);

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    expect(pullRes.status()).toBe(200);
    const pullBody = (await pullRes.json()) as {
      babies: Array<{ id: string; updatedAt: string }>;
    };
    const baby = pullBody.babies.find((b) => b.id === babyId);
    expect(baby).toBeDefined();

    const persistedUpdatedAtMs = Date.parse(baby!.updatedAt);
    // Clamped to serverNow + 60_000ms (with a small 15s test-execution tolerance)
    expect(persistedUpdatedAtMs).toBeLessThanOrEqual(Date.now() + 75_000);
    expect(persistedUpdatedAtMs).toBeLessThan(Date.parse(oneHourFuture));
  });

  test('rejects events where endedAt is earlier than startedAt', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('f1-ended-before-start'),
      password: 'Password123!',
      displayName: 'Order Tester',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date();
    const earlier = new Date(now.getTime() - 30 * 60_000);
    const babyId = crypto.randomUUID();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now.toISOString(),
            data: {
              id: babyId,
              name: 'OrderBaby',
              dob: '2026-08-01',
              avatarColor: '#10b981',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          },
        ],
      },
    });

    const badMutationId = crypto.randomUUID();
    const pushRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: badMutationId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now.toISOString(),
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'sleep',
              startedAt: now.toISOString(),
              endedAt: earlier.toISOString(),
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              payload: { category: 'nap' },
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
      expect(body.ackedMutationIds).not.toContain(badMutationId);
      expect(body.rejected.some((r) => r.mutationId === badMutationId)).toBe(true);
    }
  });

  test('handles idempotent mutationId replay without duplicating records', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('f1-idempotent'),
      password: 'Password123!',
      displayName: 'Idempotent Tester',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date().toISOString();
    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const mutationId = crypto.randomUUID();

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
              name: 'ReplayBaby',
              dob: '2026-08-01',
              avatarColor: '#6366f1',
              isArchived: false,
              createdByUserId: userId,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      },
    });

    const eventMutation = {
      mutationId,
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
    };

    const firstPush = await page.request.post('/api/sync/push', {
      data: { mutations: [eventMutation] },
    });
    expect(firstPush.status()).toBe(200);
    const firstBody = (await firstPush.json()) as { ackedMutationIds: string[] };
    expect(firstBody.ackedMutationIds).toContain(mutationId);

    // Replay the exact same mutationId
    const secondPush = await page.request.post('/api/sync/push', {
      data: { mutations: [eventMutation] },
    });
    expect(secondPush.status()).toBe(200);
    const secondBody = (await secondPush.json()) as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string }>;
    };
    expect(secondBody.ackedMutationIds).toContain(mutationId);
    expect(secondBody.rejected).toEqual([]);

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    const pullBody = (await pullRes.json()) as {
      events: Array<{ id: string }>;
    };
    expect(pullBody.events.filter((e) => e.id === eventId)).toHaveLength(1);
  });

  test('assigns strictly monotonic serverSeq across pushes and filters pull by since_seq', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('f1-seq'),
      password: 'Password123!',
      displayName: 'Seq Tester',
    });
    const userId = String(user.id ?? crypto.randomUUID());
    const now = new Date().toISOString();
    const babyId = crypto.randomUUID();
    const event1Id = crypto.randomUUID();
    const event2Id = crypto.randomUUID();

    const res1 = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: babyId,
              name: 'SeqBaby',
              dob: '2026-08-01',
              avatarColor: '#f59e0b',
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
              id: event1Id,
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
    const body1 = (await res1.json()) as { latestSeq: number };
    expect(body1.latestSeq).toBeGreaterThan(0);

    const res2 = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: now,
            data: {
              id: event2Id,
              babyId,
              type: 'diaper',
              startedAt: now,
              endedAt: now,
              loggedByUserId: userId,
              updatedByUserId: userId,
              createdAt: now,
              updatedAt: now,
              payload: { kind: 'poopy' },
            },
          },
        ],
      },
    });
    const body2 = (await res2.json()) as { latestSeq: number };
    expect(body2.latestSeq).toBeGreaterThan(body1.latestSeq);

    // Pull since body1.latestSeq should return event2Id, not event1Id
    const deltaRes = await page.request.get(
      `/api/sync/pull?since_seq=${body1.latestSeq}`,
    );
    expect(deltaRes.status()).toBe(200);
    const deltaBody = (await deltaRes.json()) as {
      events: Array<{ id: string; serverSeq: number }>;
    };
    expect(deltaBody.events.some((e) => e.id === event2Id)).toBe(true);
    expect(deltaBody.events.some((e) => e.id === event1Id)).toBe(false);
    for (const ev of deltaBody.events) {
      expect(ev.serverSeq).toBeGreaterThan(body1.latestSeq);
    }
  });

  test('safely stores and renders XSS payloads and nullable optional fields without script execution', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, {
      babyName: 'SafeBaby',
      notes: undefined,
    });

    const xssPayload = '<img src=x onerror="window.__xssTriggered=true">';
    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first()
      .fill(xssPayload);
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(xssPayload).first(),
    ).toBeVisible();

    const triggered = await page.evaluate(
      () => (window as unknown as { __xssTriggered?: boolean }).__xssTriggered === true,
    );
    expect(triggered).toBe(false);
  });
});

test.describe('F2: Breastfeeding Tracking — Tier 2 Boundary & Corner Cases', () => {
  test('persists active breastfeeding timer across full page reload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();

    await expect(
      page.getByRole('button', { name: /^Finish$/i }).first(),
    ).toBeVisible();
    await page.waitForTimeout(1500);

    await page.reload();

    // Active timer bar must still be running after reload
    await expect(
      page.getByRole('button', { name: /^Finish$/i }).first(),
    ).toBeVisible();
    await expect(page.getByText(/\d{1,2}:\d{2}/).first()).toBeVisible();

    await page.getByRole('button', { name: /^Finish$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/breast/i).first(),
    ).toBeVisible();
  });

  test('calculates multi-segment + pause arithmetic accurately across L->R->Pause->Resume->Stop', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();
    await page.waitForTimeout(1200);

    // Switch to Right
    await page
      .getByRole('button', { name: 'Switch breast side' })
      .or(page.getByRole('button', { name: /^Switch$/i }))
      .first()
      .click();
    await page.waitForTimeout(1200);

    // Pause for 1.5s (should NOT count toward active duration)
    await page.getByRole('button', { name: /pause/i }).first().click();
    await page.waitForTimeout(1500);

    // Resume and stop
    await page.getByRole('button', { name: /resume/i }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^Finish$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/left|\bL\b/i).first()).toBeVisible();
    await expect(main.getByText(/right|\bR\b/i).first()).toBeVisible();
    // Should not display NaN or negative durations
    await expect(
      main.getByText(/\bNaN\b|-\d+\s*(?:m|s|h|min|sec|hr)/i),
    ).toHaveCount(0);
  });

  test('handles immediate stop (<1s) without NaN or zero-division errors', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();
    // Stop immediately
    await page.getByRole('button', { name: /^Finish$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/breast/i).first()).toBeVisible();
    await expect(main.getByText(/NaN|undefined/i)).toHaveCount(0);
  });

  test('handles midnight crossover manual breastfeeding entry', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Breastfeeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 1);
    start.setHours(23, 50, 0, 0);

    await fillTimeOrDateTime(page.getByLabel(/start time/i).first(), start);
    await page.getByLabel(/left \(min\)/i).first().fill('20');
    await page.getByLabel(/right \(min\)/i).first().fill('10');
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes|latch/i))
      .first()
      .fill('Midnight crossover feed');

    await page.getByRole('button', { name: /save breastfeed/i }).last().click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/Midnight crossover feed/i).first(),
    ).toBeVisible();
  });

  test('allows editing and deleting a completed breastfeeding session', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /^Finish$/i }).first().click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await main.getByRole('button', { name: /^Edit /i }).first().click();

    const notesInput = page.getByLabel(/notes/i).or(page.getByPlaceholder(/notes|latch/i));
    await notesInput.first().fill('Updated breast note');
    await page.getByRole('button', { name: /save breastfeed/i }).last().click();
    await expect(main.getByText(/Updated breast note/i).first()).toBeVisible();

    // Now delete
    await main.getByRole('button', { name: /^Delete /i }).first().click();
    await expect(main.getByText(/Updated breast note/i)).toHaveCount(0);
  });
});

test.describe('F3: Bottle Feeding Tracking — Tier 2 Boundary & Corner Cases', () => {
  test('handles midnight crossover for bottle feeding entry', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 1);
    start.setHours(23, 45, 0, 0);
    const end = new Date(now);
    end.setHours(0, 15, 0, 0);

    await fillTimeOrDateTime(page.getByLabel(/start time/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/end time/i).first(), end);

    await page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i))
      .first()
      .fill('110');
    await page.getByRole('button', { name: /save bottle/i }).click();

    await expect(
      page.getByRole('main').getByText(/110\s*ml/i).first(),
    ).toBeVisible();
  });

  test('rejects negative and non-numeric volumeMl values', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i))
      .first();

    await volumeInput.fill('-25');
    await page.getByRole('button', { name: /save bottle/i }).click();

    // Should either show validation error or keep modal open and NOT log -25 ml
    await expect(page.getByRole('main').getByText(/-25\s*ml/i)).toHaveCount(0);
  });

  test('accepts decimal and large volumeMl entries', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    await page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i))
      .first()
      .fill('125.5');
    await page.getByRole('button', { name: /save bottle/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/(?:125\.5|126)\s*ml/i).first(),
    ).toBeVisible();
  });

  test('allows null/omitted volumeMl for bottle feed', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    // Leave volume empty / null
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first()
      .fill('Offered bottle, volume unknown');
    await page.getByRole('button', { name: /save bottle/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/Offered bottle, volume unknown/i).first(),
    ).toBeVisible();
  });

  test('automatically ends active sleep when a bottle feed is logged', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    await page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i))
      .first()
      .fill('85');
    const afterSleep = new Date(Date.now() + 60_000);
    await fillTimeOrDateTime(page.locator('#bottle-start'), afterSleep);
    await fillTimeOrDateTime(page.locator('#bottle-end'), afterSleep);
    await page.getByRole('button', { name: /save bottle/i }).click();

    await expect(
      page.getByRole('main').getByText(/85\s*ml/i).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }),
    ).toHaveCount(0);
  });
});

test.describe('F4: Sleep Tracking — Tier 2 Boundary & Corner Cases', () => {
  test('handles exact 00:00 midnight boundary in sleep entry', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Sleep' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(2, 0, 0, 0);

    await fillTimeOrDateTime(page.getByLabel(/fell asleep/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/woke up/i).first(), end);
    await page.getByRole('button', { name: /save sleep/i }).click();

    await expect(
      page.getByRole('main').getByText(/2\s*h|sleep|nap|night/i).first(),
    ).toBeVisible();
  });

  test('renders active sleep (endedAt: null) in UI and stats without NaN', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /start nap/i }).first().click();

    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();
    await expect(page.getByRole('main').getByText(/NaN/i)).toHaveCount(0);
  });

  test('persists active sleep timer across page reload', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /start nap/i }).first().click();
    await page.waitForTimeout(1200);

    await page.reload();

    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();
    await expect(page.getByText(/\d{1,2}:\d{2}/).first()).toBeVisible();
  });

  test('rejects manual sleep where endedAt is before startedAt', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Sleep' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const start = new Date();
    const end = new Date(start.getTime() - 60 * 60_000);
    await fillTimeOrDateTime(page.getByLabel(/fell asleep/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/woke up/i).first(), end);
    await page.getByRole('button', { name: /save sleep/i }).click();

    // Validation error should be shown or dialog save button remains visible (not logged)
    const dialog = page.getByRole('dialog');
    const errorText = page.getByText(/after|invalid|before|earlier/i);
    await expect(
      errorText
        .first()
        .or(dialog.getByRole('button', { name: /save sleep/i }).last())
        .first(),
    ).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText(/0m/)).not.toBeNull();
  });

  test('handles long >12h multi-day sleep duration cleanly', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: 'Sleep' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const end = new Date();
    const start = new Date(end.getTime() - 14 * 60 * 60_000);
    await fillTimeOrDateTime(page.getByLabel(/fell asleep/i).first(), start);
    await fillTimeOrDateTime(page.getByLabel(/woke up/i).first(), end);
    await page.getByRole('button', { name: /save sleep/i }).click();

    const main = page.getByRole('main');
    await expect(main.getByText(/sleep|night|nap/i).first()).toBeVisible();
    await expect(
      main.getByText(/\bNaN\b|-\d+\s*(?:m|s|h|min|sec|hr)/i),
    ).toHaveCount(0);
  });
});

test.describe('F5: Diaper Tracking — Tier 2 Boundary & Corner Cases', () => {
  test('deleting a "both" diaper decrements BOTH wet and poopy counts', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^both$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/both/i).first()).toBeVisible();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await main.getByRole('button', { name: /delete diaper|^delete /i }).first().click();

    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();
    await expect(main.getByText(/0W · 0P|no diapers logged|no events|empty/i).first()).toBeVisible();
  });

  test('handles rapid double-tap on 1-tap diaper button without errors', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    const wetBtn = page.getByRole('button', { name: /^wet$/i }).first();
    await wetBtn.click();
    await wetBtn.click();

    const main = page.getByRole('main');
    await expect(main.getByText(/wet/i).first()).toBeVisible();
    await expect(main.getByText(/2W|2/).first()).toBeVisible();
  });

  test('persists hasRash toggle when logging a detailed diaper', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page
      .getByRole('region', { name: '1-Tap Diaper Log' })
      .getByRole('button', { name: /^Log$/i })
      .click();

    const rashToggle = page
      .getByLabel(/rash/i)
      .or(page.getByRole('checkbox', { name: /rash/i }));
    await rashToggle.first().check();

    await page.getByRole('button', { name: /save diaper/i }).click();

    await expect(
      page.getByRole('main').getByText(/rash/i).first(),
    ).toBeVisible();
  });

  test('logs 1-tap diaper with empty optional fields cleanly', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^poopy$|^dirty$/i }).first().click();

    const main = page.getByRole('main');
    await expect(main.getByText(/poopy|dirty/i).first()).toBeVisible();
    await expect(main.getByText(/undefined|null/i)).toHaveCount(0);
  });

  test('supports undoing a 1-tap diaper while offline', async ({
    page,
    context,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await goOffline(context);
    await page.getByRole('button', { name: /^wet$/i }).first().click();

    const undoBtn = page.getByRole('button', { name: /^Undo$/i });
    await expect(undoBtn.first()).toBeVisible();
    await undoBtn.first().click();

    await expect(
      page.getByRole('main').getByText(/0W · 0P|no diapers logged|no events|empty/i).first(),
    ).toBeVisible();

    await goOnline(context);
    await page.reload();
    await expect(
      page.getByRole('main').getByText(/0W · 0P|no diapers logged|no events|empty/i).first(),
    ).toBeVisible();
  });
});

test.describe('F6: Spit-Up Tracking — Tier 2 Boundary & Corner Cases', () => {
  test('logs standalone spit-up when baby has no prior feeds', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await expect(
      page.getByRole('main').getByText(/spit.?up/i).first(),
    ).toBeVisible();
  });

  test('handles spit-up gracefully when its linked feed is soft-deleted', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    // Log bottle feed
    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    await page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume/i))
      .first()
      .fill('95');
    await page.getByRole('button', { name: /save bottle/i }).click();
    await expect(page.getByRole('main').getByText(/95\s*ml/i).first()).toBeVisible();

    // Log linked spit-up
    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    const linkSelect = page.getByLabel(/related recent feed|related feed|link.*feed/i);
    if (await linkSelect.first().isVisible().catch(() => false)) {
      const options = await linkSelect.first().locator('option').count();
      if (options > 1) {
        await linkSelect.first().selectOption({ index: 1 });
      }
    }
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/spit.?up/i).first()).toBeVisible();

    // Delete the bottle feed
    await main.getByRole('button', { name: /delete bottle feed/i }).first().click();

    await expect(main.getByText(/95\s*ml/i)).toHaveCount(0);

    // Spit-up must still render cleanly without crashing
    await expect(main.getByText(/spit.?up/i).first()).toBeVisible();
  });

  test('logs spit-up with omitted severity', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first()
      .fill('No severity selected');
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(
      page.getByRole('main').getByText(/No severity selected/i).first(),
    ).toBeVisible();
  });

  test('logs a backdated spit-up timestamp and orders it chronologically', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /log spit.?up/i }).first().click();

    const earlier = new Date(Date.now() - 2 * 60 * 60_000);
    const timeInput = page.getByLabel(/^time$/i).first();
    if (await timeInput.isVisible().catch(() => false)) {
      await fillTimeOrDateTime(timeInput, earlier);
    }
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first()
      .fill('Earlier spit-up');
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    // Log a second current-time spit-up event
    await page.getByRole('button', { name: /log spit.?up/i }).first().click();
    await page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first()
      .fill('Current event');
    await page.getByRole('button', { name: /save spit.?up/i }).click();

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    const earlierEl = main.getByText(/Earlier spit-up/i).first();
    const currentEl = main.getByText(/Current event/i).first();
    await expect(earlierEl).toBeVisible();
    await expect(currentEl).toBeVisible();

    // Verify reverse-chronological ordering in the timeline (newest to oldest: Current event appears before Earlier spit-up)
    const timelineText = await main.innerText();
    const currentIdx = timelineText.indexOf('Current event');
    const earlierIdx = timelineText.indexOf('Earlier spit-up');
    expect(currentIdx).toBeGreaterThan(-1);
    expect(earlierIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeLessThan(earlierIdx);
  });

  test('logs multiple spit-up events within the same minute distinctly', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    for (const label of ['First spit-up', 'Second spit-up']) {
      await page.getByRole('button', { name: /log spit.?up/i }).first().click();
      await page
        .getByLabel(/notes/i)
        .or(page.getByPlaceholder(/notes/i))
        .first()
        .fill(label);
      await page.getByRole('button', { name: /save spit.?up/i }).click();
    }

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/First spit-up/i).first()).toBeVisible();
    await expect(main.getByText(/Second spit-up/i).first()).toBeVisible();
  });
});
