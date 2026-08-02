import { test, expect } from '@playwright/test';

test('API is reachable', async ({ request }) => {
  const res = await request.get('/payment-methods/does-not-exist');
  console.log('Status:', res.status());
  expect(res.status()).toBeLessThan(500);
});