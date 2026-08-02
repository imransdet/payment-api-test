import { test } from '../fixtures/api.fixture';

test('discover: full happy path', async ({ api }) => {
  // 1. Create payment method
  const pmRes = await api.post('/payment-methods', {
    data: {
      type: 'adyen',
      card: {
        holder_name: 'Imran Test',
        number: '4111111111111111',
        exp_month: 12,
        exp_year: 2027,
        cvc: '123',
      },
    },
  });
  const pm = await pmRes.json();
  console.log('\n=== POST /payment-methods ===');
  console.log('Status:', pmRes.status());
  console.log(JSON.stringify(pm, null, 2));

  // 2. Fetch it back
  const getPmRes = await api.get(`/payment-methods/${pm.id}`);
  console.log('\n=== GET /payment-methods/{id} ===');
  console.log('Status:', getPmRes.status());
  console.log(JSON.stringify(await getPmRes.json(), null, 2));

  // 3. Create a payment
  const payRes = await api.post('/payments', {
    data: {
      payment_method_id: pm.id,
      amount: 1000,
      currency: 'EUR',
    },
  });
  const pay = await payRes.json();
  console.log('\n=== POST /payments ===');
  console.log('Status:', payRes.status());
  console.log(JSON.stringify(pay, null, 2));

  // 4. Fetch the payment
  const getPayRes = await api.get(`/payments/${pay.id}`);
  console.log('\n=== GET /payments/{id} ===');
  console.log('Status:', getPayRes.status());
  console.log(JSON.stringify(await getPayRes.json(), null, 2));

  // 5. List payments on the method
  const listRes = await api.get(`/payment-methods/${pm.id}/payments`);
  console.log('\n=== GET /payment-methods/{id}/payments ===');
  console.log('Status:', listRes.status());
  console.log(JSON.stringify(await listRes.json(), null, 2));
});