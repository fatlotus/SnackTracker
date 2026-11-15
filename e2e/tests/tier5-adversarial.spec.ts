import { expect, test, type Page } from '@playwright/test';
import {
  createBabyViaUI,
  goOffline,
  goOnline,
  loginUserViaUI,
  parseCsv,
  registerUserViaUI,
  setupAuthenticatedBaby,
  uniqueEmail,
} from '../helpers/app.js';

async function logBottleViaUI(
  page: Page,
  volumeMl: number,
  notes?: string,
): Promise<void> {
  await page.getByRole('button', { name: /log bottle/i }).first().click();
  const volumeInput = page
    .getByLabel(/volume|amount|ml/i)
    .or(page.getByPlaceholder(/ml|volume|amount/i))
    .first();
  await expect(volumeInput).toBeVisible();
  await volumeInput.fill(String(volumeMl));
  if (notes !== undefined) {
    const notesInput = page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i))
      .first();
    await notesInput.fill(notes);
  }
  await page.getByRole('button', { name: /save bottle/i }).click();
}

test.describe('Tier 5: Adversarial & Edge-Case E2E Suite', () => {
  test('T5-E2E-1: Active bottle_feed + breast_feed + sleep timers survive reload without NaN or negative duration', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'TripleTimerBaby' });

    await page.getByRole('button', { name: /start bottle/i }).first().click();
    await expect(
      page.getByRole('button', { name: /finish & enter volume/i }).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Finish$/i }).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /start nap/i }).first().click();
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.waitForTimeout(1200);
    await page.reload();

    await expect(
      page.getByRole('button', { name: /finish & enter volume/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: /^Finish$/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: /^Wake Up$/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/\bNaN\b/);
    expect(bodyText).not.toMatch(/\bundefined\b/i);
    expect(bodyText).not.toMatch(/-\d+\s*(?:m|s|h|min|sec|hr)/i);
  });

  test('T5-E2E-2: Rapid double-click on ActiveTimersBanner Switch / Pause maintains valid timer state and completes cleanly', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await setupAuthenticatedBaby(page, { babyName: 'RapidTimerBaby' });

    await page.getByRole('button', { name: /^Start Left$/i }).first().click();
    const finishBtn = page.getByRole('button', { name: /^Finish$/i }).first();
    await expect(finishBtn).toBeVisible({ timeout: 5_000 });

    const switchBtn = page
      .getByRole('button', { name: 'Switch breast side' })
      .or(page.getByRole('button', { name: /^Switch$/i }))
      .first();
    await switchBtn.dblclick();

    const pauseBtn = page.getByRole('button', { name: /^Pause$/i }).first();
    await pauseBtn.dblclick();

    const resumeBtn = page.getByRole('button', { name: /^Resume$/i }).first();
    if (await resumeBtn.isVisible().catch(() => false)) {
      await resumeBtn.click();
    }

    await page.waitForTimeout(400);
    await finishBtn.click();
    await expect(finishBtn).toHaveCount(0);

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByText(/breast/i).first()).toBeVisible();
    await expect(
      main.getByText(/\bNaN\b|-\d+\s*(?:m|s|h|min|sec|hr)/i),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('T5-E2E-3: End-to-end CSV formula injection neutralization via ExportPage download', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'FormulaInjectBaby' });

    const payloads = [
      "=CMD|' /C calc'!A0",
      '+1+1',
      '-2+3',
      '@SUM(1+1)',
    ];

    for (const payload of payloads) {
      await logBottleViaUI(page, 80, payload);
    }

    await page.getByRole('button', { name: /^Export$/i }).first().click();
    const csvBtn = page
      .getByRole('button', { name: /download events csv/i })
      .first();
    const downloadPromise = page.waitForEvent('download');
    await csvBtn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let csvContent = '';
    for await (const chunk of stream) {
      csvContent += chunk.toString('utf8');
    }

    const rows = parseCsv(csvContent.trim());
    expect(rows.length).toBe(1 + payloads.length);

    for (const payload of payloads) {
      const matchingCells = rows
        .slice(1)
        .flat()
        .filter((cell) => cell.includes(payload));
      expect(matchingCells.length).toBeGreaterThanOrEqual(1);
      for (const cell of matchingCells) {
        expect(['=', '+', '-', '@']).not.toContain(cell[0]);
      }
    }
  });

  test('T5-E2E-4: Shared-browser account switch isolates babies, events, and sync state between User A and User B', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, {
      displayName: 'Alice Owner',
      babyName: 'AliceSecretBaby',
    });

    await logBottleViaUI(page, 115, 'ALICE_PRIVATE_NOTE');
    await expect(page.getByText(/115\s*ml/i).first()).toBeVisible();

    // Sign out User A
    await page.getByRole('button', { name: /sign out/i }).first().click();
    const emailField = page
      .getByLabel(/email/i)
      .or(page.getByPlaceholder(/email/i));
    await expect(emailField.first()).toBeVisible({ timeout: 10_000 });

    // Register User B on the exact same browser context / page
    await registerUserViaUI(page, {
      email: uniqueEmail('t5-userb'),
      password: 'StrongPassword123!',
      displayName: 'Bob Parent',
    });

    await createBabyViaUI(page, {
      name: 'BobCleanBaby',
      dob: '2026-08-05',
    });

    await expect(page.getByLabel('Select active baby').first()).toContainText(
      'BobCleanBaby',
    );
    await expect(
      page.getByLabel('Select active baby').first(),
    ).not.toContainText('AliceSecretBaby');
    await expect(page.getByText(/115\s*ml/i)).toHaveCount(0);

    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(page.getByText('ALICE_PRIVATE_NOTE')).toHaveCount(0);

    const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
    expect(pullRes.status()).toBe(200);
    const pullJson = (await pullRes.json()) as {
      babies: Array<{ name: string }>;
      events: Array<{ notes?: string | null }>;
    };
    expect(pullJson.babies.some((b) => b.name === 'AliceSecretBaby')).toBe(
      false,
    );
    expect(
      pullJson.events.some((e) => e.notes === 'ALICE_PRIVATE_NOTE'),
    ).toBe(false);
  });

  test('T5-E2E-5: 401 session expiry during offline-to-online sync preserves local outbox and syncs after re-login', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('t5-401');
    const password = 'StrongPassword123!';
    await setupAuthenticatedBaby(page, {
      email,
      password,
      displayName: 'ExpiryParent',
      babyName: 'OutboxBaby',
    });

    await goOffline(context);
    await page.getByRole('button', { name: /^wet$/i }).first().click();
    await logBottleViaUI(page, 140, 'SURVIVED_401_OUTBOX');
    await expect(page.getByText(/140\s*ml/i).first()).toBeVisible();

    // Expire the session cookie while offline, then come back online
    await context.clearCookies();
    await goOnline(context);

    const syncBtn = page.getByRole('button', { name: /sync now/i }).first();
    if (await syncBtn.isVisible().catch(() => false)) {
      await syncBtn.click();
    }
    await page.waitForTimeout(800);

    // Local data must still be preserved in IndexedDB
    await expect(page.getByText(/140\s*ml/i).first()).toBeVisible();

    // Re-authenticate (via UI if redirected to login, or via API + reload)
    const emailField = page
      .getByLabel(/email/i)
      .or(page.getByPlaceholder(/email/i));
    if (await emailField.first().isVisible().catch(() => false)) {
      await loginUserViaUI(page, { email, password });
    } else {
      const loginRes = await page.request.post('/api/auth/login', {
        data: { email, password },
      });
      expect(loginRes.status()).toBe(200);
      await page.reload();
    }

    await expect(page.getByLabel('Select active baby').first()).toContainText(
      'OutboxBaby',
      { timeout: 10_000 },
    );

    const syncBtnAfter = page.getByRole('button', { name: /sync now/i }).first();
    if (await syncBtnAfter.isVisible().catch(() => false)) {
      await syncBtnAfter.click();
    }

    await expect
      .poll(
        async () => {
          const pullRes = await page.request.get('/api/sync/pull?since_seq=0');
          if (pullRes.status() !== 200) return false;
          const pullJson = (await pullRes.json()) as {
            events: Array<{ notes?: string | null }>;
          };
          return pullJson.events.some(
            (e) => e.notes === 'SURVIVED_401_OUTBOX',
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await expect(page.getByText(/140\s*ml/i).first()).toBeVisible();
  });
});
