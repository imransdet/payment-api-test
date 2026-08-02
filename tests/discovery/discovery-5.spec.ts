import { test } from '../fixtures/api.fixture';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const IBAN_OK = 'DE89370400440532013000';

async function log(label: string, res: APIResponse): Promise<void> {
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  console.log(`${label.padEnd(28)} [${res.status()}]`, JSON.stringify(body));
}

async function settle(api: APIRequestContext, path: string): Promise<any> {
  for (let i = 0; i < 24; i++) {
    const res = await api.get(path);
    const body = await res.json();
    if (body.status !== 'processing') return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: 'STILL_PROCESSING' };
}

test('discover: bic, brands, truncation shape', async ({ api }) => {
  test.setTimeout(120_000);

  // ---------- 1. BIC — documented but never exercised ----------
  console.log('\n=== BIC ===');
  const bicCases: Array<[string, string]> = [
    ['valid 8-char', 'DEUTDEFF'],
    ['valid 11-char', 'DEUTDEFF500'],
    ['too short (7)', 'DEUTDEF'],
    ['wrong length (9)', 'DEUTDEFF5'],
    ['lowercase', 'deutdeff'],
    ['digits only', '12345678'],
  ];
  for (const [label, bic] of bicCases) {
    await log(label, await api.post('/payment-methods', {
      data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban: IBAN_OK, bic } },
    }));
  }

  // Does a valid BIC survive to the active representation?
  const bicRes = await api.post('/payment-methods', {
    data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban: IBAN_OK, bic: 'DEUTDEFF' } },
  });
  const bicPm = await bicRes.json();
  console.log('SEPA+BIC ACTIVE:', JSON.stringify(await settle(api, `/payment-methods/${bicPm.id}`), null, 2));

  // ---------- 2. IBAN with spaces — spec says allowed ----------
  console.log('\n=== IBAN SPACES ===');
  await log('spaced iban', await api.post('/payment-methods', {
    data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban: 'DE89 3704 0044 0532 0130 00' } },
  }));

  // ---------- 3. Card brands ----------
  console.log('\n=== BRANDS ===');
  const brands: Array<[string, string]> = [
    ['visa', '4111111111111111'],
    ['mastercard', '5555555555554444'],
    ['amex (15)', '378282246310005'],
    ['discover', '6011111111111117'],
  ];
  for (const [label, number] of brands) {
    const res = await api.post('/payment-methods', {
      data: { type: 'adyen', card: { holder_name: 'Imran Test', number, exp_month: 12, exp_year: 2027, cvc: '123' } },
    });
    if (res.status() !== 201) { await log(label, res); continue; }
    const { id } = await res.json();
    const settled = await settle(api, `/payment-methods/${id}`);
    console.log(`${label.padEnd(28)} brand=${settled.card?.brand} last4=${settled.card?.last4}`);
  }

  // ---------- 4. Characterise Bug B — is it always the last char? ----------
  console.log('\n=== TRUNCATION SHAPE ===');
  const names = ['A', 'AB', 'Bob', 'Imran', 'Imran Test', 'A Very Long Holder Name Indeed'];
  for (const holder_name of names) {
    const pmRes = await api.post('/payment-methods', {
      data: { type: 'adyen', card: { holder_name, number: '4111111111111111', exp_month: 12, exp_year: 2027, cvc: '123' } },
    });
    const pm = await pmRes.json();
    const pmSettled = await settle(api, `/payment-methods/${pm.id}`);

    const payRes = await api.post('/payments', {
      data: { payment_method_id: pm.id, amount: 500, currency: 'EUR' },
    });
    const pay = await payRes.json();
    const paySettled = await settle(api, `/payments/${pay.id}`);

    const listRes = await api.get(`/payment-methods/${pm.id}/payments`);
    const list = await listRes.json();

    console.log(
      `sent=${JSON.stringify(holder_name).padEnd(34)}`,
      `pm=${JSON.stringify(pmSettled.card?.holder_name).padEnd(34)}`,
      `detail=${JSON.stringify(paySettled.holder_name).padEnd(34)}`,
      `list=${JSON.stringify(list.data?.[0]?.holder_name)}`,
    );
  }

  // ---------- 5. payload_too_large ----------
  console.log('\n=== 413 ===');
  const huge = 'x'.repeat(2_000_000);
  await log('2MB holder_name', await api.post('/payment-methods', {
    headers: { 'Content-Type': 'application/json' },
    data: Buffer.from(JSON.stringify({
      type: 'adyen',
      card: { holder_name: huge, number: '4111111111111111', exp_month: 12, exp_year: 2027, cvc: '123' },
    })),
  }));

  // ---------- 6. 404 on unknown payment method ----------
  console.log('\n=== 404 COVERAGE ===');
  await log('unknown pm', await api.get('/payment-methods/pm_0000000000000000000000000000'));
  await log('malformed id', await api.get('/payment-methods/not-an-id'));
  await log('payment id on pm route', await api.get('/payment-methods/pay_0000000000000000000000000000'));
});