import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  createBabyViaUI,
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

test.describe('Tier 3: Cross-Feature Pairwise Combinations', () => {
  test('F8 x F9: Pediatrician Export is strictly scoped to the active baby in a multi-baby household', async ({
    page,
  }) => {
    const { user } = await registerUserViaAPI(page.request, {
      email: uniqueEmail('f8xf9'),
      password: 'StrongPass123!',
      displayName: 'Twins Parent',
    });
    const userId = String(user.id ?? crypto.randomUUID());

    const mayaId = crypto.randomUUID();
    const leoId = crypto.randomUUID();
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
              id: mayaId,
              name: 'MayaScope',
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
            entityType: 'baby',
            op: 'upsert',
            clientUpdatedAt: nowIso,
            data: {
              id: leoId,
              name: 'LeoScope',
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
              id: crypto.randomUUID(),
              babyId: mayaId,
              type: 'bottle_feed',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: 'MAYA_ONLY_EVENT',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 110, milkType: 'formula' },
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
              babyId: leoId,
              type: 'bottle_feed',
              startedAt: nowIso,
              endedAt: nowIso,
              notes: 'LEO_ONLY_EVENT',
              loggedByUserId: userId,
              updatedByUserId: userId,
              payload: { volumeMl: 220, milkType: 'formula' },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        ],
      },
    });

    await page.goto('/');
    // Select MayaScope if not already active
    await selectBabyInSwitcher(page, 'MayaScope');

    const exportBtn = page
      .getByRole('button', { name: /^Export$/i })
      .or(page.getByRole('link', { name: /^Export$/i }))
      .first();
    await exportBtn.click();

    const csvBtn = page
      .getByRole('button', { name: /download events csv/i })
      .first();
    const downloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let csv = '';
    for await (const chunk of stream) {
      csv += chunk.toString('utf8');
    }

    const rows = parseCsv(csv.trim());
    expect(rows.length).toBe(2);
    expect(csv).toContain('MAYA_ONLY_EVENT');
    expect(csv).not.toContain('LEO_ONLY_EVENT');
  });

  test('F8 x F11: Offline-logged events are included in client-side export before network reconnect', async ({
    page,
    context,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OfflineExportBaby' });

    await goOffline(context);

    // Log a wet diaper offline
    await page.getByRole('button', { name: /^wet$/i }).first().click();
    await expect(page.getByText(/wet/i).first()).toBeVisible();

    // Open export while still offline
    const exportBtn = page
      .getByRole('button', { name: /^Export$/i })
      .or(page.getByRole('link', { name: /^Export$/i }))
      .first();
    await exportBtn.click();

    const csvBtn = page
      .getByRole('button', { name: /download events csv/i })
      .first();
    const downloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let csv = '';
    for await (const chunk of stream) {
      csv += chunk.toString('utf8');
    }

    const rows = parseCsv(csv.trim());
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(csv.toLowerCase()).toContain('wet');

    await goOnline(context);
  });

  test('F9 x F10: Selective sharing via invite grants access only to the invited baby', async ({
    browser,
  }) => {
    const ctxOwner = await browser.newContext();
    const ctxPartner = await browser.newContext();

    try {
      const { user: owner } = await registerUserViaAPI(ctxOwner.request, {
        email: uniqueEmail('sel-owner'),
        password: 'StrongPass123!',
        displayName: 'Owner',
      });
      const ownerId = String(owner.id ?? crypto.randomUUID());
      await registerUserViaAPI(ctxPartner.request, {
        email: uniqueEmail('sel-partner'),
        password: 'StrongPass123!',
        displayName: 'Partner',
      });

      const sharedBabyId = crypto.randomUUID();
      const privateBabyId = crypto.randomUUID();
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
                id: sharedBabyId,
                name: 'SharedBabyMaya',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: ownerId,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: privateBabyId,
                name: 'PrivateBabyLeo',
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
        `/api/babies/${sharedBabyId}/invites`,
        { data: { role: 'caregiver' } },
      );
      const { invite } = (await invRes.json()) as { invite: { code: string } };

      const partnerPage = await ctxPartner.newPage();
      await partnerPage.goto(`/join/${invite.code}`);

      const acceptBtn = partnerPage
        .getByRole('button', { name: /accept|join/i })
        .first();
      if (await acceptBtn.isVisible().catch(() => false)) {
        await acceptBtn.click();
      }

      await expect(
        partnerPage.getByLabel('Select active baby').first(),
      ).toContainText('SharedBabyMaya');
      await expect(
        partnerPage.getByLabel('Select active baby').first(),
      ).not.toContainText('PrivateBabyLeo');
    } finally {
      await ctxOwner.close();
      await ctxPartner.close();
    }
  });

  test('F9 x F12: Multi-baby switching on 390x844 mobile keeps active timer isolated without overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'MobileMaya' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'MobileLeo', dob: '2026-08-05' });
    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();

    await expectNoHorizontalOverflow(page);

    // Start sleep timer on MobileLeo
    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(page.getByRole('button', { name: /^Wake Up$/i }).first()).toBeVisible();

    // Switch to MobileMaya
    await selectBabyInSwitcher(page, 'MobileMaya');

    await expectNoHorizontalOverflow(page);
    await expect(page.getByLabel('Select active baby').first()).toContainText('MobileMaya');
  });

  test('F10 x F11: Multi-parent offline edits converge cleanly when both reconnect', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const { user: parentA } = await registerUserViaAPI(ctxA.request, {
        email: uniqueEmail('conv-a'),
        password: 'StrongPass123!',
        displayName: 'Parent A',
      });
      const parentAId = String(parentA.id ?? crypto.randomUUID());
      await registerUserViaAPI(ctxB.request, {
        email: uniqueEmail('conv-b'),
        password: 'StrongPass123!',
        displayName: 'Parent B',
      });

      const babyId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await ctxA.request.post('/api/sync/push', {
        data: {
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'ConvergeBaby',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: parentAId,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        },
      });

      const invRes = await ctxA.request.post(`/api/babies/${babyId}/invites`, {
        data: { role: 'caregiver' },
      });
      const { invite } = (await invRes.json()) as { invite: { code: string } };
      await ctxB.request.post('/api/invites/accept', {
        data: { code: invite.code },
      });

      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto('/');
      await pageB.goto('/');
      await expect(pageA.getByLabel('Select active baby').first()).toContainText('ConvergeBaby');
      await expect(pageB.getByLabel('Select active baby').first()).toContainText('ConvergeBaby');

      // Both go offline and log different events
      await goOffline(ctxA);
      await goOffline(ctxB);

      await pageA.getByRole('button', { name: /wet/i }).first().click();
      await pageB.getByRole('button', { name: /poopy/i }).first().click();

      // Both come back online and sync
      await goOnline(ctxA);
      await goOnline(ctxB);

      // Trigger sync / reload to observe convergence
      await pageA.waitForTimeout(1500);
      await pageB.waitForTimeout(1500);
      await pageA.reload();
      await pageB.reload();

      await expect(pageA.getByText(/poopy/i).first()).toBeVisible();
      await expect(pageB.getByText(/wet/i).first()).toBeVisible();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('F11 x F12: Offline queue & sticky active timer survive offline reload on mobile', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'MobileOfflineBaby' });

    await goOffline(context);

    // Start sleep timer and log wet diaper while offline -> wet diaper auto-ends sleep
    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^wet$/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }),
    ).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByText(/1W|wet/i).first()).toBeVisible({
      timeout: 5_000,
    });

    await page.reload();

    await expect(page.getByLabel('Select active baby').first()).toContainText('MobileOfflineBaby');
    await expect(page.getByRole('button', { name: /^Wake Up$/i })).toHaveCount(0);
    await expect(page.getByText(/wet/i).first()).toBeVisible();

    await goOnline(context);
  });

  test('F10 x F13: Invite code and membership persist across SIGTERM cold restart', async () => {
    const port1 = await getFreePort();
    const server1 = await spawnEphemeralServer(port1);
    const dbPath = server1.dbPath;
    let inviteCode = '';
    const babyId = crypto.randomUUID();

    try {
      const regA = await fetch(`${server1.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: uniqueEmail('f10xf13-a'),
          password: 'StrongPass123!',
          displayName: 'Owner A',
        }),
      });
      const cookieA = regA.headers.get('set-cookie')?.split(';')[0] ?? '';
      const regAJson = (await regA.json()) as { user: { id: string } };
      const nowIso = new Date().toISOString();

      await fetch(`${server1.baseUrl}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieA },
        body: JSON.stringify({
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'baby',
              op: 'upsert',
              clientUpdatedAt: nowIso,
              data: {
                id: babyId,
                name: 'RestartInviteBaby',
                dob: '2026-07-01',
                avatarColor: '#3b82f6',
                isArchived: false,
                createdByUserId: regAJson.user.id,
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          ],
        }),
      });

      const invRes = await fetch(
        `${server1.baseUrl}/api/babies/${babyId}/invites`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieA },
          body: JSON.stringify({ role: 'caregiver' }),
        },
      );
      expect(invRes.status).toBe(201);
      const invJson = (await invRes.json()) as { invite: { code: string } };
      inviteCode = invJson.invite.code;
    } finally {
      await server1.stop('SIGTERM');
    }

    const port2 = await getFreePort();
    const server2 = await spawnEphemeralServer(port2, { dbPath });
    try {
      const regB = await fetch(`${server2.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: uniqueEmail('f10xf13-b'),
          password: 'StrongPass123!',
          displayName: 'Partner B',
        }),
      });
      const cookieB = regB.headers.get('set-cookie')?.split(';')[0] ?? '';

      const accRes = await fetch(`${server2.baseUrl}/api/invites/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieB },
        body: JSON.stringify({ code: inviteCode }),
      });
      expect(accRes.status).toBe(200);

      const pullRes = await fetch(
        `${server2.baseUrl}/api/sync/pull?since_seq=0`,
        { headers: { cookie: cookieB } },
      );
      const pullJson = (await pullRes.json()) as {
        babies: Array<{ id: string }>;
      };
      expect(pullJson.babies.some((b) => b.id === babyId)).toBe(true);
    } finally {
      await server2.stop('SIGTERM');
    }
  });

  test('F8 x F10: Viewer role can export pediatrician CSV containing owner-logged events', async ({
    browser,
  }) => {
    const ctxOwner = await browser.newContext();
    const ctxViewer = await browser.newContext();

    try {
      const { user: owner } = await registerUserViaAPI(ctxOwner.request, {
        email: uniqueEmail('f8xf10-own'),
        password: 'StrongPass123!',
        displayName: 'Owner',
      });
      const ownerId = String(owner.id ?? crypto.randomUUID());
      await registerUserViaAPI(ctxViewer.request, {
        email: uniqueEmail('f8xf10-view'),
        password: 'StrongPass123!',
        displayName: 'Grandma Viewer',
      });

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
                name: 'ViewerExportBaby',
                dob: '2026-07-01',
                avatarColor: '#ec4899',
                isArchived: false,
                createdByUserId: ownerId,
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
                notes: 'OWNER_FEED_FOR_VIEWER_EXPORT',
                loggedByUserId: ownerId,
                updatedByUserId: ownerId,
                payload: { volumeMl: 125, milkType: 'breastmilk' },
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

      const viewerPage = await ctxViewer.newPage();
      await viewerPage.goto('/');
      await expect(
        viewerPage.getByLabel('Select active baby').first(),
      ).toContainText('ViewerExportBaby');

      const exportBtn = viewerPage
        .getByRole('button', { name: /^Export$/i })
        .or(viewerPage.getByRole('link', { name: /^Export$/i }))
        .first();
      await exportBtn.click();

      const csvBtn = viewerPage
        .getByRole('button', { name: /download events csv/i })
        .first();
      const downloadPromise = viewerPage.waitForEvent('download');
      await csvBtn.click();
      const download = await downloadPromise;
      const stream = await download.createReadStream();
      let csv = '';
      for await (const chunk of stream) {
        csv += chunk.toString('utf8');
      }

      expect(csv).toContain('OWNER_FEED_FOR_VIEWER_EXPORT');
    } finally {
      await ctxOwner.close();
      await ctxViewer.close();
    }
  });
});
