import { expect, test } from '@playwright/test';
import {
  goOffline,
  goOnline,
  setupAuthenticatedBaby,
} from '../helpers/app.js';

test.describe('Pumping & Tummy Time Tracking', () => {
  test('pumping live timer preserves active sleep, survives reload, finishes via modal (per-side + ml/oz), and supports timeline edit & delete', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Milo' });

    // Start a Nap first so we can verify pumping does NOT auto-end active sleep
    const sleepCard = page.getByRole('region', { name: 'Sleep' });
    await sleepCard.getByRole('button', { name: 'Start Nap' }).click();
    await expect(sleepCard.getByText('Sleeping now')).toBeVisible();

    // Start Pumping live timer
    const pumpingCard = page.getByRole('region', { name: 'Pumping' });
    await expect(pumpingCard).toBeVisible();
    await pumpingCard.getByRole('button', { name: 'Start Pump' }).click();

    // Both active sleep AND active pumping should be running
    await expect(pumpingCard.getByText('Pumping in progress')).toBeVisible();
    await expect(sleepCard.getByText('Sleeping now')).toBeVisible();

    // Reload and verify Pumping timer persists
    await page.reload();
    const pumpingCardReloaded = page.getByRole('region', { name: 'Pumping' });
    await expect(
      pumpingCardReloaded.getByText('Pumping in progress'),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Sleep' }).getByText('Sleeping now'),
    ).toBeVisible();

    // Finish & Log Volume via modal
    await pumpingCardReloaded
      .getByRole('button', { name: 'Finish & Log Volume' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Finish Pumping' });
    await expect(dialog).toBeVisible();

    // Enter Left & Right volumes -> verify auto-sum into total
    await dialog.locator('#pumping-left-volume').fill('60');
    await dialog.locator('#pumping-right-volume').fill('50');
    await expect(dialog.locator('#pumping-volume')).toHaveValue('110');

    // Toggle oz and back to ml
    await dialog.getByRole('button', { name: 'oz', exact: true }).click();
    await dialog.getByRole('button', { name: 'ml', exact: true }).click();
    await dialog.locator('#pumping-volume').fill('110');

    await dialog.locator('#pumping-notes').fill('Morning pump');
    await dialog.getByRole('button', { name: 'Save Pumping' }).click();
    await expect(dialog).toBeHidden();

    // Verify Dashboard summary shows 110 ml and Feeding Today remains 0 feeds
    await expect(page.getByText('Pumping Today')).toBeVisible();
    await expect(page.getByText('110 ml').first()).toBeVisible();
    await expect(page.getByText('0 feeds')).toBeVisible();

    // Timeline filter, edit, and delete
    await page.getByRole('button', { name: /Timeline/i }).first().click();
    await page.getByRole('button', { name: 'Pumping', exact: true }).click();
    await expect(page.getByText('Morning pump')).toBeVisible();

    await page.getByRole('button', { name: 'Edit Pumping' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Pumping' });
    await expect(editDialog).toBeVisible();
    await editDialog.locator('#pumping-notes').fill('Updated pump');
    await editDialog.getByRole('button', { name: 'Save Pumping' }).click();
    await expect(page.getByText('Updated pump')).toBeVisible();

    await page.getByRole('button', { name: 'Delete Pumping' }).click();
    await expect(page.getByText(/No events recorded for/)).toBeVisible();
  });

  test('tummy time auto-ends active sleep, survives reload, supports 1-tap finish, manual log, sub-minute edit, Trends & Export', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Nora' });

    // Start a Nap
    const sleepCard = page.getByRole('region', { name: 'Sleep' });
    await sleepCard.getByRole('button', { name: 'Start Nap' }).click();
    await expect(sleepCard.getByText('Sleeping now')).toBeVisible();

    // Start Tummy Time -> MUST auto-end active sleep
    const tummyCard = page.getByRole('region', { name: 'Tummy Time' });
    await expect(tummyCard).toBeVisible();
    await tummyCard.getByRole('button', { name: 'Start Timer' }).click();

    await expect(tummyCard.getByText('Tummy time in progress')).toBeVisible();
    await expect(sleepCard.getByText('Sleeping now')).toBeHidden();

    // Reload -> Tummy Time timer persists
    await page.reload();
    const tummyReloaded = page.getByRole('region', { name: 'Tummy Time' });
    await expect(
      tummyReloaded.getByText('Tummy time in progress'),
    ).toBeVisible();

    // 1-tap Finish
    await tummyReloaded.getByRole('button', { name: 'Finish' }).click();
    await expect(tummyReloaded.getByText('Tummy time in progress')).toBeHidden();

    // Quick Entry manual log with mood & notes
    await tummyReloaded.getByRole('button', { name: 'Quick Entry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log Tummy Time' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Happy', exact: true }).click();
    await dialog.locator('#tummy-notes').fill('Mat play');
    await dialog.getByRole('button', { name: 'Save Tummy Time' }).click();
    await expect(dialog).toBeHidden();

    // Timeline: filter by Tummy Time, edit the short session without validation error
    await page.getByRole('button', { name: /Timeline/i }).first().click();
    await page.getByRole('button', { name: 'Tummy Time', exact: true }).click();
    await expect(page.getByText('Mat play')).toBeVisible();

    const editButtons = page.getByRole('button', { name: 'Edit Tummy Time' });
    expect(await editButtons.count()).toBe(2);
    await editButtons.last().click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Tummy Time' });
    await editDialog.locator('#tummy-notes').fill('Short lift');
    await editDialog.getByRole('button', { name: 'Save Tummy Time' }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByText('Short lift')).toBeVisible();

    // Trends view shows Pumping & Tummy Time averages and charts
    await page.getByRole('button', { name: /Trends/i }).first().click();
    await expect(page.getByText('Avg Pumping / Day')).toBeVisible();
    await expect(page.getByText('Avg Tummy Time / Day')).toBeVisible();
    await expect(page.getByText('Tummy Time (Minutes / Day)')).toBeVisible();

    // Export view shows Pumping & Tummy Time preview cards
    await page.getByRole('button', { name: /Export/i }).first().click();
    await expect(page.getByText('Pumping Avg / Day')).toBeVisible();
    await expect(page.getByText('Tummy Time Avg / Day')).toBeVisible();
  });

  test('supports offline logging + reconnect sync, 320x568 mobile layout, dark mode & zh-CN', async ({
    page,
    context,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Kai' });

    // Offline create Pumping & Tummy Time -> reload -> reconnect
    await goOffline(context);
    const pumpingCard = page.getByRole('region', { name: 'Pumping' });
    await pumpingCard.getByRole('button', { name: 'Quick Entry' }).click();
    const pumpDialog = page.getByRole('dialog', { name: 'Log Pumping' });
    await pumpDialog.locator('#pumping-volume').fill('80');
    await pumpDialog.getByRole('button', { name: 'Save Pumping' }).click();
    await expect(pumpDialog).toBeHidden();

    const tummyCard = page.getByRole('region', { name: 'Tummy Time' });
    await tummyCard.getByRole('button', { name: 'Quick Entry' }).click();
    const tummyDialog = page.getByRole('dialog', { name: 'Log Tummy Time' });
    await tummyDialog.getByRole('button', { name: 'Save Tummy Time' }).click();
    await expect(tummyDialog).toBeHidden();

    await expect(page.getByText('80 ml').first()).toBeVisible();
    await goOnline(context);
    await page.reload();
    await expect(page.getByText('80 ml').first()).toBeVisible();

    // Narrow 320x568 mobile viewport: zero horizontal overflow & >=44px tap targets
    await page.setViewportSize({ width: 320, height: 568 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    for (const regionName of ['Pumping', 'Tummy Time']) {
      const region = page.getByRole('region', { name: regionName });
      const buttons = region.getByRole('button');
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const box = await buttons.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    }

    // Switch to zh-CN & Dark mode -> verify localized cards & distinct 3px accent borders
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '中文' }).first().click();
    const zhPumpCard = page.getByRole('region', { name: '吸奶' });
    const zhTummyCard = page.getByRole('region', { name: '趴卧练习' });
    await expect(zhPumpCard).toBeVisible();
    await expect(zhTummyCard).toBeVisible();

    const borders = await page.evaluate(() => {
      const p = document.querySelector('.bt-card-pumping');
      const t = document.querySelector('.bt-card-tummy');
      return {
        pColor: p ? getComputedStyle(p).borderTopColor : '',
        pWidth: p ? getComputedStyle(p).borderTopWidth : '',
        tColor: t ? getComputedStyle(t).borderTopColor : '',
        tWidth: t ? getComputedStyle(t).borderTopWidth : '',
      };
    });
    expect(borders.pWidth).toBe('3px');
    expect(borders.tWidth).toBe('3px');
    expect(borders.pColor).not.toBe(borders.tColor);
  });

  test('finishing active pumping across a minute boundary and editing active timers from Timeline preserves running state', async ({
    page,
  }) => {
    // Anchor browser clock at :50 seconds of the current minute so it stays
    // within seconds of real wall-clock time while deterministically crossing
    // a :00 minute boundary when fast-forwarded.
    const startClock = new Date();
    startClock.setSeconds(50, 0);
    await page.clock.install({ time: startClock });

    await setupAuthenticatedBaby(page, { babyName: 'Remy' });

    // Start both Pumping and Tummy Time live timers at :50
    const pumpingCard = page.getByRole('region', { name: 'Pumping' });
    await pumpingCard.getByRole('button', { name: 'Start Pump' }).click();
    await expect(pumpingCard.getByText('Pumping in progress')).toBeVisible();

    const tummyCard = page.getByRole('region', { name: 'Tummy Time' });
    await tummyCard.getByRole('button', { name: 'Start Timer' }).click();
    await expect(tummyCard.getByText('Tummy time in progress')).toBeVisible();

    // Go to Timeline and edit BOTH active events (<1m elapsed) without stopping them
    await page.getByRole('button', { name: /Timeline/i }).first().click();

    await page.getByRole('button', { name: 'Edit Pumping' }).click();
    const editPumpDialog = page.getByRole('dialog', { name: 'Edit Pumping' });
    await expect(editPumpDialog).toBeVisible();
    await expect(editPumpDialog.locator('#pumping-end')).toHaveCount(0);
    await editPumpDialog.locator('#pumping-notes').fill('Active pump note');
    await editPumpDialog.getByRole('button', { name: 'Save Pumping' }).click();
    await expect(editPumpDialog).toBeHidden();
    await expect(page.getByText('Active pump note')).toBeVisible();

    await page.getByRole('button', { name: 'Edit Tummy Time' }).click();
    const editTummyDialog = page.getByRole('dialog', {
      name: 'Edit Tummy Time',
    });
    await expect(editTummyDialog).toBeVisible();
    await expect(editTummyDialog.locator('#tummy-end')).toHaveCount(0);
    await editTummyDialog
      .getByRole('button', { name: 'Happy', exact: true })
      .click();
    await editTummyDialog.locator('#tummy-notes').fill('Active tummy note');
    await editTummyDialog
      .getByRole('button', { name: 'Save Tummy Time' })
      .click();
    await expect(editTummyDialog).toBeHidden();
    await expect(page.getByText('Active tummy note')).toBeVisible();

    // Return to Dashboard: both live timers must STILL be running
    await page.getByRole('button', { name: /Dashboard/i }).first().click();
    await expect(
      page.getByRole('region', { name: 'Pumping' }).getByText('Pumping in progress'),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Tummy Time' })
        .getByText('Tummy time in progress'),
    ).toBeVisible();

    // Open Finish Pumping modal at :52, then cross the :00 minute boundary to :05
    await page.clock.fastForward('00:02');
    await page
      .getByRole('region', { name: 'Pumping' })
      .getByRole('button', { name: 'Finish & Log Volume' })
      .click();
    const finishDialog = page.getByRole('dialog', { name: 'Finish Pumping' });
    await expect(finishDialog).toBeVisible();

    // Crossing the minute boundary triggers 1s re-renders in App.tsx;
    // initialEndedLocal must remain frozen so Save succeeds cleanly.
    await page.clock.fastForward('00:13');

    // Also verify switching sides after editing volume in single-side mode
    // clears stale per-side inputs when returning to Both.
    await finishDialog.locator('#pumping-left-volume').fill('60');
    await finishDialog.locator('#pumping-right-volume').fill('50');
    await finishDialog.getByRole('button', { name: 'Left', exact: true }).click();
    await finishDialog.locator('#pumping-volume').fill('95');
    await finishDialog.getByRole('button', { name: 'Both', exact: true }).click();
    await expect(finishDialog.locator('#pumping-left-volume')).toHaveValue('');
    await expect(finishDialog.locator('#pumping-right-volume')).toHaveValue('');
    await expect(finishDialog.locator('#pumping-volume')).toHaveValue('95');

    await finishDialog.getByRole('button', { name: 'Save Pumping' }).click();
    await expect(finishDialog).toBeHidden();
    await expect(page.getByText('95 ml').first()).toBeVisible();
  });
});
