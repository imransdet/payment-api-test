import { test } from './fixtures/api.fixture';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const CARD_OK = '4111111111111111';
const IBAN_OK = 'DE89370400440532013000';
const IBAN_DECLINE = 'DE62370400440532013001';

const validCard = () => ({
  holder_name: 'Imran Test',
  number: CARD_OK,
  exp_month: 12,
  exp_year: 2027,
  cvc: '123',
});

async function log(label: string, res: APIResponse): Promise<void> {
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  console.log(`${label.padEnd(30)} [${res.status()}]`, JSON.stringify(body));
}

/** Polls a resource until it leaves `processing`, or gives up. */
async function settle(api: APIRequestContext, path: string): Promise<any> {
  for (let i = 0; i < 24; i++) {
    const res = await api.get(path);
    const body = await res.json();
    if (body.status !== 'processing') return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: 'STILL_PROCESSING_AFTER_12S' };
}

test('discover: sepa, checkout, race outcome', async ({ api }) => {
  test.setTimeout(120_000);

  // ---------- 1. SEPA full lifecycle — is the IBAN masked? ----------
  console.log('\n=== SEPA ===');
  const sepaRes = await api.post('/payment-methods', {
    data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban: IBAN_OK } },
  });
  const sepa = await sepaRes.json();
  const sepaActive = await settle(api, `/payment-methods/${sepa.id}`);
  console.log('SEPA ACTIVE:', JSON.stringify(sepaActive, null, 2));

  const sepaPayRes = await api.post('/payments', {
    data: { payment_method_id: sepa.id, amount: 2500, currency: 'EUR' },
  });
  const sepaPay = await sepaPayRes.json();
  const sepaPayFinal = await settle(api, `/payments/${sepaPay.id}`);
  console.log('SEPA PAYMENT:', JSON.stringify(sepaPayFinal, null, 2));

  // Bug B check on the sepa path — does holder_name truncate here too?
  console.log('holder_name sent    : "Imran Test"');
  console.log('holder_name returned:', JSON.stringify(sepaPayFinal.holder_name));

  // ---------- 2. SEPA decline ----------
  console.log('\n=== SEPA DECLINE ===');
  const dRes = await api.post('/payment-methods', {
    data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban: IBAN_DECLINE } },
  });
  const d = await dRes.json();
  await settle(api, `/payment-methods/${d.id}`);
  const dPayRes = await api.post('/payments', {
    data: { payment_method_id: d.id, amount: 2500, currency: 'EUR' },
  });
  const dPay = await dPayRes.json();
  console.log('DECLINED SEPA:', JSON.stringify(await settle(api, `/payments/${dPay.id}`), null, 2));

  // ---------- 3. checkout type — same shape as adyen? ----------
  console.log('\n=== CHECKOUT ===');
  const coRes = await api.post('/payment-methods', {
    data: { type: 'checkout', card: validCard() },
  });
  const co = await coRes.json();
  console.log('CHECKOUT ACTIVE:', JSON.stringify(await settle(api, `/payment-methods/${co.id}`), null, 2));

  // ---------- 4. Race outcome: does a payment against a processing method succeed? ----------
  console.log('\n=== RACE OUTCOME ===');
  const raceRes = await api.post('/payment-methods', {
    data: { type: 'adyen', card: validCard() },
  });
  const race = await raceRes.json();
  console.log('pm status at charge time:', race.status);

  const racePayRes = await api.post('/payments', {
    data: { payment_method_id: race.id, amount: 1000, currency: 'EUR' },
  });
  const racePay = await racePayRes.json();
  console.log('charge accepted:', racePayRes.status());
  console.log('RACE PAYMENT FINAL:', JSON.stringify(await settle(api, `/payments/${racePay.id}`), null, 2));

  // ---------- 5. Invalid IBAN validation ----------
  console.log('\n=== IBAN VALIDATION ===');
  for (const [label, iban] of [
    ['bad checksum', 'DE89370400440532013099'],
    ['too short', 'DE89'],
    ['not an iban', 'not-an-iban'],
    ['empty', ''],
  ] as Array<[string, string]>) {
    await log(label, await api.post('/payment-methods', {
      data: { type: 'sepa', sepa: { holder_name: 'Imran Test', iban } },
    }));
  }

  // ---------- 6. Cross-type mismatch ----------
  console.log('\n=== TYPE MISMATCH ===');
  await log('sepa w/ card block', await api.post('/payment-methods', {
    data: { type: 'sepa', card: validCard() },
  }));
  await log('adyen w/ sepa block', await api.post('/payment-methods', {
    data: { type: 'adyen', sepa: { holder_name: 'Imran Test', iban: IBAN_OK } },
  }));
  await log('both blocks', await api.post('/payment-methods', {
    data: { type: 'adyen', card: validCard(), sepa: { holder_name: 'X', iban: IBAN_OK } },
  }));
});