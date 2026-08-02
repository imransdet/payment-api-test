import { test } from '../fixtures/api.fixture';

const CARD_OK = '4111111111111111';
const CARD_DECLINE = '4000000000000002';

function card(number: string) {
  return {
    type: 'adyen',
    card: {
      holder_name: 'Imran Test',
      number,
      exp_month: 12,
      exp_year: 2027,
      cvc: '123',
    },
  };
}

async function pollUntilDone(api: any, path: string, label: string) {
  console.log(`\n--- polling ${label} ---`);
  for (let i = 1; i <= 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const res = await api.get(path);
    const body = await res.json();
    console.log(`t+${i}s [${res.status()}]`, JSON.stringify(body));
    if (body.status !== 'processing') return body;
  }
  console.log('!! still processing after 10s');
  return null;
}

test('discover: terminal states + contract', async ({ api, unauthApi }) => {

  // ---------- 1. Happy path: payment method -> active ----------
  const pmRes = await api.post('/payment-methods', { data: card(CARD_OK) });
  const pm = await pmRes.json();
  console.log('\n=== PM created ===', pmRes.status(), JSON.stringify(pm));
  const pmFinal = await pollUntilDone(api, `/payment-methods/${pm.id}`, 'payment method');
  console.log('PM FINAL SHAPE:', JSON.stringify(pmFinal, null, 2));

  // ---------- 2. Happy path: payment -> succeeded ----------
  const payRes = await api.post('/payments', {
    data: { payment_method_id: pm.id, amount: 1000, currency: 'EUR' },
  });
  const pay = await payRes.json();
  console.log('\n=== Payment created ===', payRes.status(), JSON.stringify(pay));
  const payFinal = await pollUntilDone(api, `/payments/${pay.id}`, 'payment');
  console.log('PAYMENT FINAL SHAPE:', JSON.stringify(payFinal, null, 2));

  // ---------- 3. BUG CHECK: list ID integrity ----------
  const listRes = await api.get(`/payment-methods/${pm.id}/payments`);
  const list = await listRes.json();
  console.log('\n=== LIST INTEGRITY ===');
  console.log('Expected ID :', pay.id);
  console.log('IDs in list :', list.data?.map((p: any) => p.id));
  console.log('MATCH       :', list.data?.some((p: any) => p.id === pay.id));
  console.log('Full list   :', JSON.stringify(list, null, 2));

  // ---------- 4. Decline path ----------
  const dpmRes = await api.post('/payment-methods', { data: card(CARD_DECLINE) });
  const dpm = await dpmRes.json();
  await pollUntilDone(api, `/payment-methods/${dpm.id}`, 'declined-card PM');

  const dpayRes = await api.post('/payments', {
    data: { payment_method_id: dpm.id, amount: 1000, currency: 'EUR' },
  });
  const dpay = await dpayRes.json();
  const dpayFinal = await pollUntilDone(api, `/payments/${dpay.id}`, 'declined payment');
  console.log('DECLINED PAYMENT SHAPE:', JSON.stringify(dpayFinal, null, 2));

  // ---------- 5. Error envelope shapes ----------
  console.log('\n=== ERROR ENVELOPES ===');

  const notFound = await api.get('/payments/pay_doesnotexist000000000000000000');
  console.log('404      :', notFound.status(), JSON.stringify(await notFound.json()));

  const noAuth = await unauthApi.get(`/payments/${pay.id}`);
  console.log('401      :', noAuth.status(), JSON.stringify(await noAuth.json()));

  const badJson = await api.post('/payment-methods', {
    headers: { 'Content-Type': 'application/json' },
    data: '{ "type": "adyen", ',
  });
  console.log('400      :', badJson.status(), JSON.stringify(await badJson.json()));

  const badType = await api.post('/payment-methods', {
    headers: { 'Content-Type': 'text/plain' },
    data: 'hello',
  });
  console.log('415      :', badType.status(), JSON.stringify(await badType.json()));

  const missingField = await api.post('/payment-methods', {
    data: { type: 'adyen', card: { number: CARD_OK } },
  });
  console.log('422      :', missingField.status(), JSON.stringify(await missingField.json()));

  const badPmType = await api.post('/payment-methods', {
    data: { ...card(CARD_OK), type: 'not_a_real_type' },
  });
  console.log('bad type :', badPmType.status(), JSON.stringify(await badPmType.json()));
});