import { expect, test, type Download, type Page } from '@playwright/test';
import {
  registerUserViaAPI,
  setupAuthenticatedBaby,
  uniqueEmail,
} from '../helpers/app.js';

type NavTab = 'Dashboard' | 'Timeline' | 'Trends' | 'Export' | 'Family';

async function openTab(page: Page, tab: NavTab): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${tab}$`, 'i') }).first().click();
}

async function logBottleViaUI(
  page: Page,
  volumeMl: number,
  notes: string,
): Promise<void> {
  const bottleCard = page.getByRole('region', { name: 'Bottle Feeding' });
  await expect(bottleCard).toBeVisible();
  await bottleCard.getByRole('button', { name: /^Log$/i }).click();

  const dialog = page.getByRole('dialog', { name: /Log Bottle Feed/i });
  await expect(dialog).toBeVisible();
  await dialog.locator('#bottle-volume').fill(String(volumeMl));
  await dialog.locator('#bottle-notes').fill(notes);
  await dialog.getByRole('button', { name: /Save Bottle/i }).click();
  await expect(dialog).toBeHidden();
}

async function logPumpingViaUI(
  page: Page,
  volumeMl: number,
  notes: string,
): Promise<void> {
  const pumpingCard = page.getByRole('region', { name: 'Pumping' });
  await expect(pumpingCard).toBeVisible();
  await pumpingCard.getByRole('button', { name: /^Log$/i }).click();

  const dialog = page.getByRole('dialog', { name: /Log Pumping/i });
  await expect(dialog).toBeVisible();
  await dialog.locator('#pumping-volume').fill(String(volumeMl));
  await dialog.locator('#pumping-notes').fill(notes);
  await dialog.getByRole('button', { name: /Save Pumping/i }).click();
  await expect(dialog).toBeHidden();
}

async function syncNowViaSettings(page: Page): Promise<void> {
  await openTab(page, 'Family');
  const syncBtn = page
    .getByRole('main')
    .getByRole('button', { name: /Sync Now/i });
  await expect(syncBtn).toBeVisible();
  await syncBtn.click();
  await expect(page.getByText(/\(0 pending\)/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Sync:\s*synced/i)).toBeVisible({
    timeout: 15_000,
  });
}

async function generateInviteCodeViaUI(
  page: Page,
  role: 'parent' | 'caregiver' | 'viewer',
): Promise<string> {
  await openTab(page, 'Family');
  const inviteSelect = page.getByLabel('Invite role');
  await expect(inviteSelect).toBeVisible();
  await inviteSelect.selectOption(role);

  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes('/invites') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Generate Invite Link' }).click();
  const res = await responsePromise;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { invite: { code: string; role: string } };
  expect(body.invite.role).toBe(role);

  const codeEl = page
    .locator('section')
    .filter({ hasText: 'Family & Caregivers' })
    .locator('code')
    .first();
  await expect(codeEl).toHaveText(body.invite.code, { timeout: 10_000 });
  return body.invite.code;
}

async function readDownloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) {
    throw new Error('Download stream was null');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function registerAndAcceptInvite(
  page: Page,
  opts: { email: string; password: string; displayName: string; code: string; babyName: string },
): Promise<void> {
  await registerUserViaAPI(page.request, {
    email: opts.email,
    password: opts.password,
    displayName: opts.displayName,
  });

  const acceptRes = await page.request.post('/api/invites/accept', {
    data: { code: opts.code },
  });
  expect(acceptRes.status()).toBe(200);

  await page.goto('/');
  await expect(page.getByLabel('Select active baby').first()).toContainText(
    opts.babyName,
    { timeout: 15_000 },
  );
}

test.describe('Roles, Pumping Isolation & JSON Backup Import', () => {
  test('Parent vs. Caregiver vs. Viewer pumping visibility and export isolation', async ({
    browser,
  }) => {
    const ctxParent = await browser.newContext();
    const ctxCaregiver = await browser.newContext();
    const ctxViewer = await browser.newContext();

    try {
      const parentPage = await ctxParent.newPage();
      await setupAuthenticatedBaby(parentPage, {
        email: uniqueEmail('rbac-parent'),
        displayName: 'Parent Alice',
        babyName: 'RbacBaby',
      });

      // Parent logs a pumping event + a bottle feed
      await logPumpingViaUI(parentPage, 110, 'Parent secret pump');
      await logBottleViaUI(parentPage, 125, 'Shared bottle feed');

      // Confirm Parent sees pumping on Dashboard
      await expect(
        parentPage.getByRole('region', { name: 'Pumping' }),
      ).toBeVisible();
      await expect(parentPage.getByText('Pumping Today')).toBeVisible();

      // Sync to server and create Caregiver + Viewer invites via Settings UI
      await syncNowViaSettings(parentPage);
      const caregiverCode = await generateInviteCodeViaUI(
        parentPage,
        'caregiver',
      );
      const viewerCode = await generateInviteCodeViaUI(parentPage, 'viewer');

      // --- Caregiver checks ---
      const caregiverPage = await ctxCaregiver.newPage();
      await registerAndAcceptInvite(caregiverPage, {
        email: uniqueEmail('rbac-caregiver'),
        password: 'StrongPass123!',
        displayName: 'Caregiver Bob',
        code: caregiverCode,
        babyName: 'RbacBaby',
      });

      // Dashboard: NO Pumping card, NO Pumping Today summary card; bottle feed IS visible
      await expect(
        caregiverPage.getByRole('region', { name: 'Bottle Feeding' }),
      ).toBeVisible();
      await expect(caregiverPage.getByText('125 ml').first()).toBeVisible();
      await expect(
        caregiverPage.getByRole('region', { name: 'Pumping' }),
      ).toHaveCount(0);
      await expect(caregiverPage.getByText('Pumping Today')).toHaveCount(0);

      // Timeline: NO Pumping filter pill, NO pumping event; bottle event IS visible
      await openTab(caregiverPage, 'Timeline');
      await expect(
        caregiverPage.getByText('Shared bottle feed'),
      ).toBeVisible();
      await expect(
        caregiverPage.getByRole('button', { name: 'Pumping', exact: true }),
      ).toHaveCount(0);
      await expect(caregiverPage.getByText('Parent secret pump')).toHaveCount(
        0,
      );
      await expect(caregiverPage.getByText('110 ml')).toHaveCount(0);

      // Trends: NO Avg Pumping / Day KPI, NO Pumping chart
      await openTab(caregiverPage, 'Trends');
      await expect(
        caregiverPage.getByText('Avg Pumping / Day'),
      ).toHaveCount(0);
      await expect(
        caregiverPage.getByText(/Pumping \(ml \/ Day\)/i),
      ).toHaveCount(0);

      // Export: NO Pumping preview card; JSON & CSV downloads contain zero /pump/i references
      await openTab(caregiverPage, 'Export');
      await expect(
        caregiverPage.getByText('Pumping Avg / Day'),
      ).toHaveCount(0);

      const jsonDlPromise = caregiverPage.waitForEvent('download');
      await caregiverPage
        .getByRole('button', { name: 'Download JSON Backup' })
        .click();
      const caregiverJson = await readDownloadText(await jsonDlPromise);
      expect(/pump/i.test(caregiverJson)).toBe(false);
      expect(caregiverJson).toContain('Shared bottle feed');
      expect(caregiverJson).toContain('125');

      const eventsCsvPromise = caregiverPage.waitForEvent('download');
      await caregiverPage
        .getByRole('button', { name: 'Download Events CSV' })
        .click();
      const caregiverEventsCsv = await readDownloadText(await eventsCsvPromise);
      expect(/pump/i.test(caregiverEventsCsv)).toBe(false);
      expect(caregiverEventsCsv).toContain('125');

      const dailyCsvPromise = caregiverPage.waitForEvent('download');
      await caregiverPage
        .getByRole('button', { name: 'Download Daily Stats CSV' })
        .click();
      const caregiverDailyCsv = await readDownloadText(await dailyCsvPromise);
      expect(/pump/i.test(caregiverDailyCsv)).toBe(false);

      // --- Viewer checks ---
      const viewerPage = await ctxViewer.newPage();
      await registerAndAcceptInvite(viewerPage, {
        email: uniqueEmail('rbac-viewer'),
        password: 'StrongPass123!',
        displayName: 'Viewer Carol',
        code: viewerCode,
        babyName: 'RbacBaby',
      });

      // Dashboard: zero Pumping UI
      await expect(
        viewerPage.getByRole('region', { name: 'Pumping' }),
      ).toHaveCount(0);
      await expect(viewerPage.getByText('Pumping Today')).toHaveCount(0);

      // Timeline: zero Pumping UI, bottle event visible
      await openTab(viewerPage, 'Timeline');
      await expect(viewerPage.getByText('Shared bottle feed')).toBeVisible();
      await expect(
        viewerPage.getByRole('button', { name: 'Pumping', exact: true }),
      ).toHaveCount(0);
      await expect(viewerPage.getByText('Parent secret pump')).toHaveCount(0);

      // Trends: zero Pumping UI
      await openTab(viewerPage, 'Trends');
      await expect(viewerPage.getByText('Avg Pumping / Day')).toHaveCount(0);
      await expect(
        viewerPage.getByText(/Pumping \(ml \/ Day\)/i),
      ).toHaveCount(0);

      // Export: zero Pumping UI AND NO JSON restore card
      await openTab(viewerPage, 'Export');
      await expect(viewerPage.getByText('Pumping Avg / Day')).toHaveCount(0);
      await expect(
        viewerPage.getByRole('heading', { name: 'Restore from JSON Backup' }),
      ).toHaveCount(0);

      // Settings: NO invite controls, NO inline role selects
      await openTab(viewerPage, 'Family');
      await expect(viewerPage.getByText('Parent Alice')).toBeVisible();
      await expect(viewerPage.getByLabel('Invite role')).toHaveCount(0);
      await expect(
        viewerPage.getByRole('button', { name: 'Generate Invite Link' }),
      ).toHaveCount(0);
      await expect(
        viewerPage.locator('select[aria-label^="Role for "]'),
      ).toHaveCount(0);
    } finally {
      await ctxParent.close();
      await ctxCaregiver.close();
      await ctxViewer.close();
    }
  });

  test('Per-person role management UI, ceiling enforcement, and live promotion/demotion sync', async ({
    browser,
  }) => {
    const ctxParent = await browser.newContext();
    const ctxCaregiver = await browser.newContext();
    const ctxViewer = await browser.newContext();

    try {
      const parentPage = await ctxParent.newPage();
      await setupAuthenticatedBaby(parentPage, {
        email: uniqueEmail('mgmt-parent'),
        displayName: 'Parent Dana',
        babyName: 'RoleSyncBaby',
      });

      await logPumpingViaUI(parentPage, 95, 'Live sync pump');
      await logBottleViaUI(parentPage, 100, 'Live sync bottle');
      await syncNowViaSettings(parentPage);

      const caregiverCode = await generateInviteCodeViaUI(
        parentPage,
        'caregiver',
      );
      const viewerCode = await generateInviteCodeViaUI(parentPage, 'viewer');

      const caregiverPage = await ctxCaregiver.newPage();
      await registerAndAcceptInvite(caregiverPage, {
        email: uniqueEmail('mgmt-caregiver'),
        password: 'StrongPass123!',
        displayName: 'Caregiver Eli',
        code: caregiverCode,
        babyName: 'RoleSyncBaby',
      });

      const viewerPage = await ctxViewer.newPage();
      await registerAndAcceptInvite(viewerPage, {
        email: uniqueEmail('mgmt-viewer'),
        password: 'StrongPass123!',
        displayName: 'Viewer Fran',
        code: viewerCode,
        babyName: 'RoleSyncBaby',
      });

      // --- Caregiver Family Settings & Ceiling Enforcement ---
      await openTab(caregiverPage, 'Family');
      const caregiverFamilySection = caregiverPage
        .locator('section')
        .filter({ hasText: 'Family & Caregivers' });
      await expect(
        caregiverFamilySection.getByText('Parent Dana'),
      ).toBeVisible();

      // Existing Parent has static "Parent" badge, NO inline <select>, NO Remove button
      const parentRow = caregiverFamilySection
        .locator('div.py-2\\.5')
        .filter({ hasText: 'Parent Dana' });
      await expect(
        parentRow.getByText('Parent', { exact: true }),
      ).toBeVisible();
      await expect(
        caregiverFamilySection.getByLabel('Role for Parent Dana'),
      ).toHaveCount(0);
      await expect(
        parentRow.getByRole('button', { name: 'Remove' }),
      ).toHaveCount(0);

      // Invite <select> shows ONLY Caregiver & Viewer (NEVER Parent)
      const caregiverInviteSelect =
        caregiverFamilySection.getByLabel('Invite role');
      await expect(caregiverInviteSelect).toBeVisible();
      const caregiverInviteValues = await caregiverInviteSelect
        .locator('option')
        .evaluateAll((opts) =>
          opts.map((o) => (o as HTMLOptionElement).value),
        );
      expect(caregiverInviteValues).toEqual(['caregiver', 'viewer']);

      // Role Permissions legend shows ONLY Caregiver & Viewer (NEVER Parent)
      const caregiverLegend = caregiverFamilySection
        .locator('ul')
        .first();
      await expect(caregiverLegend).toContainText('Caregiver:');
      await expect(caregiverLegend).toContainText('Viewer:');
      await expect(caregiverLegend).not.toContainText('Parent:');

      // Caregiver changes Viewer Fran -> Caregiver and back -> Viewer
      const viewerRoleSelect = caregiverFamilySection.getByLabel(
        'Role for Viewer Fran',
      );
      await expect(viewerRoleSelect).toBeVisible();
      await expect(viewerRoleSelect).toHaveValue('viewer');
      const viewerSelectValues = await viewerRoleSelect
        .locator('option')
        .evaluateAll((opts) =>
          opts.map((o) => (o as HTMLOptionElement).value),
        );
      expect(viewerSelectValues).toEqual(['caregiver', 'viewer']);

      await viewerRoleSelect.selectOption('caregiver');
      await expect(viewerRoleSelect).toHaveValue('caregiver', {
        timeout: 10_000,
      });
      await viewerRoleSelect.selectOption('viewer');
      await expect(viewerRoleSelect).toHaveValue('viewer', {
        timeout: 10_000,
      });

      // --- Parent Family Settings & Promotion ---
      await openTab(parentPage, 'Family');
      await parentPage.reload();
      await openTab(parentPage, 'Family');

      const parentFamilySection = parentPage
        .locator('section')
        .filter({ hasText: 'Family & Caregivers' });
      await expect(
        parentFamilySection.getByText('Caregiver Eli'),
      ).toBeVisible();

      // Parent sees all 3 tiers in Invite <select> and Role Permissions legend
      const parentInviteValues = await parentFamilySection
        .getByLabel('Invite role')
        .locator('option')
        .evaluateAll((opts) =>
          opts.map((o) => (o as HTMLOptionElement).value),
        );
      expect(parentInviteValues).toEqual(['parent', 'caregiver', 'viewer']);

      const parentLegend = parentFamilySection.locator('ul').first();
      await expect(parentLegend).toContainText('Parent:');
      await expect(parentLegend).toContainText('Caregiver:');
      await expect(parentLegend).toContainText('Viewer:');

      // Promote Caregiver Eli -> Parent
      const caregiverRoleSelect = parentFamilySection.getByLabel(
        'Role for Caregiver Eli',
      );
      await expect(caregiverRoleSelect).toHaveValue('caregiver');
      await caregiverRoleSelect.selectOption('parent');
      await expect(caregiverRoleSelect).toHaveValue('parent', {
        timeout: 10_000,
      });

      // Former Caregiver syncs and now sees Pumping card & previously logged pumping event
      await syncNowViaSettings(caregiverPage);
      await openTab(caregiverPage, 'Dashboard');
      await expect(
        caregiverPage.getByRole('region', { name: 'Pumping' }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(caregiverPage.getByText('Pumping Today')).toBeVisible();

      await openTab(caregiverPage, 'Timeline');
      await expect(
        caregiverPage.getByRole('button', { name: 'Pumping', exact: true }),
      ).toBeVisible();
      await expect(
        caregiverPage.getByText('Live sync pump'),
      ).toBeVisible();

      // --- Parent demotes Caregiver Eli back to Caregiver ---
      await caregiverRoleSelect.selectOption('caregiver');
      await expect(caregiverRoleSelect).toHaveValue('caregiver', {
        timeout: 10_000,
      });

      // Demoted Caregiver syncs -> Pumping card & pumping event disappear (IDB purged)
      await syncNowViaSettings(caregiverPage);
      await openTab(caregiverPage, 'Dashboard');
      await expect(
        caregiverPage.getByRole('region', { name: 'Pumping' }),
      ).toHaveCount(0);
      await expect(caregiverPage.getByText('Pumping Today')).toHaveCount(0);

      await openTab(caregiverPage, 'Timeline');
      await expect(
        caregiverPage.getByRole('button', { name: 'Pumping', exact: true }),
      ).toHaveCount(0);
      await expect(caregiverPage.getByText('Live sync pump')).toHaveCount(0);
      await expect(caregiverPage.getByText('Live sync bottle')).toBeVisible();
    } finally {
      await ctxParent.close();
      await ctxCaregiver.close();
      await ctxViewer.close();
    }
  });

  test('JSON backup export, delete, re-upload restore round-trip, and idempotent re-upload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, {
      email: uniqueEmail('backup-parent'),
      displayName: 'Backup Parent',
      babyName: 'BackupBaby',
    });

    await logBottleViaUI(page, 135, 'Roundtrip bottle');
    await logPumpingViaUI(page, 85, 'Roundtrip pump');

    // Download JSON backup from Export page
    await openTab(page, 'Export');
    const dlPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON Backup' }).click();
    const download = await dlPromise;
    const backupJsonText = await readDownloadText(download);
    expect(backupJsonText).toContain('Roundtrip bottle');
    expect(backupJsonText).toContain('Roundtrip pump');

    // Delete the bottle event from Timeline
    await openTab(page, 'Timeline');
    await expect(page.getByText('Roundtrip bottle')).toBeVisible();
    await page.getByRole('button', { name: 'Delete Bottle Feed' }).click();
    await expect(page.getByText('Roundtrip bottle')).toHaveCount(0);
    await expect(page.getByText('Roundtrip pump')).toBeVisible();

    // Upload the JSON backup via "Restore from JSON Backup" card
    await openTab(page, 'Export');
    await expect(
      page.getByRole('heading', { name: 'Restore from JSON Backup' }),
    ).toBeVisible();

    const fileInput = page.getByLabel('Choose JSON Backup File');
    const backupFile = {
      name: 'backup-baby.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backupJsonText, 'utf-8'),
    };
    await fileInput.setInputFiles(backupFile);

    // Verify preview counts (2 total, 1 to import, 1 already present)
    await expect(
      page.getByText('Backup Preview: backup-baby.json'),
    ).toBeVisible();
    await expect(page.getByText(/Backup baby: BackupBaby/i)).toBeVisible();
    await expect(
      page.getByText('2 events in file · 1 to import · 1 already present'),
    ).toBeVisible();

    // Confirm import
    await page.getByRole('button', { name: 'Import 1 Events' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Imported 1 event(s) (1 skipped)',
    );

    // Verify restored bottle event reappears in Timeline
    await openTab(page, 'Timeline');
    await expect(page.getByText('Roundtrip bottle')).toBeVisible();
    await expect(page.getByText('135 ml').first()).toBeVisible();
    await expect(page.getByText('Roundtrip pump')).toBeVisible();

    // Re-upload the same JSON file -> verify idempotency (0 new events to import)
    await openTab(page, 'Export');
    await page.getByLabel('Choose JSON Backup File').setInputFiles(backupFile);
    await expect(
      page.getByText('2 events in file · 0 to import · 2 already present'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Import 0 Events' }),
    ).toBeDisabled();
  });
});
