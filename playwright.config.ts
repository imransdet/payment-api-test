import { defineConfig } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/exploratory/**',
  fullyParallel: true,
  // Keeps aggregate poll + fixture-setup traffic inside the documented
  // 300 req/min limit. Without this, Playwright defaults to one worker per
  // CPU core, which reliably trips 429s when the full suite runs together.
  workers: 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL,
    extraHTTPHeaders: {
      'X-Api-Key': process.env.API_KEY ?? '',
      'Content-Type': 'application/json',
    },
  },
});