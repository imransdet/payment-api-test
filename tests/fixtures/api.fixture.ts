import { test as base, expect, APIRequestContext } from '@playwright/test';
import 'dotenv/config';
import { withRateLimitRetry } from '../support/helpers';

type ApiFixtures = {
  api: APIRequestContext;
  unauthApi: APIRequestContext;
};

export const test = base.extend<ApiFixtures>({
  // Authenticated context — used by most tests
  api: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: process.env.BASE_URL,
      extraHTTPHeaders: {
        'X-Api-Key': process.env.API_KEY ?? '',
        'Content-Type': 'application/json',
      },
    });
    await use(withRateLimitRetry(context));
    await context.dispose();
  },

  // No API key — for auth negative tests
  unauthApi: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: process.env.BASE_URL,
      extraHTTPHeaders: {
        'Content-Type': 'application/json',
      },
    });
    await use(withRateLimitRetry(context));
    await context.dispose();
  },
});

export { expect };