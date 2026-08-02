import { test } from './fixtures/api.fixture';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const CARD_OK = '4111111111111111';
const IBAN_OK = 'DE89370400440532013000';

type CardPayload = {
  holder_name: string;
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
};

const validCard = (): CardPayload => ({
  holder_name: 'Imran Test',
  number: CARD_OK,
  exp_month: 12,
  exp_year: 2027,
  cvc: '123',
});

/** Logs status + body for a probe. Falls back to text if the body isn't JSON. */
async function log(label: string, res: APIResponse): Promise<void> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  console.log(`${label.padEnd(34)} [${res.status()}]`, JSON.stringify(body));
}

/** Creates a payment method and waits for it to leave `processing`. */
async function createActiveMethod(api: APIRequestContext): Promise<string> {
  const res = await api.post('/payment-methods', {
    data: { type: 'adyen', card: validCard() },
  });
  const { id } = await res.json();

  for (let i = 0; i < 20; i++) {
    const poll = await api.get(`/payment-methods/${id}`);
    const body = await poll.json();
    if (body.status !== 'processing') return id;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Payment method ${id} never left processing`);
}

test('discover: schemas + validation rules', async ({ api }) => {
  test.setTimeout(120_000);

  // ---------- A. Reverse-engineer sepa / checkout schemas ----------
  // Sending only `type` makes the API report what else it expects.
  console.log('\n=== SCHEMA PROBES ===');
  for (const type of ['adyen', 'checkout', 'sepa']) {
    await log(`bare type=${type}`, await api.post('/payment-methods', { data: { type } }));
  }

  await log(
    'sepa nested',
    await api.post('/payment-methods', {
      data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban: IBAN_OK } },
    }),
  );
  await log(
    'sepa flat',
    await api.post('/payment-methods', {
      data: { type: 'sepa', holder_name: 'Imran Test', iban: IBAN_OK },
    }),
  );
  await log(
    'checkout w/ card',
    await api.post('/payment-methods', {
      data: { type: 'checkout', card: validCard() },
    }),
  );

  // ---------- B. Card field validation ----------
  console.log('\n=== CARD VALIDATION ===');
  const cardCases: Array<[string, Record<string, unknown>]> = [
    ['empty holder_name', { ...validCard(), holder_name: '' }],
    ['holder_name null', { ...validCard(), holder_name: null }],
    ['bad luhn', { ...validCard(), number: '4111111111111112' }],
    ['non-numeric number', { ...validCard(), number: 'abcd' }],
    ['exp_month 13', { ...validCard(), exp_month: 13 }],
    ['exp_month 0', { ...validCard(), exp_month: 0 }],
    ['past exp_year', { ...validCard(), exp_year: 2020 }],
    ['exp_year 2-digit', { ...validCard(), exp_year: 27 }],
    ['cvc too short', { ...validCard(), cvc: '1' }],
    ['cvc letters', { ...validCard(), cvc: 'abc' }],
    ['missing cvc', (({ cvc, ...rest }) => rest)(validCard())],
  ];

  for (const [label, card] of cardCases) {
    await log(label, await api.post('/payment-methods', { data: { type: 'adyen', card } }));
  }

  // ---------- C. Payment validation ----------
  const methodId = await createActiveMethod(api);
  console.log('\n=== PAYMENT VALIDATION (pm:', methodId, ') ===');

  const payCases: Array<[string, Record<string, unknown>]> = [
    ['amount 0', { payment_method_id: methodId, amount: 0, currency: 'EUR' }],
    ['amount negative', { payment_method_id: methodId, amount: -100, currency: 'EUR' }],
    ['amount decimal', { payment_method_id: methodId, amount: 10.5, currency: 'EUR' }],
    ['amount string', { payment_method_id: methodId, amount: '1000', currency: 'EUR' }],
    ['amount huge', { payment_method_id: methodId, amount: 999_999_999_999, currency: 'EUR' }],
    ['missing amount', { payment_method_id: methodId, currency: 'EUR' }],
    ['missing currency', { payment_method_id: methodId, amount: 1000 }],
    ['currency lowercase', { payment_method_id: methodId, amount: 1000, currency: 'eur' }],
    ['currency invalid', { payment_method_id: methodId, amount: 1000, currency: 'XYZ' }],
    ['currency too long', { payment_method_id: methodId, amount: 1000, currency: 'EURO' }],
    ['missing pm_id', { amount: 1000, currency: 'EUR' }],
    ['unknown pm_id', { payment_method_id: 'pm_0000000000000000000000000000', amount: 1000, currency: 'EUR' }],
    ['wrong prefix pm_id', { payment_method_id: methodId.replace('pm_', 'pay_'), amount: 1000, currency: 'EUR' }],
    ['extra unknown field', { payment_method_id: methodId, amount: 1000, currency: 'EUR', foo: 'bar' }],
  ];

  for (const [label, data] of payCases) {
    await log(label, await api.post('/payments', { data }));
  }

  // ---------- D. Race: charge a method that is still processing ----------
  console.log('\n=== RACE: charge while processing ===');
  const fresh = await api.post('/payment-methods', { data: { type: 'adyen', card: validCard() } });
  const { id: freshId } = await fresh.json();
  await log(
    'pay vs processing pm',
    await api.post('/payments', {
      data: { payment_method_id: freshId, amount: 1000, currency: 'EUR' },
    }),
  );

  // ---------- E. Protocol-level errors ----------
  // Buffer sends exact bytes; an object or string would be re-serialised.
  console.log('\n=== PROTOCOL ERRORS ===');
  const jsonHeaders = { 'Content-Type': 'application/json' };

  await log(
    'malformed json',
    await api.post('/payment-methods', { headers: jsonHeaders, data: Buffer.from('{ "type": "adyen", ') }),
  );
  await log(
    'empty body',
    await api.post('/payment-methods', { headers: jsonHeaders, data: Buffer.from('') }),
  );
  await log(
    'array not object',
    await api.post('/payment-methods', { headers: jsonHeaders, data: Buffer.from('[{"type":"adyen"}]') }),
  );
  await log(
    'wrong content-type',
    await api.post('/payment-methods', { headers: { 'Content-Type': 'text/plain' }, data: Buffer.from('hello') }),
  );
  await log(
    'invalid api key',
    await api.get(`/payment-methods/${methodId}`, { headers: { 'X-Api-Key': 'key_totally_invalid' } }),
  );

  // ---------- F. List endpoint behaviour ----------
  console.log('\n=== LIST ENDPOINT ===');
  await log('list unknown pm', await api.get('/payment-methods/pm_0000000000000000000000000000/payments'));
  await log(
    'list w/ pagination',
    await api.get(`/payment-methods/${methodId}/payments`, { params: { limit: 1, offset: 0 } }),
  );
  await log('list on payment id', await api.get(`/payment-methods/${methodId.replace('pm_', 'pay_')}/payments`));
});