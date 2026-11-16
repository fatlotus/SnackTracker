import { expect, test } from '@playwright/test';
import { setupAuthenticatedBaby } from '../helpers/app.js';

test.describe('Daily Vitamin Tracking (M1)', () => {
  test('toggles Daily Vitamins Yes -> persists across reload -> reflected in Timeline -> toggles No', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'Sunny' });

    const vitaminCard = page.getByRole('region', { name: 'Daily Vitamins' });
    await expect(vitaminCard).toBeVisible();
    await expect(vitaminCard.getByText('Not given yet today')).toBeVisible();

    const yesBtn = vitaminCard.getByRole('button', { name: 'Yes' });
    const noBtn = vitaminCard.getByRole('button', { name: 'No' });

    await expect(noBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(yesBtn).toHaveAttribute('aria-pressed', 'false');

    // Tap Yes
    await yesBtn.click();
    await expect(yesBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(noBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(vitaminCard.getByText(/Given today ·/)).toBeVisible();

    // Persists across reload
    await page.reload();
    const vitaminCardAfterReload = page.getByRole('region', {
      name: 'Daily Vitamins',
    });
    await expect(
      vitaminCardAfterReload.getByRole('button', { name: 'Yes' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      vitaminCardAfterReload.getByText(/Given today ·/),
    ).toBeVisible();

    // Reflected in Timeline + Vitamins filter pill
    await page.getByRole('button', { name: /Timeline/i }).first().click();
    const vitaminsFilter = page.getByRole('button', {
      name: 'Vitamins',
      exact: true,
    });
    await expect(vitaminsFilter).toBeVisible();
    await vitaminsFilter.click();
    await expect(page.getByText('Daily Vitamins')).toBeVisible();
    await expect(page.getByText('Given', { exact: true })).toBeVisible();

    // Switch back to Dashboard and toggle No
    await page.getByRole('button', { name: /Dashboard/i }).first().click();
    const vitaminCardBack = page.getByRole('region', {
      name: 'Daily Vitamins',
    });
    await vitaminCardBack.getByRole('button', { name: 'No' }).click();
    await expect(
      vitaminCardBack.getByRole('button', { name: 'No' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      vitaminCardBack.getByText('Not given yet today'),
    ).toBeVisible();

    // Verify removed from Timeline
    await page.getByRole('button', { name: /Timeline/i }).first().click();
    await page.getByRole('button', { name: 'Vitamins', exact: true }).click();
    await expect(page.getByText(/No events recorded for/)).toBeVisible();
  });
});
