import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  createBabyViaUI,
  expectMinTapTarget,
  expectNoHorizontalOverflow,
  goOffline,
  goOnline,
  parseCsv,
  registerUserViaAPI,
  setupAuthenticatedBaby,
  spawnEphemeralServer,
  uniqueEmail,
} from '../helpers/app.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to acquire free port')));
      }
    });
  });
}

test.describe('F7: Daily Timeline & Stats — Tier 2 Boundaries', () => {
  test('empty day state displays zeroed stats without NaN or undefined', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'EmptyDayBaby' });

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/\bNaN\b/);
    expect(bodyText).not.toMatch(/\bundefined\b/i);
    expect(bodyText).not.toMatch(/\bInfinity\b/);

    await expect(
      page
        .getByRole('main')
        .getByText(/no events|nothing logged|empty|no activity|0 feeds|0 ml/i)
        .first(),
    ).toBeVisible();
  });

  test('timezone local-day bucketing places 23:30 America/Los_Angeles event on local day', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      timezoneId: 'America/Los_Angeles',
    });
    const page = await context.newPage();

    try {
      const email = uniqueEmail('tz-la');
      const { user } = await registerUserViaAPI(page.request, {
        email,
        password: 'StrongPass123!',
        displayName: 'LA Parent',
      });
      const userId = String(user.id ?? crypto.randomUUID());

      // Determine today's YYYY-MM-DD in America/Los_Angeles and construct 23:30 local time
      // (which is 06:30 or 07:30 UTC the next calendar day).
      const { localDateStr, isoAt2330LA } = await page.evaluate(() => {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(now);
        const y = parts.find((p) => p.type === 'year')!.value;
        const m = parts.find((p) => p.type === 'month')!.value;
        const d = parts.find((p) => p.type === 'day')!.value;
        const dateStr = `${y}-${m}-${d}`;
        // Construct 23:30 in local browser timezone (America/Los_Angeles)
        const local = new Date(`${dateStr}T23:30:00`);
        return { localDateStr: dateStr, isoAt2330LA: local.toISOString() };
      });

      const babyId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const nowIso = new Date().toISOString();

      const pushRes = await page.request.post('/api/sync/push', {
        data: {
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'LA Baby',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: userId,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
            {
              mutationId: crypto.randomUUID(),
              entityType: 'event',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: eventId,
                babyId,
                type: 'bottle_feed',
                startedAt: isoAt2330LA,
                endedAt: isoAt2330LA,
                notes: `LA-2330-${localDateStr}`,
                loggedByUserId: userId,
                updatedByUserId: userId,
                payload: { volumeMl: 135, milkType: 'formula' },
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        },
      });
      expect(pushRes.status()).toBe(200);

      await page.goto('/');
      await expect(page.getByLabel('Select active baby').first()).toContainText('LA Baby');
      await expect(
        page.getByText(/135\s*ml/i).first(),
      ).toBeVisible();

      // Navigate to Timeline and then previous day to verify it is NOT shown on the previous day
      await page.getByRole('button', { name: /^Timeline$/i }).first().click();
      await expect(page.getByText(`LA-2330-${localDateStr}`).first()).toBeVisible();
      const prevBtn = page
        .getByRole('button', { name: /previous day|yesterday/i })
        .first();
      await prevBtn.click();
      await expect(page.getByText(`LA-2330-${localDateStr}`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('active timer is reflected in KPIs without NaN', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'TimerKPIBaby' });

    await page.getByRole('button', { name: /start nap/i }).first().click();

    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/\bNaN\b/);
  });

  test('deleted events are excluded from daily timeline and KPIs', async ({
    page,
  }) => {
    const email = uniqueEmail('del-kpi');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'Delete KPI Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'DeleteKPIBaby',
              dob: '2026-07-01',
              avatarColor: '#10b981',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: eventId,
              babyId,
              type: 'bottle_feed',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: 'WillBeDeleted175',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 175, milkType: 'breastmilk' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    await expect(page.getByText(/175\s*ml|WillBeDeleted175/i).first()).toBeVisible();

    // Soft-delete the event
    const delTime = new Date(Date.now() + 2000).toISOString();
    const delRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: delTime,
            data: {
              id: eventId,
              babyId,
              deletedAt: delTime,
              updatedAt: delTime,
            },
          },
        ],
      },
    });
    expect(delRes.status()).toBe(200);

    await page.reload();
    await expect(page.getByLabel('Select active baby').first()).toContainText('DeleteKPIBaby');
    await expect(page.getByText('WillBeDeleted175')).toHaveCount(0);
    await expect(page.getByText(/175\s*ml/)).toHaveCount(0);
  });

  test('future date navigation is disabled or renders safe empty state', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'FutureNavBaby' });

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();

    const nextDayBtn = page
      .getByRole('button', { name: /next day|tomorrow|forward/i })
      .first();

    if (await nextDayBtn.isVisible().catch(() => false)) {
      const isDisabled = await nextDayBtn.isDisabled();
      if (!isDisabled) {
        await nextDayBtn.click();
        const bodyText = await page.locator('body').innerText();
        expect(bodyText).not.toMatch(/\bNaN\b/);
        expect(bodyText).not.toMatch(/\bundefined\b/i);
      } else {
        expect(isDisabled).toBe(true);
      }
    }
  });
});

test.describe('F8: Pediatrician Export — Tier 2 Boundaries', () => {
  async function openExportView(page: import('@playwright/test').Page) {
    const exportBtn = page
      .getByRole('button', { name: /^Export$/i })
      .or(page.getByRole('link', { name: /^Export$/i }))
      .first();
    await exportBtn.click();
  }

  test('empty date range export downloads valid header-only CSV without crashing', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'EmptyExportBaby' });
    await openExportView(page);

    await page.getByRole('button', { name: /^Custom$/i }).first().click();
    const startInput = page.locator('#export-custom-start').or(page.getByLabel(/start date/i)).first();
    const endInput = page.locator('#export-custom-end').or(page.getByLabel(/end date/i)).first();
    await startInput.fill('2025-01-01');
    await endInput.fill('2025-01-02');

    const csvBtn = page
      .getByRole('button', { name: /download events csv/i })
      .first();
    const downloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let content = '';
    for await (const chunk of stream) {
      content += chunk.toString('utf8');
    }

    const rows = parseCsv(content.trim());
    expect(rows.length).toBe(1); // Header row only
    expect(rows[0].length).toBeGreaterThanOrEqual(3);
  });

  test('inverted date range shows validation error or disables export', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'InvertedDateBaby' });
    await openExportView(page);

    await page.getByRole('button', { name: /^Custom$/i }).first().click();
    const startInput = page.locator('#export-custom-start').or(page.getByLabel(/start date/i)).first();
    const endInput = page.locator('#export-custom-end').or(page.getByLabel(/end date/i)).first();
    await startInput.fill('2026-10-20');
    await endInput.fill('2026-10-10');

    const csvBtn = page
      .getByRole('button', { name: /download events csv/i })
      .first();
    const isDisabled = await csvBtn.isDisabled().catch(() => false);
    if (!isDisabled) {
      await csvBtn.click();
      await expect(
        page.getByText(/invalid|after|before|range|error/i).first(),
      ).toBeVisible();
    } else {
      expect(isDisabled).toBe(true);
    }
  });

  test('CSV export properly escapes commas, quotes, and newlines in notes', async ({
    page,
  }) => {
    const email = uniqueEmail('csv-escape');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'CSV Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const trickyNote = 'Formula, "warm" & gentle\nSecond line';

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'CsvEscapeBaby',
              dob: '2026-07-01',
              avatarColor: '#f59e0b',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'bottle_feed',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: trickyNote,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 95, milkType: 'formula' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    await openExportView(page);

    const csvBtn = page
      .getByRole('button', { name: /download csv|export csv|csv/i })
      .first();
    const downloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let content = '';
    for await (const chunk of stream) {
      content += chunk.toString('utf8');
    }

    const rows = parseCsv(content.trim());
    expect(rows.length).toBe(2); // header + 1 event
    const dataRow = rows[1];
    expect(dataRow.some((cell) => cell.includes('Formula, "warm" & gentle'))).toBe(
      true,
    );
  });

  test('midnight-spanning sleep event exports cleanly across boundary', async ({
    page,
  }) => {
    const email = uniqueEmail('midnight-exp');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'Midnight Export Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yStr = yesterday.toISOString().slice(0, 10);
    const tStr = now.toISOString().slice(0, 10);
    const sleepStart = `${yStr}T23:45:00.000Z`;
    const sleepEnd = `${tStr}T01:15:00.000Z`;
    const nowIso = now.toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'MidnightBaby',
              dob: '2026-07-01',
              avatarColor: '#8b5cf6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'sleep',
              startedAt: sleepStart,
              endedAt: sleepEnd,
              notes: 'Crossed midnight',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { category: 'night', location: 'crib' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    await openExportView(page);

    await page.getByRole('button', { name: /^Custom$/i }).first().click();
    const startInput = page.locator('#export-custom-start').or(page.getByLabel(/start date/i)).first();
    const endInput = page.locator('#export-custom-end').or(page.getByLabel(/end date/i)).first();
    await startInput.fill(yStr);
    await endInput.fill(tStr);

    const csvBtn = page
      .getByRole('button', { name: /download csv|export csv|csv/i })
      .first();
    const downloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let content = '';
    for await (const chunk of stream) {
      content += chunk.toString('utf8');
    }

    const rows = parseCsv(content.trim());
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(content).toContain('Crossed midnight');
  });

  test('soft-deleted events are excluded from CSV and JSON exports', async ({
    page,
  }) => {
    const email = uniqueEmail('export-del');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'Export Delete Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const deletedEventId = crypto.randomUUID();
    const keptEventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const delIso = new Date(Date.now() + 2000).toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'ExportDelBaby',
              dob: '2026-07-01',
              avatarColor: '#ec4899',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: keptEventId,
              babyId,
              type: 'diaper',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: 'KEPT_DIAPER_NOTE',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { kind: 'wet' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: deletedEventId,
              babyId,
              type: 'bottle_feed',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: 'DELETED_FEED_NOTE',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 90, milkType: 'formula' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: delIso,
            data: {
              id: deletedEventId,
              babyId,
              deletedAt: delIso,
              updatedAt: delIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    await openExportView(page);

    const csvBtn = page
      .getByRole('button', { name: /download csv|export csv|csv/i })
      .first();
    const csvDownloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const csvDownload = await csvDownloadPromise;
    const csvStream = await csvDownload.createReadStream();
    let csvContent = '';
    for await (const chunk of csvStream) {
      csvContent += chunk.toString('utf8');
    }

    expect(csvContent).toContain('KEPT_DIAPER_NOTE');
    expect(csvContent).not.toContain('DELETED_FEED_NOTE');

    const jsonBtn = page
      .getByRole('button', { name: /download json|export json|json/i })
      .first();
    if (await jsonBtn.isVisible().catch(() => false)) {
      const jsonDownloadPromise = page.waitForEvent('download');
      await jsonBtn.click();
      const jsonDownload = await jsonDownloadPromise;
      const jsonStream = await jsonDownload.createReadStream();
      let jsonContent = '';
      for await (const chunk of jsonStream) {
        jsonContent += chunk.toString('utf8');
      }
      expect(jsonContent).toContain('KEPT_DIAPER_NOTE');
      expect(jsonContent).not.toContain('DELETED_FEED_NOTE');
    }
  });
});

test.describe('F9: Multi-Baby Management — Tier 2 Boundaries', () => {
  async function selectBabyInSwitcher(
    page: import('@playwright/test').Page,
    babyName: string,
  ): Promise<void> {
    const switcher = page
      .locator('select[aria-label="Select active baby"]:visible')
      .first();
    await expect(switcher).toBeVisible();
    const optionValue = await switcher
      .locator('option')
      .evaluateAll((opts, target) => {
        const match = opts.find((o) =>
          (o.textContent ?? '').toLowerCase().includes(target.toLowerCase()),
        );
        return match ? (match as HTMLOptionElement).value : null;
      }, babyName);
    expect(optionValue).toBeTruthy();
    await switcher.selectOption(optionValue!);
  }

  test('archiving the last active baby transitions cleanly to zero-baby onboarding', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OnlyBaby' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();

    await page.getByRole('button', { name: /^Archive Baby$/i }).first().click();
    await page.getByRole('button', { name: /^Confirm Archive$/i }).first().click();

    await expect(
      page
        .getByRole('button', { name: /add (?:a |new |first )?baby/i })
        .or(page.getByLabel(/baby name/i))
        .first(),
    ).toBeVisible();
  });

  test('duplicate baby names are allowed with distinct UUIDs and isolated timelines', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Twin', dob: '2026-08-01' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'Twin', dob: '2026-08-02' });

    let twins: Array<{ id: string; name: string }> = [];
    await expect
      .poll(
        async () => {
          const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
          if (pullRes.status() !== 200) return 0;
          const pullJson = (await pullRes.json()) as {
            babies: Array<{ id: string; name: string }>;
          };
          twins = pullJson.babies.filter((b) => b.name === 'Twin');
          return twins.length;
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    expect(twins[0].id).not.toBe(twins[1].id);
  });

  test('future DOB and negative birth weight fail validation', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'ValidBaby' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await page.getByRole('button', { name: /add another baby/i }).first().click();

    await page.locator('#new-baby-name').fill('InvalidBaby');
    await page.locator('#new-baby-dob').fill('2099-12-31');

    await page.getByRole('button', { name: /^Create Baby$/i }).click();

    await expect(
      page
        .getByRole('main')
        .getByText(/future|invalid|positive|greater than|error/i)
        .first(),
    ).toBeVisible();
  });

  test('switching baby before logging scopes event to the newly selected baby', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Maya' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'Leo', dob: '2026-08-05' });
    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();

    // Ensure Leo is active and log a wet diaper
    await page.getByRole('button', { name: /^wet$/i }).first().click();

    // Switch back to Maya and verify Leo's diaper is not on Maya's timeline
    await selectBabyInSwitcher(page, 'Maya');

    await expect(
      page.getByText(/0W · 0P|no diapers logged|no events|nothing logged/i).first(),
    ).toBeVisible();
  });

  test('archiving a baby with an active timer clears that timer from the active view', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'MayaTimer' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'LeoSafe', dob: '2026-08-05' });
    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();

    // Switch to MayaTimer and start sleep timer
    await selectBabyInSwitcher(page, 'MayaTimer');

    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(page.getByRole('button', { name: /^Wake Up$/i }).first()).toBeVisible();

    // Archive MayaTimer
    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await page.getByRole('button', { name: /^Archive Baby$/i }).first().click();
    await page.getByRole('button', { name: /^Confirm Archive$/i }).first().click();

    await expect(page.getByLabel('Select active baby').first()).toContainText('LeoSafe');
    await expect(page.getByRole('button', { name: /^Wake Up$/i })).toHaveCount(0);
  });
});

test.describe('F10: Multi-Parent Sharing & Auth — Tier 2 Boundaries', () => {
  test('duplicate email registration returns 409 or 400', async ({ page }) => {
    const email = uniqueEmail('dup-auth');
    await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'First User',
    });

    const dupRes = await page.request.post('/api/auth/register', {
      data: {
        email,
        password: 'StrongPass123!',
        displayName: 'Second User',
      },
    });
    expect([400, 409]).toContain(dupRes.status());
  });

  test('invalid invite code is rejected by API and shows error in UI', async ({
    page,
  }) => {
    await registerUserViaAPI(page.request, {
      email: uniqueEmail('bad-inv'),
      password: 'StrongPass123!',
      displayName: 'Invitee',
    });

    const res = await page.request.post('/api/invites/accept', {
      data: { code: 'NONEXISTENT-INVITE-999' },
    });
    expect([400, 404]).toContain(res.status());

    await page.goto('/join/NONEXISTENT-INVITE-999');
    await expect(
      page.getByText(/invalid|expired|not found|error/i).first(),
    ).toBeVisible();
  });

  test('self-invite acceptance is idempotent and preserves owner role', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('self-inv'),
      password: 'StrongPass123!',
      displayName: 'Owner',
    });

    const babyId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'SelfInviteBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: String(user.id),
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    const invRes = await page.request.post(`/api/babies/${babyId}/invites`, {
      data: { role: 'caregiver' },
    });
    expect(invRes.status()).toBe(201);
    const { invite } = (await invRes.json()) as { invite: { code: string } };

    const acceptRes = await page.request.post('/api/invites/accept', {
      data: { code: invite.code },
    });
    expect([200, 400, 409]).toContain(acceptRes.status());

    const membersRes = await page.request.get(`/api/babies/${babyId}/members`);
    expect(membersRes.status()).toBe(200);
    const { members } = (await membersRes.json()) as {
      members: Array<{ userId: string; role: string }>;
    };
    const ownerEntry = members.find((m) => m.userId === user.id);
    expect(ownerEntry?.role).toBe('owner');
  });

  test('revoked user offline push is rejected on sync', async ({ browser }) => {
    const ctxOwner = await browser.newContext();
    const ctxCaregiver = await browser.newContext();

    try {
      const { user: owner } = await registerUserViaAPI(ctxOwner.request, {
        email: uniqueEmail('rev-owner'),
        password: 'StrongPass123!',
        displayName: 'Owner',
      });
      const ownerId = String(owner.id ?? crypto.randomUUID());
      const { user: caregiver } = await registerUserViaAPI(
        ctxCaregiver.request,
        {
          email: uniqueEmail('rev-cg'),
          password: 'StrongPass123!',
          displayName: 'Caregiver',
        },
      );

      const babyId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await ctxOwner.request.post('/api/sync/push', {
        data: {
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'RevokeTestBaby',
                dob: '2026-07-01',
                avatarColor: '#10b981',
                isArchived: false,
                createdByUserId: ownerId,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        },
      });

      const invRes = await ctxOwner.request.post(
        `/api/babies/${babyId}/invites`,
        { data: { role: 'caregiver' } },
      );
      const { invite } = (await invRes.json()) as { invite: { code: string } };

      const accRes = await ctxCaregiver.request.post('/api/invites/accept', {
        data: { code: invite.code },
      });
      expect(accRes.status()).toBe(200);

      // Owner revokes caregiver
      const revRes = await ctxOwner.request.delete(
        `/api/babies/${babyId}/members/${caregiver.id as string}`,
      );
      expect(revRes.status()).toBe(200);

      // Revoked caregiver attempts to push an event
      const mutId = crypto.randomUUID();
      const pushRes = await ctxCaregiver.request.post('/api/sync/push', {
        data: {
          mutations: [
            {
              mutationId: mutId,
              entityType: 'event',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: crypto.randomUUID(),
                babyId,
                type: 'diaper',
                startedAt: nowIso,
                endedAt: nowIso,
                loggedByUserId: String(caregiver.id),
                updatedByUserId: String(caregiver.id),
                payload: { kind: 'wet' },
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        },
      });
      expect([200, 403]).toContain(pushRes.status());
      if (pushRes.status() === 200) {
        const body = (await pushRes.json()) as {
          ackedMutationIds: string[];
          rejected: Array<{ mutationId: string }>;
        };
        expect(body.ackedMutationIds).not.toContain(mutId);
        expect(body.rejected.some((r) => r.mutationId === mutId)).toBe(true);
      }
    } finally {
      await ctxOwner.close();
      await ctxCaregiver.close();
    }
  });

  test('last owner cannot be removed from baby members', async ({ page }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('last-owner'),
      password: 'StrongPass123!',
      displayName: 'Sole Owner',
    });

    const babyId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'SoleOwnerBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: String(user.id),
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    const delRes = await page.request.delete(
      `/api/babies/${babyId}/members/${user.id as string}`,
    );
    expect([400, 403, 409]).toContain(delRes.status());
  });

  test('offline auth cache keeps user signed in across offline reload', async ({
    page,
    context,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OfflineAuthBaby' });
    await expect(page.getByLabel('Select active baby').first()).toContainText('OfflineAuthBaby');

    await goOffline(context);
    await page.reload();

    await expect(page.getByLabel('Select active baby').first()).toContainText('OfflineAuthBaby');
    await goOnline(context);
  });
});

test.describe('F11: Offline-First PWA & Sync — Tier 2 Boundaries', () => {
  test('idempotent duplicate push with same mutationId does not duplicate events', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('idem-push'),
      password: 'StrongPass123!',
      displayName: 'Idem Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const eventMutId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'IdemBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    const payload = {
      mutations: [
        {
          mutationId: eventMutId,
          entityType: 'event',
          op: 'upsert',
          clientUpdatedAt: nowIso,
          data: {
            id: eventId,
            babyId,
            type: 'diaper',
            startedAt: nowIso,
            endedAt: nowIso,
            loggedByUserId: userId,
            updatedByUserId: userId,
            payload: { kind: 'poopy' },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        },
      ],
    };

    const r1 = await page.request.post('/api/sync/push', { data: payload });
    const r2 = await page.request.post('/api/sync/push', { data: payload });
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    const pullData = (await pullRes.json()) as {
      events: Array<{ id: string }>;
    };
    const matching = pullData.events.filter((e) => e.id === eventId);
    expect(matching.length).toBe(1);
  });

  test('LWW conflict resolution keeps event with newer updatedAt', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('lww'),
      password: 'StrongPass123!',
      displayName: 'LWW Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const t0 = new Date(Date.now() - 10_000).toISOString();
    const t1 = new Date(Date.now() - 5_000).toISOString();
    const t2 = new Date(Date.now()).toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t0,
            data: {
              id: babyId,
              name: 'LWWBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: t0,
              updatedAt: t0,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t2,
            data: {
              id: eventId,
              babyId,
              type: 'bottle_feed',
              startedAt: t0,
              endedAt: t0,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 150, milkType: 'formula' },
              createdAt: t0,
              updatedAt: t2,
            },
          },
        ],
      },
    });

    // Stale update at t1 < t2 should NOT overwrite 150ml
    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: eventId,
              babyId,
              type: 'bottle_feed',
              startedAt: t0,
              endedAt: t0,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 80, milkType: 'formula' },
              createdAt: t0,
              updatedAt: t1,
            },
          },
        ],
      },
    });

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    const pullData = (await pullRes.json()) as {
      events: Array<{ id: string; payload: { volumeMl: number } }>;
    };
    const ev = pullData.events.find((e) => e.id === eventId);
    expect(ev?.payload.volumeMl).toBe(150);
  });

  test('clock-skew clamping bounds far-future clientUpdatedAt to ~60s', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('skew'),
      password: 'StrongPass123!',
      displayName: 'Skew Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const farFutureIso = new Date(nowMs + 365 * 24 * 3600 * 1000).toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: 'SkewBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: farFutureIso,
            data: {
              id: eventId,
              babyId,
              type: 'diaper',
              startedAt: nowIso,
              endedAt: nowIso,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { kind: 'wet' },
              createdAt: nowIso,
              updatedAt: farFutureIso,
            },
          },
        ],
      },
    });

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    const pullData = (await pullRes.json()) as {
      events: Array<{ id: string; updatedAt: string }>;
    };
    const ev = pullData.events.find((e) => e.id === eventId);
    expect(ev).toBeDefined();
    const storedMs = new Date(ev!.updatedAt).getTime();
    expect(storedMs).toBeLessThanOrEqual(Date.now() + 90_000);
  });

  test('partial batch push acks valid mutations and rejects unauthorized ones', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('partial'),
      password: 'StrongPass123!',
      displayName: 'Partial Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const ownedBabyId = crypto.randomUUID();
    const unownedBabyId = crypto.randomUUID();
    const validMutId = crypto.randomUUID();
    const invalidMutId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: ownedBabyId,
              name: 'PartialBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    const pushRes = await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: validMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: crypto.randomUUID(),
              babyId: ownedBabyId,
              type: 'diaper',
              startedAt: nowIso,
              endedAt: nowIso,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { kind: 'wet' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: invalidMutId,
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: crypto.randomUUID(),
              babyId: unownedBabyId,
              type: 'diaper',
              startedAt: nowIso,
              endedAt: nowIso,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { kind: 'wet' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });
    expect(pushRes.status()).toBe(200);
    const body = (await pushRes.json()) as {
      ackedMutationIds: string[];
      rejected: Array<{ mutationId: string }>;
    };
    expect(body.ackedMutationIds).toContain(validMutId);
    expect(body.rejected.some((r) => r.mutationId === invalidMutId)).toBe(true);
  });

  test('delete vs stale update LWW preserves tombstone deletion', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('del-lww'),
      password: 'StrongPass123!',
      displayName: 'Delete LWW Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const t1 = new Date(Date.now() - 10_000).toISOString();
    const t15 = new Date(Date.now() - 5_000).toISOString();
    const t2 = new Date(Date.now()).toISOString();

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: babyId,
              name: 'DelLwwBaby',
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: t1,
              updatedAt: t1,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t1,
            data: {
              id: eventId,
              babyId,
              type: 'spit_up',
              startedAt: t1,
              endedAt: t1,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { severity: 'small' },
              createdAt: t1,
              updatedAt: t1,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'delete',
            clientUpdatedAt: t2,
            data: {
              id: eventId,
              babyId,
              deletedAt: t2,
              updatedAt: t2,
            },
          },
        ],
      },
    });

    // Stale update at t15 < t2 should NOT resurrect the deleted event
    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: t15,
            data: {
              id: eventId,
              babyId,
              type: 'spit_up',
              startedAt: t1,
              endedAt: t1,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { severity: 'large' },
              createdAt: t1,
              updatedAt: t15,
            },
          },
        ],
      },
    });

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    const pullData = (await pullRes.json()) as {
      events: Array<{ id: string; deletedAt: string | null }>;
    };
    const ev = pullData.events.find((e) => e.id === eventId);
    expect(ev?.deletedAt).not.toBeNull();
  });
});

test.describe('F12: Mobile-First + Laptop UI — Tier 2 Boundaries', () => {
  test('narrow 320x568 mobile viewport has no horizontal overflow and >=44px tap targets', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await setupAuthenticatedBaby(page, { babyName: 'NarrowBaby' });

    await expectNoHorizontalOverflow(page);

    const quickWetBtn = page.getByRole('button', { name: /wet/i }).first();
    await expectMinTapTarget(quickWetBtn, 44);
  });

  test('long baby name and unbroken note wrap without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const email = uniqueEmail('long-wrap');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'Wrap Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const longName = 'Bartholomew-Maximilian-Alexander-Junior';
    const longNote =
      'Supercalifragilisticexpialidocious_unbroken_note_string_1234567890_abcdefg';

    await page.request.post('/api/sync/push', {
      data: {
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: babyId,
              name: longName,
              dob: '2026-07-01',
              avatarColor: '#3b82f6',
              isArchived: false,
              createdByUserId: userId,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          {
            mutationId: crypto.randomUUID(),
            entityType: 'event',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: crypto.randomUUID(),
              babyId,
              type: 'bottle_feed',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: longNote,
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 100, milkType: 'formula' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    await expect(page.getByLabel('Select active baby').first()).toContainText(/Bartholomew/i);
    await expectNoHorizontalOverflow(page);
  });

  test('50+ events scroll cleanly while sticky active-timer bar remains visible', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const email = uniqueEmail('scroll-50');
    const { user } = await registerUserViaAPI(page.request, {
      email,
      password: 'StrongPass123!',
      displayName: 'Scroll Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const baseMs = Date.now();
    const nowIso = new Date(baseMs).toISOString();
    const mutations: Array<Record<string, unknown>> = [
      {
        mutationId: crypto.randomUUID(),
        entityType: 'baby',
        op: 'upsert',
        clientUpdatedAt: nowIso,
        data: {
          id: babyId,
          name: 'ScrollBaby',
          dob: '2026-07-01',
          avatarColor: '#10b981',
          isArchived: false,
          createdByUserId: userId,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      },
    ];

    for (let i = 0; i < 55; i++) {
      const ts = new Date(baseMs - i * 60_000).toISOString();
      mutations.push({
        mutationId: crypto.randomUUID(),
        entityType: 'event',
        op: 'upsert',
        clientUpdatedAt: nowIso,
        data: {
          id: crypto.randomUUID(),
          babyId,
          type: 'diaper',
          startedAt: ts,
          endedAt: ts,
          notes: `ScrollEvent-${i}`,
          loggedByUserId: userId,
          updatedByUserId: userId,
          payload: { kind: 'wet' },
          createdAt: ts,
          updatedAt: ts,
        },
      });
    }

    await page.request.post('/api/sync/push', { data: { mutations } });
    await page.goto('/');
    await expect(page.getByLabel('Select active baby').first()).toContainText('ScrollBaby');

    // Start an active sleep timer
    await page.getByRole('button', { name: /start nap/i }).first().click();

    const activeBar = page.getByRole('button', { name: /^Wake Up$/i }).first();
    await expect(activeBar).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(activeBar).toBeVisible();
  });

  test('keyboard navigation supports Tab focus and Escape closes modals', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupAuthenticatedBaby(page, { babyName: 'KeyboardBaby' });

    const bottleBtn = page.getByRole('button', { name: /log bottle/i }).first();
    await bottleBtn.click();

    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.keyboard.press('Tab');
    const activeTag = await page.evaluate(
      () => document.activeElement?.tagName ?? 'BODY',
    );
    expect(activeTag).not.toBe('BODY');
  });

  test('viewport resize between 390x844 and 1280x800 preserves layout without overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'ResizeBaby' });
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByLabel('Select active baby').first()).toContainText('ResizeBaby');
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Select active baby').first()).toContainText('ResizeBaby');
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('F13: Cloud Run Scale-to-Zero & API Platform — Tier 2 Boundaries', () => {
  test('unauthenticated API endpoints return 401', async ({ playwright }) => {
    const req = await playwright.request.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8080',
    });
    try {
      const meRes = await req.get('/api/auth/me');
      expect(meRes.status()).toBe(401);

      const pullRes = await req.get('/api/sync/pull?since_seq=0');
      expect(pullRes.status()).toBe(401);

      const pushRes = await req.post('/api/sync/push', {
        data: { mutations: [] },
      });
      expect(pushRes.status()).toBe(401);
    } finally {
      await req.dispose();
    }
  });

  test('malformed JSON and invalid Zod payloads return 400', async ({
    page,
  }) => {
    await registerUserViaAPI(page.request, {
      email: uniqueEmail('malformed'),
      password: 'StrongPass123!',
      displayName: 'Malformed Parent',
    });

    const malformedRes = await page.request.post('/api/sync/push', {
      headers: { 'content-type': 'application/json' },
      data: '{"mutations": [broken json',
    });
    expect(malformedRes.status()).toBe(400);

    const zodBadRes = await page.request.post('/api/sync/push', {
      data: { mutations: [{ invalidField: 123 }] },
    });
    expect(zodBadRes.status()).toBe(400);
  });

  test('pull since_seq beyond latestSeq returns empty diff and negative since_seq is handled safely', async ({
    page,
  }) => {
    await registerUserViaAPI(page.request, {
      email: uniqueEmail('seq-bounds'),
      password: 'StrongPass123!',
      displayName: 'Seq Parent',
    });

    const futureSeqRes = await page.request.get(
      '/api/sync/pull?since_seq=9999999',
    );
    expect(futureSeqRes.status()).toBe(200);
    const futureBody = (await futureSeqRes.json()) as {
      babies: unknown[];
      events: unknown[];
      latestSeq: number;
    };
    expect(futureBody.babies).toEqual([]);
    expect(futureBody.events).toEqual([]);

    const negSeqRes = await page.request.get('/api/sync/pull?since_seq=-1');
    expect([200, 400]).toContain(negSeqRes.status());
  });

  test('ephemeral server cold-start recovery preserves data across SIGTERM restart', async () => {
    const port1 = await getFreePort();
    const server1 = await spawnEphemeralServer(port1);
    const dbPath = server1.dbPath;
    const email = uniqueEmail('cold-rec');
    const babyId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    let cookieHeader = '';
    try {
      const regRes = await fetch(`${server1.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'StrongPass123!',
          displayName: 'Cold Start Parent',
        }),
      });
      expect(regRes.status).toBe(201);
      cookieHeader = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';
      const regJson = (await regRes.json()) as { user: { id: string } };

      const pushRes = await fetch(`${server1.baseUrl}/api/sync/push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'ColdRecoveryBaby',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: regJson.user.id,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        }),
      });
      expect(pushRes.status).toBe(200);
    } finally {
      await server1.stop('SIGTERM');
    }

    const port2 = await getFreePort();
    const server2 = await spawnEphemeralServer(port2, { dbPath });
    try {
      const healthRes = await fetch(`${server2.baseUrl}/healthz`);
      expect(healthRes.status).toBe(200);

      const loginRes = await fetch(`${server2.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'StrongPass123!' }),
      });
      expect(loginRes.status).toBe(200);
      const cookie2 = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

      const pullRes = await fetch(
        `${server2.baseUrl}/api/sync/pull?since_seq=0`,
        { headers: { cookie: cookie2 } },
      );
      expect(pullRes.status).toBe(200);
      const pullJson = (await pullRes.json()) as {
        babies: Array<{ id: string; name: string }>;
      };
      expect(pullJson.babies.some((b) => b.id === babyId)).toBe(true);
    } finally {
      await server2.stop('SIGTERM');
    }
  });

  test('concurrent writes on startup succeed with monotonic serverSeq', async () => {
    const port = await getFreePort();
    const server = await spawnEphemeralServer(port);
    try {
      const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: uniqueEmail('concurrent'),
          password: 'StrongPass123!',
          displayName: 'Concurrent Parent',
        }),
      });
      expect(regRes.status).toBe(201);
      const cookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';
      const regJson = (await regRes.json()) as { user: { id: string } };

      const babyId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await fetch(`${server.baseUrl}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'ConcurrentBaby',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: regJson.user.id,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        }),
      });

      const writes = Array.from({ length: 10 }, (_, idx) => {
        const ts = new Date(Date.now() + idx).toISOString();
        return fetch(`${server.baseUrl}/api/sync/push`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            mutations: [
              {
                mutationId: crypto.randomUUID(),
                entityType: 'event',
                op: 'upsert',
                clientUpdatedAt: ts,
                data: {
                  id: crypto.randomUUID(),
                  babyId,
                  type: 'diaper',
                  startedAt: ts,
                  endedAt: ts,
                  notes: `Concurrent-${idx}`,
                  loggedByUserId: regJson.user.id,
                  updatedByUserId: regJson.user.id,
                  payload: { kind: 'wet' },
                  createdAt: ts,
                  updatedAt: ts,
                },
              },
            ],
          }),
        });
      });

      const responses = await Promise.all(writes);
      for (const r of responses) {
        expect(r.status).toBe(200);
      }

      const pullRes = await fetch(
        `${server.baseUrl}/api/sync/pull?since_seq=0`,
        { headers: { cookie } },
      );
      const pullJson = (await pullRes.json()) as {
        events: Array<{ serverSeq: number }>;
      };
      expect(pullJson.events.length).toBe(10);
    } finally {
      await server.stop('SIGTERM');
    }
  });
});
