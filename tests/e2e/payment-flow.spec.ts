import { test, expect } from '../fixtures/data.fixture';
import { CARDS, IBANS, cardBlock, sepaBlock, paymentPayload } from '../support/data';
import { waitForSettled } from '../support/helpers';

test.describe('End-to-end payment flows', () => {

  test('a card payment completes the full lifecycle', async ({ api }) => {
    // 1. Register a payment method
    const createMethod = await api.post('/payment-methods', {
      data: { type: 'adyen', card: cardBlock() },
    });
    expect(createMethod.status()).toBe(201);
    const { id: methodId } = await createMethod.json();

    // 2. It settles to active with masked details
    const method = await waitForSettled(api, `/payment-methods/${methodId}`);
    expect(method).toMatchObject({
      type: 'adyen',
      status: 'active',
      card: { brand: 'visa', last4: '1111' },
    });

    // 3. Charge it
    const createPayment = await api.post('/payments', {
      data: paymentPayload(methodId, { amount: 2500, currency: 'EUR' }),
    });
    expect(createPayment.status()).toBe(201);
    const { id: paymentId } = await createPayment.json();

    // 4. It settles to succeeded
    const payment = await waitForSettled(api, `/payments/${paymentId}`);
    expect(payment).toMatchObject({
      id: paymentId,
      payment_method_id: methodId,
      amount: 2500,
      currency: 'EUR',
      status: 'succeeded',
    });

    // 5. It appears in the method's payment list
    const list = await (await api.get(`/payment-methods/${methodId}/payments`)).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      payment_method_id: methodId,
      amount: 2500,
      status: 'succeeded',
    });

    // 6. No sensitive data leaked anywhere in the flow
    const everything = JSON.stringify({ method, payment, list });
    expect(everything).not.toContain(CARDS.visa);
    expect(everything).not.toContain('123'); // cvc
  });

  test('a sepa payment completes the full lifecycle', async ({ api }) => {
    const createMethod = await api.post('/payment-methods', {
      data: { type: 'sepa', sepa: sepaBlock() },
    });
    const { id: methodId } = await createMethod.json();

    const method = await waitForSettled(api, `/payment-methods/${methodId}`);
    expect(method).toMatchObject({
      type: 'sepa',
      status: 'active',
      sepa: { country: 'DE', iban_last4: '3000' },
    });

    const createPayment = await api.post('/payments', {
      data: paymentPayload(methodId, { amount: 5000 }),
    });
    const { id: paymentId } = await createPayment.json();

    const payment = await waitForSettled(api, `/payments/${paymentId}`);
    expect(payment).toMatchObject({
      payment_method_id: methodId,
      amount: 5000,
      status: 'succeeded',
    });

    expect(JSON.stringify({ method, payment })).not.toContain(IBANS.valid);
  });

  test('a declined card payment completes the full lifecycle', async ({ api }) => {
    const { id: methodId } = await (await api.post('/payment-methods', {
      data: { type: 'adyen', card: cardBlock({ number: CARDS.declined }) },
    })).json();

    // The method itself still registers successfully.
    const method = await waitForSettled(api, `/payment-methods/${methodId}`);
    expect(method).toMatchObject({ status: 'active', card: { last4: '0002' } });

    const { id: paymentId } = await (await api.post('/payments', {
      data: paymentPayload(methodId),
    })).json();

    const payment = await waitForSettled(api, `/payments/${paymentId}`);
    expect(payment).toMatchObject({
      status: 'failed',
      failure_reason: 'card_declined',
    });

    // A failed payment is still recorded against the method.
    const list = await (await api.get(`/payment-methods/${methodId}/payments`)).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].status).toBe('failed');
  });

  test('a declined sepa payment completes the full lifecycle', async ({ api }) => {
    const { id: methodId } = await (await api.post('/payment-methods', {
      data: { type: 'sepa', sepa: sepaBlock({ iban: IBANS.declined }) },
    })).json();
    await waitForSettled(api, `/payment-methods/${methodId}`);

    const { id: paymentId } = await (await api.post('/payments', {
      data: paymentPayload(methodId),
    })).json();

    const payment = await waitForSettled(api, `/payments/${paymentId}`);
    expect(payment).toMatchObject({
      status: 'failed',
      failure_reason: 'debit_declined',
    });
  });

  test('one method supports mixed succeeded and failed payments', async ({ api, activeCardMethod }) => {
    const ids: string[] = [];
    for (const amount of [100, 200, 300]) {
      const res = await api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount }) });
      ids.push((await res.json()).id);
    }

    for (const id of ids) await waitForSettled(api, `/payments/${id}`);

    const list = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
    expect(list.data).toHaveLength(3);
    expect(list.data.map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([100, 200, 300]);
  });

  test.describe('Cross-endpoint consistency', () => {

    // Both known defects are only visible by comparing the same record across
    // endpoints. Each endpoint is internally plausible; they disagree with
    // each other. These tests are expected to fail until the defects are fixed.

    test('the same payment is identical on the detail and list endpoints [DEFECT-1, DEFECT-2]', async ({ api, activeCardMethod }) => {
      const { id: paymentId } = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();

      const detail = await waitForSettled(api, `/payments/${paymentId}`);
      const list = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const listed = list.data[0];

      // Fields the two endpoints agree on.
      expect(listed.payment_method_id).toBe(detail.payment_method_id);
      expect(listed.amount).toBe(detail.amount);
      expect(listed.currency).toBe(detail.currency);
      expect(listed.status).toBe(detail.status);
      expect(listed.created_at).toBe(detail.created_at);

      // Fields they disagree on.
      expect(listed.id, 'DEFECT-1: list returns a different id').toBe(detail.id);
      expect(listed.holder_name, 'DEFECT-2: detail truncates holder_name').toBe(detail.holder_name);
    });

    test('holder_name is consistent across all three endpoints [DEFECT-2]', async ({ api }) => {
      const holder_name = 'Imran Test';
      const { id: methodId } = await (await api.post('/payment-methods', {
        data: { type: 'adyen', card: cardBlock({ holder_name }) },
      })).json();
      const method = await waitForSettled(api, `/payment-methods/${methodId}`);

      const { id: paymentId } = await (await api.post('/payments', {
        data: paymentPayload(methodId),
      })).json();
      const payment = await waitForSettled(api, `/payments/${paymentId}`);

      const list = await (await api.get(`/payment-methods/${methodId}/payments`)).json();

      expect(method.card?.holder_name, 'payment method endpoint').toBe(holder_name);
      expect(list.data[0].holder_name, 'list endpoint').toBe(holder_name);
      expect(payment.holder_name, 'payment detail endpoint').toBe(holder_name);
    });

    test('a payment listed against a method is retrievable by that id [DEFECT-1]', async ({ api, activeCardMethod }) => {
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      const list = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const listedId = list.data[0].id;

      const fetched = await api.get(`/payments/${listedId}`);
      expect(fetched.status(), `listed payment ${listedId} is not retrievable`).toBe(200);

      const body = await fetched.json();
      expect(body.payment_method_id).toBe(activeCardMethod.id);
    });
  });
});