import { defineConfig } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/exploratory/**',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL,
    extraHTTPHeaders: {
      'X-Api-Key': process.env.API_KEY ?? '',
      'Content-Type': 'application/json',
    },
  },
});