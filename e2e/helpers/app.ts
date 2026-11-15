import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

export interface RegisterUserOptions {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginUserOptions {
  email: string;
  password: string;
}

export interface CreateBabyOptions {
  name: string;
  dob: string;
  birthWeightGrams?: number;
  avatarColor?: string;
  notes?: string;
}

export interface SetupAuthenticatedBabyOptions {
  email?: string;
  password?: string;
  displayName?: string;
  babyName?: string;
  dob?: string;
  birthWeightGrams?: number;
  avatarColor?: string;
  notes?: string;
}

export interface EphemeralServerHandle {
  port: number;
  baseUrl: string;
  dbPath: string;
  process: ChildProcess;
  stop: (
    signal?: NodeJS.Signals,
  ) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Generates a unique email address for isolated test runs.
 */
export function uniqueEmail(prefix = 'parent'): string {
  const sanitized = prefix.replace(/[^a-zA-Z0-9._-]/g, '-');
  const id = crypto.randomUUID().slice(0, 8);
  return `${sanitized}+${Date.now()}-${id}@example.com`;
}

/**
 * Registers a new user through the HTTP API (`POST /api/auth/register`).
 * When called with `page.request`, the resulting session cookie is stored in `page`'s BrowserContext.
 */
export async function registerUserViaAPI(
  request: APIRequestContext,
  opts: RegisterUserOptions,
): Promise<{ user: Record<string, unknown> }> {
  const response = await request.post('/api/auth/register', {
    data: {
      email: opts.email,
      password: opts.password,
      displayName: opts.displayName,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { user: Record<string, unknown> };
}

/**
 * Registers a new user through the browser UI.
 */
export async function registerUserViaUI(
  page: Page,
  opts: RegisterUserOptions,
): Promise<void> {
  await page.goto('/');

  const emailField = page
    .getByLabel(/email/i)
    .or(page.getByPlaceholder(/email/i));
  await expect(emailField.first()).toBeVisible({ timeout: 10_000 });

  // Switch to registration view if a login form is shown first.
  const switchToRegister = page
    .getByRole('tab', { name: /create account|sign up|register/i })
    .or(page.getByRole('button', { name: /create account|sign up|register/i }))
    .or(page.getByRole('link', { name: /create account|sign up|register/i }));

  const displayNameField = page
    .getByLabel(/display name|name/i)
    .or(page.getByPlaceholder(/display name|your name/i));

  if (!(await displayNameField.first().isVisible().catch(() => false))) {
    if (await switchToRegister.first().isVisible().catch(() => false)) {
      await switchToRegister.first().click();
    }
  }

  await expect(displayNameField.first()).toBeVisible({ timeout: 5_000 });
  await displayNameField.first().fill(opts.displayName);

  await emailField.first().fill(opts.email);

  const passwordField = page
    .getByLabel(/^password$/i)
    .or(page.getByLabel(/password/i))
    .or(page.getByPlaceholder(/password/i));
  await passwordField.first().fill(opts.password);

  const submitButton = page.locator('form button[type="submit"]');
  await submitButton.first().click();

  // Wait until the auth form is replaced by authenticated app content.
  await expect(
    page
      .getByRole('main')
      .or(page.getByRole('heading'))
      .first(),
  ).toBeVisible();
  await expect(passwordField.first()).toBeHidden({ timeout: 10_000 });
}

/**
 * Signs in an existing user through the browser UI.
 */
export async function loginUserViaUI(
  page: Page,
  opts: LoginUserOptions,
): Promise<void> {
  await page.goto('/');

  const emailField = page
    .getByLabel(/email/i)
    .or(page.getByPlaceholder(/email/i));
  await expect(emailField.first()).toBeVisible({ timeout: 10_000 });

  const switchToLogin = page
    .getByRole('tab', { name: /sign in|log in|login/i })
    .or(page.getByRole('button', { name: /sign in|log in|login/i }))
    .or(page.getByRole('link', { name: /sign in|log in|login/i }));

  const displayNameField = page
    .getByLabel(/display name|your name/i)
    .or(page.getByPlaceholder(/display name/i));

  if (await displayNameField.first().isVisible().catch(() => false)) {
    if (await switchToLogin.first().isVisible().catch(() => false)) {
      await switchToLogin.first().click();
    }
  }

  await expect(displayNameField.first()).toBeHidden({ timeout: 5_000 });
  await emailField.first().fill(opts.email);

  const passwordField = page
    .getByLabel(/password/i)
    .or(page.getByPlaceholder(/password/i));
  await passwordField.first().fill(opts.password);

  const submitButton = page.locator('form button[type="submit"]');
  await submitButton.first().click();

  await expect(passwordField.first()).toBeHidden({ timeout: 10_000 });
}

/**
 * Creates a baby profile through the browser UI (onboarding or add-baby flow).
 */
export async function createBabyViaUI(
  page: Page,
  opts: CreateBabyOptions,
): Promise<void> {
  const nameField = page
    .getByLabel(/baby'?s? name/i)
    .or(page.getByPlaceholder(/baby'?s? name/i));

  if (!(await nameField.first().isVisible().catch(() => false))) {
    const addBabyButton = page.getByRole('button', {
      name: /add (?:a |new |first |another )?baby/i,
    });
    await addBabyButton.first().click();
  }

  await expect(nameField.first()).toBeVisible();
  await nameField.first().fill(opts.name);

  const dobField = page
    .getByLabel(/date of birth|birth ?date|dob/i)
    .or(page.getByPlaceholder(/yyyy-mm-dd|date of birth|dob/i));
  await dobField.first().fill(opts.dob);

  if (opts.birthWeightGrams !== undefined) {
    const weightField = page
      .getByLabel(/birth weight|weight/i)
      .or(page.getByPlaceholder(/grams|weight/i));
    if (await weightField.first().isVisible().catch(() => false)) {
      await weightField.first().fill(String(opts.birthWeightGrams));
    }
  }

  if (opts.avatarColor !== undefined) {
    const colorButton = page.getByRole('button', {
      name: new RegExp(opts.avatarColor, 'i'),
    });
    if (await colorButton.first().isVisible().catch(() => false)) {
      await colorButton.first().click();
    } else {
      const colorInput = page.getByLabel(/color|avatar/i);
      if (await colorInput.first().isVisible().catch(() => false)) {
        await colorInput.first().fill(opts.avatarColor);
      }
    }
  }

  if (opts.notes !== undefined) {
    const notesField = page
      .getByLabel(/notes/i)
      .or(page.getByPlaceholder(/notes/i));
    if (await notesField.first().isVisible().catch(() => false)) {
      await notesField.first().fill(opts.notes);
    }
  }

  const createBabyBtn = page
    .getByRole('button', {
      name: /create baby(?: profile)?|add baby|get started|continue/i,
    })
    .or(page.getByRole('button', { name: /save|create/i }));
  await createBabyBtn.first().click();

  await expect(page.getByLabel('Select active baby').first()).toContainText(
    opts.name,
    { timeout: 10_000 },
  );
}

/**
 * Registers a unique user, navigates to the app, and creates a baby if onboarding/empty state is shown.
 */
export async function setupAuthenticatedBaby(
  page: Page,
  opts: SetupAuthenticatedBabyOptions = {},
): Promise<{
  email: string;
  password: string;
  displayName: string;
  babyName: string;
  dob: string;
}> {
  const email = opts.email ?? uniqueEmail('parent');
  const password = opts.password ?? 'StrongPass123!';
  const displayName = opts.displayName ?? 'Alex Parent';
  const babyName = opts.babyName ?? 'Maya';
  const dob = opts.dob ?? '2026-08-01';

  await registerUserViaUI(page, { email, password, displayName });

  // Detect onboarding / empty-state baby creation prompt and create the baby if shown.
  const babyNameInput = page
    .getByLabel(/baby'?s? name|^name$/i)
    .or(page.getByPlaceholder(/baby'?s? name/i));
  const addBabyButton = page.getByRole('button', {
    name: /add (?:a |new |first |another )?baby/i,
  });

  const needsOnboarding =
    (await babyNameInput.first().isVisible().catch(() => false)) ||
    (await addBabyButton.first().isVisible().catch(() => false));

  if (needsOnboarding) {
    await createBabyViaUI(page, {
      name: babyName,
      dob,
      birthWeightGrams: opts.birthWeightGrams,
      avatarColor: opts.avatarColor,
      notes: opts.notes,
    });
  }

  return { email, password, displayName, babyName, dob };
}

/**
 * Simulates losing network connectivity on the browser context.
 */
export async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}

/**
 * Restores network connectivity on the browser context.
 */
export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false);
}

/**
 * Verifies the page has no horizontal overflow at the current viewport width.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

/**
 * Verifies an interactive element meets the minimum tap target size (default 44x44 px).
 */
export async function expectMinTapTarget(
  locator: Locator,
  minPx = 44,
): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.width).toBeGreaterThanOrEqual(minPx);
    expect(box.height).toBeGreaterThanOrEqual(minPx);
  }
}

/**
 * Parses RFC-4180 CSV text into a 2D array of string cells.
 */
export function parseCsv(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentCell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell);
      currentCell = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Spawns an isolated `apps/server` process on `port` with a temporary SQLite database
 * for Cloud Run scale-to-zero / SIGTERM lifecycle tests (F13).
 */
export async function spawnEphemeralServer(
  port: number,
  opts: { dbPath?: string; env?: Record<string, string>; startupTimeoutMs?: number } = {},
): Promise<EphemeralServerHandle> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-tracker-e2e-'));
  const dbPath = opts.dbPath ?? path.join(tempDir, 'tracker.sqlite');
  const baseUrl = `http://127.0.0.1:${port}`;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 20_000;

  const child = spawn('npm', ['start', '--workspace=apps/server'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '0.0.0.0',
      SQLITE_PATH: dbPath,
      DATABASE_PATH: dbPath,
      DB_PATH: dbPath,
      NODE_ENV: 'test',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + startupTimeoutMs;
  let healthy = false;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Ephemeral server exited prematurely with code ${child.exitCode}. stderr:\n${stderr}`,
      );
    }

    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Server is still starting up.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(
      `Timed out waiting for ephemeral server at ${baseUrl}/healthz after ${startupTimeoutMs}ms. stderr:\n${stderr}`,
    );
  }

  const stop = (
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }

      child.once('exit', (code, exitSignal) => {
        resolve({ code, signal: exitSignal });
      });

      child.kill(signal);
    });

  return {
    port,
    baseUrl,
    dbPath,
    process: child,
    stop,
  };
}
