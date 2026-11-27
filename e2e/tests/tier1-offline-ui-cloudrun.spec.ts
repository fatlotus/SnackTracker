import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  expectMinTapTarget,
  expectNoHorizontalOverflow,
  goOffline,
  goOnline,
  setupAuthenticatedBaby,
  spawnEphemeralServer,
  uniqueEmail,
} from '../helpers/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to allocate free port')));
      }
    });
  });
}

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

  await page.getByRole('button', { name: /diaper/i }).first().click();
  await page.getByRole('button', { name: labelMap[kind] }).first().click();
}

async function logBottleViaUI(page: Page, volumeMl: number): Promise<void> {
  await page
    .getByRole('region', { name: 'Bottle Feeding' })
    .getByRole('button', { name: /^Log$/i })
    .click();

  const volumeInput = page
    .getByLabel(/volume|amount|ml/i)
    .or(page.getByPlaceholder(/ml|volume|amount/i));

  await expect(volumeInput.first()).toBeVisible();
  await volumeInput.first().fill(String(volumeMl));
  await page.getByRole('button', { name: /save bottle/i }).click();
}

test.describe('F11: Offline-First PWA & Sync', () => {
  test('serves valid manifest.webmanifest and registers Service Worker', async ({
    page,
  }) => {
    await page.goto('/');

    const manifestRes = await page.request.get('/manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src: string; sizes: string }>;
    };
    expect(manifest.name || manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect((manifest.icons ?? []).length).toBeGreaterThan(0);

    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg && reg.active);
    });
    expect(swRegistered).toBe(true);
  });

  test('survives offline cold reload with cached app shell and IndexedDB state', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OfflineColdBaby' });

    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    await goOffline(page.context());
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        page.getByLabel('Select active baby').first(),
      ).toContainText('OfflineColdBaby', {
        timeout: 10_000,
      });
      await expect(
        page.getByRole('button', { name: /diaper|bottle|sleep|breast/i }).first(),
      ).toBeVisible();
    } finally {
      await goOnline(page.context());
    }
  });

  test('queues local writes in IndexedDB outbox while offline and persists across offline reload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'OutboxBaby' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    await goOffline(page.context());
    try {
      await logDiaperViaUI(page, 'wet');
      await logBottleViaUI(page, 85);

      await expect(page.getByText(/85\s*ml/i).first()).toBeVisible();
      await expect(page.getByText(/wet/i).first()).toBeVisible();

      // Reload while still offline and confirm local-first IndexedDB persistence
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/85\s*ml/i).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(/wet/i).first()).toBeVisible();
    } finally {
      await goOnline(page.context());
    }
  });

  test('automatically syncs queued outbox mutations upon reconnect', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'ReconnectBaby' });

    await goOffline(page.context());
    await logBottleViaUI(page, 150);
    await expect(page.getByText(/150\s*ml/i).first()).toBeVisible();

    await goOnline(page.context());
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/sync/pull?since_seq=0');
          if (!res.ok()) return false;
          const body = (await res.json()) as {
            events: Array<{ payload?: { volumeMl?: number } }>;
          };
          return body.events.some((e) => e.payload?.volumeMl === 150);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('performs incremental pull sync using since_seq cursor', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'CursorBaby' });

    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/sync/pull?since_seq=0');
          const data = (await res.json()) as {
            babies: unknown[];
            latestSeq: number;
          };
          return data.babies.length > 0 ? data.latestSeq : 0;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const pull1Res = await page.request.get('/api/sync/pull?since_seq=0');
    const pull1 = (await pull1Res.json()) as { latestSeq: number };
    const seq1 = pull1.latestSeq;

    await logDiaperViaUI(page, 'poopy');

    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/sync/pull?since_seq=${seq1}`);
          const data = (await res.json()) as {
            latestSeq: number;
            events: Array<{ type: string }>;
          };
          return data.latestSeq > seq1 && data.events.length > 0;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const pull2Res = await page.request.get(`/api/sync/pull?since_seq=${seq1}`);
    const pull2 = (await pull2Res.json()) as {
      babies: unknown[];
      events: Array<{ type: string }>;
      latestSeq: number;
    };
    expect(pull2.latestSeq).toBeGreaterThan(seq1);
    expect(pull2.babies.length).toBe(0);
    expect(pull2.events.some((e) => e.type === 'diaper')).toBe(true);
  });

  test('propagates soft-delete deletedAt tombstones and omits deleted items after reload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'TombstoneBaby' });
    await logBottleViaUI(page, 65);
    await page.getByRole('button', { name: /^Timeline$/i }).first().click();
    await expect(page.getByText(/65\s*ml/i).first()).toBeVisible();

    await page
      .getByRole('button', { name: /delete bottle feed/i })
      .first()
      .click();

    await expect(page.getByText(/65\s*ml/i)).toHaveCount(0);

    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/sync/pull?since_seq=0');
          const data = (await res.json()) as {
            events: Array<{
              payload?: { volumeMl?: number };
              deletedAt?: string | null;
            }>;
          };
          return data.events.some(
            (e) => e.payload?.volumeMl === 65 && Boolean(e.deletedAt),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByText(/65\s*ml/i)).toHaveCount(0);
  });
});

test.describe('F12: Mobile-First + Laptop UI', () => {
  test('renders mobile thumb-zone quick-log bar in bottom half of 390x844 viewport without overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'ThumbBaby' });

    await expectNoHorizontalOverflow(page);

    const thumbZoneControl = page
      .locator('nav[aria-label="Primary navigation"] button')
      .first();
    await expect(thumbZoneControl).toBeVisible();
    const box = await thumbZoneControl.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.y + box.height / 2).toBeGreaterThanOrEqual(422);
    }
  });

  test('enforces minimum 44x44px tap targets on mobile quick-log controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'TapTargetBaby' });

    const targets = [
      page.getByRole('button', { name: /start bottle/i }).first(),
      page.getByRole('button', { name: /start nap/i }).first(),
      page.getByRole('button', { name: /start left/i }).first(),
      page.getByRole('button', { name: /^wet$/i }).first(),
    ];

    for (const target of targets) {
      await expectMinTapTarget(target, 44);
    }
  });

  test('keeps sticky active-timer bar visible while scrolling on mobile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupAuthenticatedBaby(page, { babyName: 'StickyTimerBaby' });

    await page.getByRole('button', { name: /start nap/i }).first().click();

    const wakeUpBtn = page.getByRole('button', { name: /^Wake Up$/i }).first();
    await expect(wakeUpBtn).toBeVisible();

    await page.evaluate(() => window.scrollBy(0, 450));
    await expect(wakeUpBtn).toBeVisible();
    const box = await wakeUpBtn.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeLessThan(844);
    }
  });

  test('renders responsive multi-column dashboard on laptop 1280x800 viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupAuthenticatedBaby(page, { babyName: 'LaptopBaby' });

    await logBottleViaUI(page, 110);
    await logDiaperViaUI(page, 'wet');
    await expectNoHorizontalOverflow(page);

    const mainPanels = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return [];
      const candidates = Array.from(
        main.querySelectorAll('section, aside, [role="region"]'),
      );
      return candidates
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })
        .filter((r) => r.width > 150 && r.height > 100);
    });

    expect(mainPanels.length).toBeGreaterThanOrEqual(2);
    const distinctX = new Set(mainPanels.map((p) => Math.round(p.x / 50)));
    expect(distinctX.size).toBeGreaterThanOrEqual(2);
  });

  test('toggles dark mode and persists theme preference across reload', async ({
    page,
  }) => {
    await setupAuthenticatedBaby(page, { babyName: 'DarkBaby' });

    const themeToggle = page.getByRole('button', {
      name: /dark|light|theme/i,
    });
    await expect(themeToggle.first()).toBeVisible();

    const wasDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    await themeToggle.first().click();

    const isDarkAfterToggle = await page.evaluate(
      () =>
        document.documentElement.classList.contains('dark') ||
        document.documentElement.dataset.theme === 'dark',
    );
    expect(isDarkAfterToggle).toBe(!wasDark);

    await page.reload();
    const isDarkAfterReload = await page.evaluate(
      () =>
        document.documentElement.classList.contains('dark') ||
        document.documentElement.dataset.theme === 'dark',
    );
    expect(isDarkAfterReload).toBe(isDarkAfterToggle);
  });
});

test.describe('F13: Cloud Run Scale-to-Zero', () => {
  test('responds 200 on GET /healthz with storage backend metadata', async ({
    request,
  }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string; storage: string };
    expect(body.status).toBe('ok');
    expect(['sqlite', 'postgres']).toContain(body.storage);
  });

  test('serves production SPA HTML for / and /join/<code> fallback', async ({
    page,
    request,
  }) => {
    const rootRes = await request.get('/', {
      headers: { Accept: 'text/html' },
    });
    expect(rootRes.status()).toBe(200);
    expect(rootRes.headers()['content-type']).toContain('text/html');
    const rootHtml = await rootRes.text();
    expect(rootHtml.toLowerCase()).toContain('<!doctype html');

    const joinRes = await request.get('/join/TESTCODE123', {
      headers: { Accept: 'text/html' },
    });
    expect(joinRes.status()).toBe(200);
    expect(joinRes.headers()['content-type']).toContain('text/html');
    const joinHtml = await joinRes.text();
    expect(joinHtml.toLowerCase()).toContain('<!doctype html');

    await page.goto('/join/TESTCODE123');
    await expect(page.locator('#root')).toBeAttached();
  });

  test('preserves stateless signed session cookie across server restart', async () => {
    const port = await getFreePort();
    const server1 = await spawnEphemeralServer(port);
    const email = uniqueEmail('stateless');

    let setCookie = '';
    try {
      const regRes = await fetch(`${server1.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'StatelessPassword123!',
          displayName: 'Stateless Parent',
        }),
      });
      expect(regRes.status).toBe(201);
      const rawCookie = regRes.headers.get('set-cookie') ?? '';
      setCookie = rawCookie.split(';')[0];
      expect(setCookie.length).toBeGreaterThan(0);

      const me1 = await fetch(`${server1.baseUrl}/api/auth/me`, {
        headers: { Cookie: setCookie },
      });
      expect(me1.status).toBe(200);
    } finally {
      await server1.stop('SIGTERM');
    }

    const server2 = await spawnEphemeralServer(port, {
      dbPath: server1.dbPath,
    });
    try {
      const me2 = await fetch(`${server2.baseUrl}/api/auth/me`, {
        headers: { Cookie: setCookie },
      });
      expect(me2.status).toBe(200);
      const me2Json = (await me2.json()) as { user: { email: string } };
      expect(me2Json.user.email).toBe(email);
    } finally {
      await server2.stop('SIGTERM');
    }
  });

  test('shuts down gracefully on SIGTERM', async () => {
    const port = await getFreePort();
    const server = await spawnEphemeralServer(port);

    const healthRes = await fetch(`${server.baseUrl}/healthz`);
    expect(healthRes.status).toBe(200);

    const exitResult = await server.stop('SIGTERM');
    expect(
      exitResult.code === 0 || exitResult.signal === 'SIGTERM',
    ).toBe(true);
  });

  test('binds custom PORT env and satisfies cloudrun/service.yaml minScale: "0" contract', async () => {
    const port = await getFreePort();
    const server = await spawnEphemeralServer(port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop('SIGTERM');
    }

    const serviceYamlPath = path.join(REPO_ROOT, 'cloudrun', 'service.yaml');
    expect(fs.existsSync(serviceYamlPath)).toBe(true);
    const yamlContent = fs.readFileSync(serviceYamlPath, 'utf-8');
    expect(yamlContent).toMatch(/autoscaling\.knative\.dev\/minScale:\s*["']?0["']?/);
    expect(yamlContent).toMatch(/\/healthz/);
  });
});
