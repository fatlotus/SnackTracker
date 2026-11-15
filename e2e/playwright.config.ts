import { defineConfig, devices } from '@playwright/test';

const workers = process.env.E2E_WORKERS
  ? Math.max(1, Number.parseInt(process.env.E2E_WORKERS, 10) || 1)
  : 1;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  ...(process.env.E2E_START_SERVER === '1'
    ? {
        webServer: {
          command: 'npm start --workspace=apps/server',
          cwd: '..',
          url: 'http://127.0.0.1:8080/healthz',
          reuseExistingServer: true,
          timeout: 30_000,
        },
      }
    : {}),
});
