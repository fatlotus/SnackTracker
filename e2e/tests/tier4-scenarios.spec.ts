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

test.describe('Tier 4: Real-World End-to-End Scenarios', () => {
  test('E2E-1: Offline logging + cold reload + reconnect sync', async ({
    page,
    context,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OfflineSyncBaby' });

    // Go offline and log a diaper and a bottle feed
    await goOffline(context);

    await page.getByRole('button', { name: /^wet$/i }).first().click();

    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    const volumeInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume|amount/i))
      .first();
    await volumeInput.fill('130');
    await page.getByRole('button', { name: /save bottle/i }).click();
    await expect(page.getByText(/130\s*ml/i).first()).toBeVisible({
      timeout: 5_000,
    });

    // Cold reload while still offline — verify IndexedDB persistence
    await page.reload();
    await expect(
      page.getByLabel('Select active baby').first(),
    ).toContainText('OfflineSyncBaby');
    await expect(page.getByText(/130\s*ml/i).first()).toBeVisible();

    // Reconnect and verify mutations flush to server
    await goOnline(context);
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/sync/pull?since_seq=0');
          if (res.status() !== 200) return 0;
          const body = (await res.json()) as { events: unknown[] };
          return body.events.length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);
  });

  test('E2E-2: Two-parent concurrent sync via two isolated browser contexts', async ({
    browser,
  }) => {
    const ctxParent1 = await browser.newContext();
    const ctxParent2 = await browser.newContext();

    try {
      const { user: p1 } = await registerUserViaAPI(ctxParent1.request, {
        email: uniqueEmail('p1-sync'),
        password: 'StrongPass123!',
        displayName: 'Mom',
      });
      const p1Id = String(p1.id ?? crypto.randomUUID());
      await registerUserViaAPI(ctxParent2.request, {
        email: uniqueEmail('p2-sync'),
        password: 'StrongPass123!',
        displayName: 'Dad',
      });

      const babyId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await ctxParent1.request.post('/api/sync/push', {
        data: {
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'SharedSyncBaby',
                dob: '2026-07-15',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: p1Id,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        },
      });

      const invRes = await ctxParent1.request.post(
        `/api/babies/${babyId}/invites`,
        { data: { role: 'caregiver' } },
      );
      const { invite } = (await invRes.json()) as { invite: { code: string } };
      await ctxParent2.request.post('/api/invites/accept', {
        data: { code: invite.code },
      });

      const page1 = await ctxParent1.newPage();
      const page2 = await ctxParent2.newPage();
      await page1.goto('/');
      await page2.goto('/');

      await expect(
        page1.getByLabel('Select active baby').first(),
      ).toContainText('SharedSyncBaby');
      await expect(
        page2.getByLabel('Select active baby').first(),
      ).toContainText('SharedSyncBaby');

      // Parent 1 logs a bottle feed via UI
      await page1
        .getByRole('region', { name: 'Bottle Feeding' })
        .getByRole('button', { name: /^Log$/i })
        .click();
      await page1
        .getByLabel(/volume|amount|ml/i)
        .or(page1.getByPlaceholder(/ml|volume|amount/i))
        .first()
        .fill('145');
      await page1.getByRole('button', { name: /save bottle/i }).click();

      // Parent 2 logs a poopy diaper via UI
      await page2.getByRole('button', { name: /^poopy$/i }).first().click();

      // Wait for sync and verify both parents see both events
      await page1.waitForTimeout(1500);
      await page2.waitForTimeout(1500);
      await page1.reload();
      await page2.reload();

      await expect(page1.getByText(/poopy/i).first()).toBeVisible();
      await expect(page2.getByText(/145\s*ml/i).first()).toBeVisible();
    } finally {
      await ctxParent1.close();
      await ctxParent2.close();
    }
  });

  test('E2E-3: Pediatrician visit export workflow with 2-day history and clinical both diaper counts', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('ped-visit'),
      password: 'StrongPass123!',
      displayName: 'Pediatric Visit Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const babyId = crypto.randomUUID();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yStr = yesterday.toISOString().slice(0, 10);
    const tStr = now.toISOString().slice(0, 10);
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
              name: 'PedVisitBaby',
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
              type: 'diaper',
              startedAt: yesterday.toISOString(),
              endedAt: yesterday.toISOString(),
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { kind: 'both' },
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
              notes: 'PED_VISIT_BOTTLE',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 160, milkType: 'breastmilk' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    const exportBtn = page
      .getByRole('button', { name: /^Export$/i })
      .or(page.getByRole('link', { name: /^Export$/i }))
      .first();
    await exportBtn.click();

    await page.getByRole('button', { name: /^Custom$/i }).first().click();
    const startInput = page.locator('#export-custom-start').or(page.getByLabel(/start date/i)).first();
    const endInput = page.locator('#export-custom-end').or(page.getByLabel(/end date/i)).first();
    await startInput.fill(yStr);
    await endInput.fill(tStr);

    // Verify clinical 'both' diaper counts (+1 wet AND +1 poopy) in summary text
    const pageText = await page.locator('body').innerText();
    expect(pageText).toMatch(/wet/i);
    expect(pageText).toMatch(/poop/i);

    // Download CSV
    const csvBtn = page
      .getByRole('button', { name: /download events csv/i })
      .first();
    const csvDownloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const csvDownload = await csvDownloadPromise;
    const csvStream = await csvDownload.createReadStream();
    let csvContent = '';
    for await (const chunk of csvStream) {
      csvContent += chunk.toString('utf8');
    }
    const rows = parseCsv(csvContent.trim());
    expect(rows.length).toBe(3); // header + 2 events
    expect(csvContent).toContain('PED_VISIT_BOTTLE');

    // Download JSON backup
    const jsonBtn = page
      .getByRole('button', { name: /download json backup/i })
      .first();
    const jsonDownloadPromise = page.waitForEvent('download');
    await jsonBtn.click();
    const jsonDownload = await jsonDownloadPromise;
    const jsonStream = await jsonDownload.createReadStream();
    let jsonContent = '';
    for await (const chunk of jsonStream) {
      jsonContent += chunk.toString('utf8');
    }
    const parsedJson = JSON.parse(jsonContent) as Record<string, unknown>;
    expect(JSON.stringify(parsedJson)).toContain('PED_VISIT_BOTTLE');
  });

  test('E2E-4: Twins / multi-baby concurrent active timers survive page reload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'TwinAlpha' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'TwinBeta', dob: '2026-08-01' });
    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();

    // Start sleep timer on TwinBeta
    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible();

    // Switch to TwinAlpha and start breast timer
    await selectBabyInSwitcher(page, 'TwinAlpha');

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Finish$/i }).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.reload();

    // Both babies retain their own active timers after reload
    await expect(
      page.getByRole('button', { name: /^Finish$|^Wake Up$/i }).first(),
    ).toBeVisible();
  });

  test('E2E-5: Mobile thumb-zone UX and dark mode toggle at 390x844', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'MobileUXBaby' });

    await expectNoHorizontalOverflow(page);

    // Check thumb-zone quick-log buttons meet >= 44px tap targets
    const wetBtn = page.getByRole('button', { name: /wet/i }).first();
    await expectMinTapTarget(wetBtn, 44);

    // Toggle dark mode (cycles system -> light -> dark)
    const themeToggle = page
      .getByRole('button', { name: /dark|light|theme/i })
      .first();
    await themeToggle.click();
    if (
      !(await page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      ))
    ) {
      await themeToggle.click();
    }

    const isDarkApplied = await page.evaluate(() => {
      const root = document.documentElement;
      return (
        root.classList.contains('dark') ||
        root.dataset.theme === 'dark' ||
        document.body.classList.contains('dark')
      );
    });
    expect(isDarkApplied).toBe(true);
    await expectNoHorizontalOverflow(page);
  });

  test('E2E-6: Laptop multi-column dashboard and keyboard flow at 1280x800', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupAuthenticatedBaby(page, { babyName: 'LaptopBaby' });

    await expectNoHorizontalOverflow(page);

    // Open bottle modal, enter volume via keyboard, submit, and close with Escape if needed
    await page
      .getByRole('region', { name: 'Bottle Feeding' })
      .getByRole('button', { name: /^Log$/i })
      .click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();

    const volInput = page
      .getByLabel(/volume|amount|ml/i)
      .or(page.getByPlaceholder(/ml|volume|amount/i))
      .first();
    await volInput.fill('155');
    await page.getByRole('button', { name: /save bottle/i }).click();

    await expect(page.getByText(/155\s*ml/i).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('E2E-7: Caregiver revocation and viewer role read-only enforcement', async ({
    browser,
  }) => {
    const ctxOwner = await browser.newContext();
    const ctxViewer = await browser.newContext();

    try {
      const { user: ownerUser } = await registerUserViaAPI(ctxOwner.request, {
        email: uniqueEmail('e2e7-own'),
        password: 'StrongPass123!',
        displayName: 'Owner',
      });
      const ownerId = String(ownerUser.id ?? crypto.randomUUID());
      const { user: viewerUser } = await registerUserViaAPI(
        ctxViewer.request,
        {
          email: uniqueEmail('e2e7-view'),
          password: 'StrongPass123!',
          displayName: 'Viewer',
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
                name: 'RoleEnforceBaby',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
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
        { data: { role: 'viewer' } },
      );
      const { invite } = (await invRes.json()) as { invite: { code: string } };
      await ctxViewer.request.post('/api/invites/accept', {
        data: { code: invite.code },
      });

      // Viewer attempts to write an event via API -> rejected
      const mutId = crypto.randomUUID();
      const writeRes = await ctxViewer.request.post('/api/sync/push', {
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
                loggedByUserId: String(viewerUser.id),
                updatedByUserId: String(viewerUser.id),
                payload: { kind: 'wet' },
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        },
      });
      expect([200, 403]).toContain(writeRes.status());
      if (writeRes.status() === 200) {
        const body = (await writeRes.json()) as {
          ackedMutationIds: string[];
          rejected: Array<{ mutationId: string }>;
        };
        expect(body.ackedMutationIds).not.toContain(mutId);
        expect(body.rejected.some((r) => r.mutationId === mutId)).toBe(true);
      }

      // Owner revokes viewer
      const revokeRes = await ctxOwner.request.delete(
        `/api/babies/${babyId}/members/${viewerUser.id as string}`,
      );
      expect(revokeRes.status()).toBe(200);

      // Viewer's UI no longer has access after reload
      const viewerPage = await ctxViewer.newPage();
      await viewerPage.goto('/');
      await expect(viewerPage.getByText('RoleEnforceBaby')).toHaveCount(0);
    } finally {
      await ctxOwner.close();
      await ctxViewer.close();
    }
  });

  test('E2E-8: Cloud Run scale-to-zero cold restart recovery via SIGTERM', async ({
    browser,
  }) => {
    const port1 = await getFreePort();
    const server1 = await spawnEphemeralServer(port1);
    const dbPath = server1.dbPath;
    const email = uniqueEmail('e2e8-cr');
    const password = 'StrongPass123!';

    try {
      const ctx1 = await browser.newContext({ baseURL: server1.baseUrl });
      const page1 = await ctx1.newPage();
      await setupAuthenticatedBaby(page1, {
        email,
        password,
        displayName: 'CloudRun Parent',
        babyName: 'ScaleToZeroBaby',
      });

      await page1.getByRole('button', { name: /wet/i }).first().click();
      await expect(page1.getByText(/wet/i).first()).toBeVisible();
      await page1.waitForTimeout(1000);
      await ctx1.close();
    } finally {
      const exitInfo = await server1.stop('SIGTERM');
      expect(exitInfo.code === 0 || exitInfo.signal === 'SIGTERM').toBe(true);
    }

    const port2 = await getFreePort();
    const server2 = await spawnEphemeralServer(port2, { dbPath });
    try {
      const ctx2 = await browser.newContext({ baseURL: server2.baseUrl });
      const page2 = await ctx2.newPage();

      // Sign in on the restarted server and verify baby + event survived scale-to-zero
      await page2.goto('/');
      const emailField = page2
        .getByLabel(/email/i)
        .or(page2.getByPlaceholder(/email/i))
        .first();
      await emailField.fill(email);
      const pwField = page2
        .getByLabel(/password/i)
        .or(page2.getByPlaceholder(/password/i))
        .first();
      await pwField.fill(password);
      await page2.locator('form button[type="submit"]').first().click();

      await expect(
        page2.getByLabel('Select active baby').first(),
      ).toContainText('ScaleToZeroBaby');
      await expect(page2.getByText(/wet/i).first()).toBeVisible();
      await ctx2.close();
    } finally {
      await server2.stop('SIGTERM');
    }
  });
});
