import { expect, test } from '@playwright/test';
import {
  goOffline,
  goOnline,
  setupAuthenticatedBaby,
} from '../helpers/app.js';

const LOCALE_STORAGE_KEY = 'baby-tracker-locale';

test.describe('Tier 6: i18n (en-US / zh-CN) & Distinctive Modern Styling', () => {
  test('switches language cleanly on Auth screen between en-US and zh-CN', async ({
    page,
  }) => {
    await page.goto('/');

    const switcher = page.getByTestId('language-switcher');
    await expect(switcher).toBeVisible();

    // Default English UI on Auth screen
    await expect(page.getByRole('tab', { name: 'Sign In' })).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Create Account' }),
    ).toBeVisible();
    await expect(
      page.evaluate(() => document.documentElement.lang),
    ).resolves.toBe('en-US');

    // Switch to zh-CN
    await switcher.getByRole('button', { name: '中文' }).click();
    await expect(page.getByRole('tab', { name: '登录' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '注册账号' })).toBeVisible();
    await expect(
      page.evaluate(() => document.documentElement.lang),
    ).resolves.toBe('zh-CN');
    await expect(
      page.evaluate((key) => window.localStorage.getItem(key), LOCALE_STORAGE_KEY),
    ).resolves.toBe('zh-CN');

    // Switch back to en-US
    await switcher.getByRole('button', { name: 'EN' }).click();
    await expect(page.getByRole('tab', { name: 'Sign In' })).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Create Account' }),
    ).toBeVisible();
    await expect(
      page.evaluate(() => document.documentElement.lang),
    ).resolves.toBe('en-US');
  });

  test('persists zh-CN across online & offline reloads and renders Chinese UI across all views', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'I18nBaby' });

    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });

    // Switch to zh-CN in main app
    const mainSwitcher = page.getByTestId('language-switcher');
    await expect(mainSwitcher).toBeVisible();
    await mainSwitcher.getByRole('button', { name: '中文' }).click();

    await expect(
      page.evaluate(() => document.documentElement.lang),
    ).resolves.toBe('zh-CN');
    await expect(
      page.evaluate((key) => window.localStorage.getItem(key), LOCALE_STORAGE_KEY),
    ).resolves.toBe('zh-CN');

    // Online reload persistence
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.evaluate(() => document.documentElement.lang),
    ).resolves.toBe('zh-CN');
    await expect(page.getByText('母乳喂养')).toBeVisible();

    // Offline reload persistence
    await goOffline(page.context());
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        page.evaluate(() => document.documentElement.lang),
      ).resolves.toBe('zh-CN');
      await expect(
        page.evaluate(
          (key) => window.localStorage.getItem(key),
          LOCALE_STORAGE_KEY,
        ),
      ).resolves.toBe('zh-CN');

      // Dashboard cards & summary in Chinese
      await expect(page.getByRole('heading', { name: '母乳喂养' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '奶瓶喂养' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '睡眠' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '一键记尿布' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '吐奶' })).toBeVisible();
      await expect(page.getByText(/今日汇总/)).toBeVisible();

      // Tracking modal in Chinese
      await page
        .getByRole('region', { name: '奶瓶喂养' })
        .getByRole('button', { name: '记录' })
        .click();
      await expect(
        page.getByRole('heading', { name: '记录奶瓶喂养' }),
      ).toBeVisible();
      await expect(page.getByText(/奶量/)).toBeVisible();
      await page.getByRole('button', { name: '关闭弹窗' }).click();

      // Timeline in Chinese
      await page.getByRole('button', { name: '时间线' }).first().click();
      await expect(page.getByRole('button', { name: '全部' })).toBeVisible();
      await expect(page.getByRole('button', { name: '喂养' })).toBeVisible();

      // Trends in Chinese
      await page.getByRole('button', { name: '趋势' }).first().click();
      await expect(
        page.getByRole('heading', { name: '多日趋势分析' }),
      ).toBeVisible();
      await expect(page.getByText('日均睡眠')).toBeVisible();

      // Export in Chinese
      await page.getByRole('button', { name: '导出' }).first().click();
      await expect(
        page.getByRole('heading', { name: '儿科就诊报告导出与备份' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: '导出明细 CSV' }),
      ).toBeVisible();

      // Settings/Share in Chinese + settings-language-switcher back to en-US
      await page.getByRole('button', { name: '家庭' }).first().click();
      await expect(
        page.getByRole('heading', { name: '偏好设置与账号' }),
      ).toBeVisible();
      const settingsSwitcher = page.getByTestId('settings-language-switcher');
      await expect(settingsSwitcher).toBeVisible();
      await settingsSwitcher.getByRole('button', { name: 'EN' }).click();

      await expect(
        page.evaluate(() => document.documentElement.lang),
      ).resolves.toBe('en-US');
      await expect(
        page.getByRole('heading', { name: 'Preferences & Account' }),
      ).toBeVisible();
    } finally {
      await goOnline(page.context());
    }
  });

  test('applies CSS custom properties and distinct .bt-card-* category accents in light and dark modes', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'StyleBaby' });

    const cssVars = [
      '--accent-breast',
      '--accent-bottle',
      '--accent-sleep',
      '--accent-diaper',
      '--accent-spitup',
      '--surface-bg',
    ];

    const readThemeTokens = async () =>
      page.evaluate((vars) => {
        const root = document.documentElement;
        const rootStyle = getComputedStyle(root);
        const tokens: Record<string, string> = {};
        for (const v of vars) {
          tokens[v] = rootStyle.getPropertyValue(v).trim();
        }
        const cardClasses = [
          '.bt-card-breast',
          '.bt-card-bottle',
          '.bt-card-sleep',
          '.bt-card-diaper',
          '.bt-card-spitup',
        ];
        const cardBorders: Record<string, { width: string; color: string }> = {};
        for (const cls of cardClasses) {
          const el = document.querySelector(cls);
          if (el) {
            const st = getComputedStyle(el);
            cardBorders[cls] = {
              width: st.borderTopWidth,
              color: st.borderTopColor,
            };
          }
        }
        return {
          isDark: root.classList.contains('dark'),
          tokens,
          cardBorders,
        };
      }, cssVars);

    // Ensure we start in light mode
    const themeToggle = page.getByRole('button', { name: /Theme:/i }).first();
    for (let i = 0; i < 3; i += 1) {
      const dark = await page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      );
      if (!dark) break;
      await themeToggle.click();
    }

    const light = await readThemeTokens();
    expect(light.isDark).toBe(false);
    for (const v of cssVars) {
      expect(light.tokens[v], `Light mode ${v} should be non-empty`).not.toBe(
        '',
      );
    }

    const lightColors = Object.values(light.cardBorders).map((b) => b.color);
    expect(Object.keys(light.cardBorders)).toHaveLength(5);
    for (const [cls, border] of Object.entries(light.cardBorders)) {
      expect(border.width, `${cls} border-top-width in light mode`).toBe('3px');
    }
    expect(new Set(lightColors).size).toBe(5);

    // Switch to dark mode
    for (let i = 0; i < 3; i += 1) {
      const dark = await page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      );
      if (dark) break;
      await themeToggle.click();
    }

    const dark = await readThemeTokens();
    expect(dark.isDark).toBe(true);
    for (const v of cssVars) {
      expect(dark.tokens[v], `Dark mode ${v} should be non-empty`).not.toBe(
        '',
      );
    }
    expect(dark.tokens['--surface-bg']).not.toBe(light.tokens['--surface-bg']);
    expect(dark.tokens['--accent-breast']).not.toBe(
      light.tokens['--accent-breast'],
    );

    const darkColors = Object.values(dark.cardBorders).map((b) => b.color);
    expect(Object.keys(dark.cardBorders)).toHaveLength(5);
    for (const [cls, border] of Object.entries(dark.cardBorders)) {
      expect(border.width, `${cls} border-top-width in dark mode`).toBe('3px');
    }
    expect(new Set(darkColors).size).toBe(5);
  });

  test('renders unified dashboard card headers, idle actions, and modal submit labels', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'UniformBaby' });

    // Every modal-backed live/1-tap card has a uniform top-right "Log" header button
    for (const regionName of [
      'Breastfeeding',
      'Bottle Feeding',
      'Sleep',
      '1-Tap Diaper Log',
      'Pumping',
      'Tummy Time',
    ]) {
      const card = page.getByRole('region', { name: regionName });
      await expect(
        card.getByRole('button', { name: 'Log', exact: true }),
      ).toHaveCount(1);
    }

    // No redundant Quick Entry buttons remain anywhere on the dashboard
    await expect(
      page.getByRole('button', { name: /quick entry/i }),
    ).toHaveCount(0);

    // Consistent Start <Activity> / Start <X> verbs across timer cards
    await expect(
      page
        .getByRole('region', { name: 'Bottle Feeding' })
        .getByRole('button', { name: 'Start Bottle', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Pumping' })
        .getByRole('button', { name: 'Start Pump', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Tummy Time' })
        .getByRole('button', { name: 'Start Tummy Time', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Sleep' })
        .getByRole('button', { name: 'Start Nap', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Sleep' })
        .getByRole('button', { name: 'Start Night', exact: true }),
    ).toBeVisible();

    // Spit-Up card has clean "Log Spit-Up" button (no literal "+ " prefix) and no header Log button
    const spitUpCard = page.getByRole('region', { name: 'Spit-Up' });
    await expect(
      spitUpCard.getByRole('button', { name: 'Log', exact: true }),
    ).toHaveCount(0);
    await expect(
      spitUpCard.getByRole('button', { name: 'Log Spit-Up', exact: true }),
    ).toBeVisible();

    // BreastFeedModal submit button aligns with Save <Entity> naming
    await page
      .getByRole('region', { name: 'Breastfeeding' })
      .getByRole('button', { name: 'Log', exact: true })
      .click();
    const breastDialog = page.getByRole('dialog', { name: 'Log Breastfeed' });
    await expect(
      breastDialog.getByRole('button', { name: 'Save Breastfeed', exact: true }),
    ).toBeVisible();
    await breastDialog.getByRole('button', { name: 'Cancel' }).click();
  });
});

