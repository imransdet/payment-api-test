import { test, expect } from '../fixtures/data.fixture';
import { paymentPayload, cardBlock, CARDS } from '../support/data';
import { expectApiError, expectProcessingShape, waitForSettled, SETTLE_TIMEOUT } from '../support/helpers';

test.describe('GET /payments/{id}', () => {

  test.describe('Processing representation', () => {

    test('returns the minimal processing shape immediately after creation', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();

      const res = await api.get(`/payments/${created.id}`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'status']);
      expectProcessingShape(body);
      expect(body.id).toBe(created.id);
    });
  });

  test.describe('Settled representation', () => {

    test('a succeeded payment returns every required field', async ({ succeededPayment }) => {
      const { payment, method } = succeededPayment;

      expect(payment).toMatchObject({
        id: expect.any(String),
        payment_method_id: method.id,
        amount: 1000,
        currency: 'EUR',
        status: 'succeeded',
        created_at: expect.any(String),
      });
      // Spec marks holder_name required on Payment.
      expect(payment).toHaveProperty('holder_name');
    });

    test('a succeeded payment carries no failure_reason', async ({ succeededPayment }) => {
      // Spec: "Present only when status is failed."
      expect(succeededPayment.payment).not.toHaveProperty('failure_reason');
    });

    test('a failed payment carries a documented failure_reason', async ({ api, decliningCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(decliningCardMethod.id),
      })).json();
      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled.status).toBe('failed');
      expect(['card_declined', 'debit_declined']).toContain(settled.failure_reason);
    });

    test('the amount and currency requested are the ones returned', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id, { amount: 7777, currency: 'USD' }),
      })).json();
      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled).toMatchObject({ amount: 7777, currency: 'USD' });
    });

    test('payment_method_id references the method that was charged', async ({ succeededPayment }) => {
      expect(succeededPayment.payment.payment_method_id).toBe(succeededPayment.method.id);
    });

    test('created_at does not change between processing and settled', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();
      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled.created_at).toBe(created.created_at);
    });

    test('the settled representation is stable across repeated reads', async ({ api, succeededPayment }) => {
      const a = await (await api.get(`/payments/${succeededPayment.payment.id}`)).json();
      const b = await (await api.get(`/payments/${succeededPayment.payment.id}`)).json();

      expect(a).toEqual(b);
    });

    test('reaches a terminal state within the polling ceiling', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();

      const start = Date.now();
      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(['succeeded', 'failed']).toContain(settled.status);
      expect(Date.now() - start).toBeLessThan(SETTLE_TIMEOUT);
    });
  });

  test.describe('holder_name integrity', () => {

    // DEFECT-2: GET /payments/{id} returns holder_name with the final character
    // removed. Deterministic at every length; a single-character name comes back
    // as an empty string, which also breaks the spec's `required` on holder_name.
    // The same field is returned intact by GET /payment-methods/{id} and by
    // GET /payment-methods/{id}/payments, so the fault is in this serializer.
    // These tests are expected to fail until the defect is fixed.

    const names = ['A', 'AB', 'Bob', 'Imran', 'Imran Test'];

    for (const holder_name of names) {
      test(`returns holder_name "${holder_name}" unmodified`, async ({ api }) => {
        const method = await (await api.post('/payment-methods', {
          data: { type: 'adyen', card: cardBlock({ holder_name }) },
        })).json();
        await waitForSettled(api, `/payment-methods/${method.id}`);

        const created = await (await api.post('/payments', {
          data: paymentPayload(method.id),
        })).json();
        const payment = await waitForSettled(api, `/payments/${created.id}`);

        expect(
          payment.holder_name,
          `holder_name should match the payment method's holder_name`,
        ).toBe(holder_name);
      });
    }

    test('holder_name matches the payment method it was charged against', async ({ succeededPayment }) => {
      const { payment, method } = succeededPayment;

      // Spec: "The holder name of the payment method this payment was made with."
      expect(payment.holder_name).toBe(method.card?.holder_name);
    });

    test('holder_name is never empty', async ({ api }) => {
      // A one-character holder_name settles to "", violating `required`.
      const method = await (await api.post('/payment-methods', {
        data: { type: 'adyen', card: cardBlock({ holder_name: 'A' }) },
      })).json();
      await waitForSettled(api, `/payment-methods/${method.id}`);

      const created = await (await api.post('/payments', {
        data: paymentPayload(method.id),
      })).json();
      const payment = await waitForSettled(api, `/payments/${created.id}`);

      expect(payment.holder_name).not.toBe('');
    });
  });

  test.describe('Sensitive data is never returned', () => {

    test('no card number or cvc appears on a payment', async ({ succeededPayment }) => {
      const raw = JSON.stringify(succeededPayment.payment);

      expect(raw).not.toContain(CARDS.visa);
      expect(succeededPayment.payment).not.toHaveProperty('card');
      expect(succeededPayment.payment).not.toHaveProperty('cvc');
    });
  });

  test.describe('Negative', () => {

    const notFoundCases: Array<[string, string]> = [
      ['an unknown but well-formed id', 'pay_0000000000000000000000000000'],
      ['a malformed id', 'not-an-id'],
      ['a payment-method id on the payment route', 'pm_0000000000000000000000000000'],
      ['a numeric id', '12345'],
    ];

    for (const [label, id] of notFoundCases) {
      test(`returns 404 for ${label}`, async ({ api }) => {
        const res = await api.get(`/payments/${id}`);
        await expectApiError(res, 404, 'not_found');
      });
    }

    test('returns 404 for a real payment-method id used on the payment route', async ({ api, activeCardMethod }) => {
      const res = await api.get(`/payments/${activeCardMethod.id}`);
      await expectApiError(res, 404, 'not_found');
    });

    test('returns 401 without an api key', async ({ unauthApi, succeededPayment }) => {
      const res = await unauthApi.get(`/payments/${succeededPayment.payment.id}`);
      await expectApiError(res, 401, 'invalid_api_key');
    });

    test('returns 401 with an unknown api key', async ({ api, succeededPayment }) => {
      const res = await api.get(`/payments/${succeededPayment.payment.id}`, {
        headers: { 'X-Api-Key': 'key_not_a_real_key' },
      });
      await expectApiError(res, 401, 'invalid_api_key');
    });

    test('auth is checked before existence', async ({ unauthApi }) => {
      const res = await unauthApi.get('/payments/pay_0000000000000000000000000000');
      await expectApiError(res, 401, 'invalid_api_key');
    });
  });
});