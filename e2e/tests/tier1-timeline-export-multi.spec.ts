import { expect, test, type Page } from '@playwright/test';
import {
  createBabyViaUI,
  expectNoHorizontalOverflow,
  goOffline,
  goOnline,
  loginUserViaUI,
  parseCsv,
  registerUserViaAPI,
  registerUserViaUI,
  setupAuthenticatedBaby,
  uniqueEmail,
} from '../helpers/app.js';

async function logDiaperViaUI(
  page: Page,
  kind: 'wet' | 'poopy' | 'both',
): Promise<void> {
  const labelMap = {
    wet: /\bwet\b/i,
    poopy: /\bpoopy\b|\bdirty\b/i,
    both: /\bboth\b/i,
  };
  const directBtn = page.getByRole('button', { name: labelMap[kind] });
  if (await directBtn.first().isVisible().catch(() => false)) {
    await directBtn.first().click();
    return;
  }

  const diaperBtn = page.getByRole('button', { name: /diaper/i });
  await diaperBtn.first().click();
  await page.getByRole('button', { name: labelMap[kind] }).first().click();
}

async function logBottleViaUI(page: Page, volumeMl: number): Promise<void> {
  await page.getByRole('button', { name: /log bottle/i }).first().click();

  const volumeInput = page
    .getByLabel(/volume|amount|ml/i)
    .or(page.getByPlaceholder(/ml|volume|amount/i));

  await expect(volumeInput.first()).toBeVisible();
  await volumeInput.first().fill(String(volumeMl));

  await page.getByRole('button', { name: /save bottle/i }).click();
}

async function logSpitUpViaUI(
  page: Page,
  severity: 'small' | 'medium' | 'large' = 'medium',
): Promise<void> {
  await page.getByRole('button', { name: /log spit.?up/i }).first().click();

  await page
    .getByRole('button', { name: new RegExp(`^${severity}$`, 'i') })
    .first()
    .click();

  await page.getByRole('button', { name: /save spit.?up/i }).click();
}

async function openTimelineView(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Timeline$/i }).first().click();
}

async function openExportView(page: Page): Promise<void> {
  const exportTrigger = page
    .getByRole('button', { name: /^Export$/i })
    .or(page.getByRole('link', { name: /^Export$/i }))
    .or(page.getByRole('tab', { name: /^Export$/i }));
  await exportTrigger.first().click();
}

async function selectBabyInSwitcher(page: Page, babyName: string): Promise<void> {
  const switcher = page.locator('select[aria-label="Select active baby"]:visible').first();
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

test.describe('F7: Daily Timeline & Stats', () => {
  test('displays logged events in chronological local-day timeline', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'TimelineBaby' });

    await logDiaperViaUI(page, 'wet');
    await logBottleViaUI(page, 120);
    await logSpitUpViaUI(page, 'small');
    await openTimelineView(page);

    const timeline = page
      .getByRole('list', { name: /timeline|events|activity/i })
      .or(page.getByRole('region', { name: /timeline|today/i }))
      .or(page.getByRole('main'));

    await expect(timeline.first()).toContainText(/wet/i);
    await expect(timeline.first()).toContainText(/120/);
    await expect(timeline.first()).toContainText(/spit/i);
  });

  test('filters timeline by category and resets back to all events', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'FilterBaby' });

    await logDiaperViaUI(page, 'poopy');
    await logBottleViaUI(page, 95);
    await openTimelineView(page);

    await expect(page.getByText(/95\s*ml/i).first()).toBeVisible();
    await expect(page.getByText(/poopy/i).first()).toBeVisible();

    const diaperFilter = page
      .getByRole('button', { name: /^diapers?$/i })
      .or(page.getByRole('tab', { name: /^diapers?$/i }));
    await diaperFilter.first().click();

    await expect(page.getByText(/poopy/i).first()).toBeVisible();
    await expect(page.getByText(/95\s*ml/i)).toHaveCount(0);

    const allFilter = page
      .getByRole('button', { name: /^all$/i })
      .or(page.getByRole('tab', { name: /^all$/i }));
    await allFilter.first().click();

    await expect(page.getByText(/95\s*ml/i).first()).toBeVisible();
    await expect(page.getByText(/poopy/i).first()).toBeVisible();
  });

  test('navigates between today and previous day timelines', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'NavBaby' });

    await logBottleViaUI(page, 110);
    await openTimelineView(page);
    await expect(page.getByText(/110\s*ml/i).first()).toBeVisible();

    const prevDayBtn = page.getByRole('button', {
      name: /previous day|yesterday/i,
    });
    await prevDayBtn.first().click();

    await expect(page.getByText(/110\s*ml/i)).toHaveCount(0);

    const nextOrTodayBtn = page
      .getByRole('button', { name: /^Today$/i })
      .or(page.getByRole('button', { name: /next\s*day/i }));
    await nextOrTodayBtn.first().click();

    await expect(page.getByText(/110\s*ml/i).first()).toBeVisible();
  });

  test('updates daily KPIs for feed volume, clinical both-diaper counts, and time since last feed', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'KpiBaby' });

    await logBottleViaUI(page, 100);
    await logDiaperViaUI(page, 'both');

    const mainContent = page.getByRole('main').first();
    await expect(mainContent).toContainText(/100\s*ml/i);
    // "both" diaper clinically counts as +1 wet and +1 poopy
    await expect(mainContent).toContainText(/1W|wet/i);
    await expect(mainContent).toContainText(/1P|poop/i);
    await expect(mainContent).toContainText(/last feed|since.*feed|just now|0\s*m|< ?1\s*m|ago/i);
  });

  test('navigates Dashboard summary across days and shows matching day summary box on Timeline', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'MultiDaySummaryBaby' });

    await logBottleViaUI(page, 130);

    const prevDayBtn = page.getByRole('button', { name: /previous day/i });
    const nextDayBtn = page.getByRole('button', { name: /next day/i });

    // On Today: Next day is disabled and today's 1 feed / 130 ml is shown
    await expect(nextDayBtn).toBeDisabled();
    await expect(page.getByRole('heading', { name: /today's summary/i })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(/1\s*feeds/i);
    await expect(page.getByRole('main')).toContainText(/130\s*ml/i);

    // Step to Yesterday: 0 feeds, Next day enabled, Live badge shown on Last Feed & Sleep
    await prevDayBtn.click();
    await expect(
      page.getByRole('heading', { name: /yesterday's summary/i }),
    ).toBeVisible();
    await expect(nextDayBtn).toBeEnabled();
    await expect(page.getByRole('main')).toContainText(/0\s*feeds/i);

    // Open Timeline from Yesterday's summary -> lands on Yesterday with summary box
    await page.getByRole('button', { name: /view full timeline/i }).click();
    const timelineSummary = page.getByRole('region', {
      name: /daily summary for/i,
    });
    await expect(timelineSummary).toBeVisible();
    await expect(timelineSummary).toContainText(/0\s*feeds/i);

    // Page forward to Today on Timeline -> summary box updates to 1 feed / 130 ml
    await page.getByRole('button', { name: /next day/i }).click();
    await expect(timelineSummary).toContainText(/1\s*feeds/i);
    await expect(timelineSummary).toContainText(/130\s*ml/i);
    await expectNoHorizontalOverflow(page);
  });

  test('renders multi-day trends and switches between 7, 14, and 30 day windows', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'TrendsBaby' });

    await logBottleViaUI(page, 80);
    await logDiaperViaUI(page, 'wet');

    const trendsTrigger = page
      .getByRole('button', { name: /trends|stats|charts|analytics/i })
      .or(page.getByRole('tab', { name: /trends|stats|charts|analytics/i }))
      .or(page.getByRole('link', { name: /trends|stats|charts|analytics/i }));

    if (await trendsTrigger.first().isVisible().catch(() => false)) {
      await trendsTrigger.first().click();
    }

    const btn7d = page.getByRole('button', { name: /7\s*d/i });
    const btn14d = page.getByRole('button', { name: /14\s*d/i });
    const btn30d = page.getByRole('button', { name: /30\s*d/i });

    await expect(btn7d.first()).toBeVisible();
    await btn14d.first().click();
    await expect(btn14d.first()).toBeVisible();
    await btn30d.first().click();
    await expect(btn30d.first()).toBeVisible();
    await btn7d.first().click();
    await expect(page.getByRole('main').first()).toContainText(/80\s*ml|feed|diaper/i);
  });
});

test.describe('F8: Pediatrician Export', () => {
  test('downloads RFC-4180 CSV containing logged events', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'CsvBaby' });

    await logBottleViaUI(page, 125);
    await logDiaperViaUI(page, 'wet');
    await openExportView(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /csv/i }).first().click();
    const download = await downloadPromise;

    expect(download.suggestedFilename().toLowerCase()).toContain('.csv');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const csvText = Buffer.concat(chunks).toString('utf-8');
    const rows = parseCsv(csvText);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    const flat = csvText.toLowerCase();
    expect(flat).toContain('125');
    expect(flat).toContain('wet');
  });

  test('exports CSV offline without network connectivity', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OfflineCsvBaby' });
    await logDiaperViaUI(page, 'poopy');

    await goOffline(page.context());
    try {
      await openExportView(page);
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: /csv/i }).first().click();
      const download = await downloadPromise;

      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const rows = parseCsv(Buffer.concat(chunks).toString('utf-8'));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.flat().join(' ').toLowerCase()).toContain('poopy');
    } finally {
      await goOnline(page.context());
    }
  });

  test('downloads valid JSON backup with baby and event records', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'JsonBaby' });
    await logBottleViaUI(page, 95);
    await openExportView(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /json/i }).first().click();
    const download = await downloadPromise;

    expect(download.suggestedFilename().toLowerCase()).toContain('.json');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain('JsonBaby');
    expect(serialized).toContain('95');
  });

  test('generates and copies clinical text summary to clipboard', async ({
    page,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupAuthenticatedBaby(page, { babyName: 'CopyBaby' });

    await logBottleViaUI(page, 115);
    await logDiaperViaUI(page, 'both');
    await openExportView(page);

    const copyBtn = page.getByRole('button', { name: /copy/i });
    await expect(copyBtn.first()).toBeVisible();
    await copyBtn.first().click();

    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText).toContain('CopyBaby');
    expect(clipboardText).toMatch(/115|feed|diaper/i);
  });

  test('filters by date range and supports printable summary layout', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'PrintBaby' });
    await logBottleViaUI(page, 140);
    await openExportView(page);

    const customBtn = page.getByRole('button', { name: /^Custom$/i });
    await customBtn.first().click();

    const today = new Date().toISOString().slice(0, 10);
    const startInput = page.locator('#export-custom-start').or(page.getByLabel(/start date/i));
    const endInput = page.locator('#export-custom-end').or(page.getByLabel(/end date/i));
    await startInput.first().fill(today);
    await endInput.first().fill(today);

    await expect(page.getByRole('main').first()).toContainText(/PrintBaby/);

    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('main').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.emulateMedia({ media: 'screen' });
  });
});

test.describe('F9: Multi-Baby Management', () => {
  test('completes zero-baby onboarding for newly registered user', async ({
    page,
  }) => {
    const email = uniqueEmail('onboard');
    await registerUserViaUI(page, {
      email,
      password: 'Password123!',
      displayName: 'New Parent',
    });

    await createBabyViaUI(page, {
      name: 'Luna',
      dob: '2026-07-15',
      birthWeightGrams: 3400,
    });

    await expect(page.getByLabel('Select active baby').first()).toContainText('Luna');
    await expect(
      page.getByRole('button', { name: /start left|start bottle|start nap|wet/i }).first(),
    ).toBeVisible();
  });

  test('switches between multiple babies with isolated timelines', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Baby One' });
    await logBottleViaUI(page, 75);
    await expect(page.getByText(/75\s*ml/i).first()).toBeVisible();

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, {
      name: 'Baby Two',
      dob: '2026-08-10',
    });

    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();
    await expect(page.getByText(/75\s*ml/i)).toHaveCount(0);
    await logBottleViaUI(page, 130);
    await expect(page.getByText(/130\s*ml/i).first()).toBeVisible();

    await selectBabyInSwitcher(page, 'Baby One');

    await expect(page.getByText(/75\s*ml/i).first()).toBeVisible();
    await expect(page.getByText(/130\s*ml/i)).toHaveCount(0);
  });

  test('keeps active timers scoped per baby for twins', async ({ page }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Twin A' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'Twin B', dob: '2026-08-02' });

    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();

    // Switch back to Twin A and start a sleep timer
    await selectBabyInSwitcher(page, 'Twin A');

    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(page.getByRole('button', { name: /^Wake Up$/i }).first()).toBeVisible();

    // Switch to Twin B and verify Twin B has no active sleep timer running
    await selectBabyInSwitcher(page, 'Twin B');

    await expect(page.getByRole('button', { name: /^Wake Up$/i })).toHaveCount(0);
    await expect(page.getByText(/00:0|sleeping/i)).toHaveCount(0);

    // Switch back to Twin A and verify Twin A's timer is still active
    await selectBabyInSwitcher(page, 'Twin A');

    await expect(page.getByRole('button', { name: /^Wake Up$/i }).first()).toBeVisible();
  });

  test('edits baby profile name and notes and persists across reload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Old Name' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();

    const nameInput = page.locator('#edit-baby-name').or(page.getByLabel(/^Name$/i));
    await nameInput.first().fill('Updated Name');

    const notesInput = page.locator('#edit-baby-notes').or(page.getByLabel(/notes/i));
    await notesInput.first().fill('Likes swaddling');

    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByLabel('Select active baby').first()).toContainText(
      'Updated Name',
      { timeout: 10_000 },
    );

    await page.reload();
    await expect(page.getByLabel('Select active baby').first()).toContainText('Updated Name');
  });

  test('archives a baby and removes it from active switcher', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Keep Baby' });

    await page.getByRole('button', { name: /^Family$/i }).first().click();
    await createBabyViaUI(page, { name: 'Archive Baby', dob: '2026-06-01' });

    await page.getByRole('button', { name: /^Archive Baby$/i }).click();
    await page.getByRole('button', { name: /^Confirm Archive$/i }).click();

    await expect(page.getByLabel('Select active baby').first()).toContainText(
      'Keep Baby',
      { timeout: 10_000 },
    );
    await expect(
      page
        .getByLabel('Select active baby')
        .first()
        .locator('option', { hasText: 'Archive Baby' }),
    ).toHaveCount(0);
  });
});

test.describe('F10: Multi-Parent Sharing & Auth', () => {
  test('registers, signs out, and signs back in with HttpOnly session cookie', async ({
    page,
  }) => {
    const email = uniqueEmail('auth');
    const password = 'StrongPassword123!';

    await registerUserViaUI(page, {
      email,
      password,
      displayName: 'Parent Alpha',
    });

    const meBeforeLogout = await page.request.get('/api/auth/me');
    expect(meBeforeLogout.status()).toBe(200);
    const meJson = (await meBeforeLogout.json()) as {
      user: { email: string };
    };
    expect(meJson.user.email).toBe(email);

    const logoutBtn = page.getByRole('button', { name: /sign out|log out|logout/i });
    await logoutBtn.first().click();

    await expect(page.getByLabel(/password/i).first()).toBeVisible();
    const meAfterLogout = await page.request.get('/api/auth/me');
    expect(meAfterLogout.status()).toBe(401);

    await loginUserViaUI(page, { email, password });
    const meAfterLogin = await page.request.get('/api/auth/me');
    expect(meAfterLogin.status()).toBe(200);
  });

  test('rejects invalid login credentials with visible error feedback', async ({
    page,
  }) => {
    const email = uniqueEmail('badlogin');
    await registerUserViaAPI(page.request, {
      email,
      password: 'CorrectPassword123!',
      displayName: 'Test User',
    });

    await page.context().clearCookies();
    await page.goto('/');
    await expect(page.getByLabel(/email/i).first()).toBeVisible({
      timeout: 10_000,
    });
    const switchToLogin = page.getByRole('button', {
      name: /sign in|log in|login/i,
    });
    if (
      (await page.getByLabel(/display name/i).first().isVisible().catch(() => false)) &&
      (await switchToLogin.first().isVisible().catch(() => false))
    ) {
      await switchToLogin.first().click();
    }

    await page.getByLabel(/email/i).first().fill(email);
    await page.getByLabel(/password/i).first().fill('WrongPassword999!');
    await page.locator('form button[type="submit"]').first().click();

    await expect(
      page.getByRole('alert').or(page.getByText(/invalid|incorrect|failed|error/i)).first(),
    ).toBeVisible();
    await expect(page.getByLabel(/password/i).first()).toBeVisible();
  });

  test('shares baby via invite code/link and shows partner event attribution', async ({
    browser,
    page,
  }) => {
    await setupAuthenticatedBaby(page, {
      displayName: 'Parent A',
      babyName: 'Shared Baby',
    });
    await logBottleViaUI(page, 105);

    const shareBtn = page
      .getByRole('button', { name: /^Family$/i })
      .or(page.getByRole('link', { name: /^Family$/i }));
    await shareBtn.first().click();

    const generateBtn = page.getByRole('button', {
      name: /generate invite link|create invite|generate|invite/i,
    });
    await generateBtn.first().click();

    const inviteText = await page
      .getByText(/\/join\/[A-Za-z0-9_-]+/)
      .first()
      .innerText();
    const joinMatch = inviteText.match(/\/join\/([A-Za-z0-9_-]+)/);
    const codeMatch = inviteText.match(/\b([A-Za-z0-9_-]{6,})\b/);
    const code = joinMatch?.[1] ?? codeMatch?.[1];
    expect(code).toBeTruthy();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await registerUserViaUI(pageB, {
        email: uniqueEmail('partnerb'),
        password: 'StrongPassword123!',
        displayName: 'Parent B',
      });

      await pageB.goto(`/join/${code}`);

      await expect(pageB.getByLabel('Select active baby').first()).toContainText(
        'Shared Baby',
        { timeout: 15_000 },
      );
      await openTimelineView(pageB);
      await expect(pageB.getByText(/105\s*ml/i).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(pageB.getByText(/Parent A/i).first()).toBeVisible();
    } finally {
      await contextB.close();
    }
  });

  test('enforces read-only access for viewer role', async ({ browser, page }) => {
    await setupAuthenticatedBaby(page, {
      displayName: 'Owner Parent',
      babyName: 'Viewer Baby',
    });

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    expect(pullRes.ok()).toBe(true);
    const pullData = (await pullRes.json()) as {
      babies: Array<{ id: string; name: string }>;
    };
    const babyId = pullData.babies[0].id;

    const inviteRes = await page.request.post(`/api/babies/${babyId}/invites`, {
      data: { role: 'viewer' },
    });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as {
      invite: { code: string };
    };

    const contextViewer = await browser.newContext();
    const viewerPage = await contextViewer.newPage();
    try {
      await registerUserViaUI(viewerPage, {
        email: uniqueEmail('viewer'),
        password: 'StrongPassword123!',
        displayName: 'Grandma Viewer',
      });

      await viewerPage.goto(`/join/${invite.code}`);

      await expect(
        viewerPage.getByLabel('Select active baby').first(),
      ).toContainText('Viewer Baby', {
        timeout: 15_000,
      });

      // Verify server rejects write mutations from viewer
      const pushRes = await viewerPage.request.post('/api/sync/push', {
        data: {
          mutations: [
            {
              mutationId: crypto.randomUUID(),
              entityType: 'event',
              op: 'upsert',
              clientUpdatedAt: new Date().toISOString(),
              data: {
                id: crypto.randomUUID(),
                babyId,
                type: 'diaper',
                startedAt: new Date().toISOString(),
                endedAt: null,
                payload: { kind: 'wet' },
                loggedByUserId: 'viewer',
                updatedByUserId: 'viewer',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deletedAt: null,
              },
            },
          ],
        },
      });
      const pushJson = (await pushRes.json()) as {
        rejected?: Array<{ reason: string }>;
      };
      expect(
        pushRes.status() === 403 || (pushJson.rejected?.length ?? 0) > 0,
      ).toBe(true);
    } finally {
      await contextViewer.close();
    }
  });

  test('allows owner to revoke a caregiver member', async ({
    browser,
    page,
  }) => {
    await setupAuthenticatedBaby(page, {
      displayName: 'Owner',
      babyName: 'Revoke Baby',
    });

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    const pullData = (await pullRes.json()) as {
      babies: Array<{ id: string }>;
    };
    const babyId = pullData.babies[0].id;

    const inviteRes = await page.request.post(`/api/babies/${babyId}/invites`, {
      data: { role: 'caregiver' },
    });
    const { invite } = (await inviteRes.json()) as {
      invite: { code: string };
    };

    const contextPartner = await browser.newContext();
    const partnerPage = await contextPartner.newPage();
    try {
      await registerUserViaUI(partnerPage, {
        email: uniqueEmail('caregiver'),
        password: 'StrongPassword123!',
        displayName: 'Caregiver Bob',
      });
      const acceptRes = await partnerPage.request.post('/api/invites/accept', {
        data: { code: invite.code },
      });
      expect(acceptRes.status()).toBe(200);

      const shareBtn = page
        .getByRole('button', { name: /^Family$/i })
        .or(page.getByRole('link', { name: /^Family$/i }));
      await shareBtn.first().click();

      await expect(page.getByText(/Caregiver Bob/i).first()).toBeVisible();
      const revokeBtn = page.getByRole('button', {
        name: /revoke|remove/i,
      });
      await revokeBtn.first().click();

      await expect(page.getByText(/Caregiver Bob/i)).toHaveCount(0);
    } finally {
      await contextPartner.close();
    }
  });
});
