import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'node ./playwright/server.mjs --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

