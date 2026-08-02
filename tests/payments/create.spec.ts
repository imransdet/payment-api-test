import { test, expect } from '../fixtures/data.fixture';
import {
  CURRENCIES,
  AMOUNTS,
  INVALID_AMOUNTS,
  INVALID_CURRENCIES,
  cardMethod,
  paymentPayload,
} from '../support/data';
import { expectApiError, expectProcessingShape, waitForSettled } from '../support/helpers';

test.describe('POST /payments', () => {

  test.describe('Happy path', () => {

    test('creates a payment and returns 201 processing', async ({ api, activeCardMethod }) => {
      const res = await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      expect(res.status()).toBe(201);
      expectProcessingShape(await res.json());
    });

    test('the creation response exposes only the minimal shape', async ({ api, activeCardMethod }) => {
      const res = await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });
      const body = await res.json();

      expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'status']);
    });

    for (const currency of CURRENCIES) {
      test(`accepts ${currency}`, async ({ api, activeCardMethod }) => {
        const res = await api.post('/payments', {
          data: paymentPayload(activeCardMethod.id, { currency }),
        });

        expect(res.status()).toBe(201);
      });
    }

    test('accepts the documented minimum amount of 1', async ({ api, activeCardMethod }) => {
      const res = await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id, { amount: AMOUNTS.minimum }),
      });

      expect(res.status()).toBe(201);
    });

    test('accepts a large amount', async ({ api, activeCardMethod }) => {
      const res = await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id, { amount: AMOUNTS.large }),
      });

      expect(res.status()).toBe(201);
    });

    test('charges a sepa method', async ({ api, activeSepaMethod }) => {
      const res = await api.post('/payments', { data: paymentPayload(activeSepaMethod.id) });

      expect(res.status()).toBe(201);
    });

    test('allows several payments against the same method', async ({ api, activeCardMethod }) => {
      const results = await Promise.all([
        api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount: 100 }) }),
        api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount: 200 }) }),
        api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount: 300 }) }),
      ]);

      for (const res of results) expect(res.status()).toBe(201);

      const ids = await Promise.all(results.map(async (r) => (await r.json()).id));
      expect(new Set(ids).size, 'each payment gets a distinct id').toBe(3);
    });

    test('two identical requests create two distinct payments', async ({ api, activeCardMethod }) => {
      // No idempotency key is documented, so duplicates are expected to be
      // accepted. Recording the behaviour rather than asserting it is wrong.
      const payload = paymentPayload(activeCardMethod.id);
      const a = await api.post('/payments', { data: payload });
      const b = await api.post('/payments', { data: payload });

      expect((await a.json()).id).not.toBe((await b.json()).id);
    });
  });

  test.describe('Settlement outcomes', () => {

    test('a payment on a valid card settles to succeeded', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();

      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled.status).toBe('succeeded');
      expect(settled).not.toHaveProperty('failure_reason');
    });

    test('a payment on the declining card fails with card_declined', async ({ api, decliningCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(decliningCardMethod.id),
      })).json();

      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled).toMatchObject({
        status: 'failed',
        failure_reason: 'card_declined',
      });
    });

    test('a payment on the declining iban fails with debit_declined', async ({ api, decliningSepaMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(decliningSepaMethod.id),
      })).json();

      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled).toMatchObject({
        status: 'failed',
        failure_reason: 'debit_declined',
      });
    });

    test('a declined payment still records the requested amount and currency', async ({ api, decliningCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(decliningCardMethod.id, { amount: 4321, currency: 'GBP' }),
      })).json();

      const settled = await waitForSettled(api, `/payments/${created.id}`);

      expect(settled).toMatchObject({
        amount: 4321,
        currency: 'GBP',
        status: 'failed',
      });
    });
  });

  test.describe('Business logic observations', () => {

    test('a payment may be created against a method still processing', async ({ api }) => {
      // The spec never requires a method to be `active` before it can be
      // charged. Documenting the behaviour so a future change is visible.
      const method = await (await api.post('/payment-methods', { data: cardMethod() })).json();
      expect(method.status).toBe('processing');

      const res = await api.post('/payments', { data: paymentPayload(method.id) });
      expect(res.status()).toBe(201);

      const settled = await waitForSettled(api, `/payments/${(await res.json()).id}`);
      expect(settled.status).toBe('succeeded');
    });

    test('no upper bound is enforced on amount', async ({ api, activeCardMethod }) => {
      // Spec sets minimum: 1 with no maximum. ~10 billion in minor units is
      // accepted. Not a contract violation, but worth surfacing for review.
      const res = await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id, { amount: AMOUNTS.unbounded }),
      });

      expect(res.status()).toBe(201);
    });
  });

  test.describe('Negative — payment_method_id', () => {

    const pmCases: Array<[string, unknown]> = [
      ['missing', undefined],
      ['unknown but well-formed', 'pm_0000000000000000000000000000'],
      ['malformed', 'not-an-id'],
      ['empty string', ''],
      ['null', null],
      ['numeric', 12345],
    ];

    for (const [label, payment_method_id] of pmCases) {
      test(`rejects a ${label} payment_method_id`, async ({ api }) => {
        const res = await api.post('/payments', {
          data: { payment_method_id, amount: 1000, currency: 'EUR' },
        });
        await expectApiError(res, 422, 'unknown_payment_method');
      });
    }

    test('rejects a payment id used as a payment_method_id', async ({ api, succeededPayment }) => {
      const res = await api.post('/payments', {
        data: paymentPayload(succeededPayment.payment.id),
      });
      await expectApiError(res, 422, 'unknown_payment_method');
    });
  });

  test.describe('Negative — amount', () => {

    for (const [label, amount] of INVALID_AMOUNTS) {
      test(`rejects a ${label} amount`, async ({ api, activeCardMethod }) => {
        const res = await api.post('/payments', {
          data: { payment_method_id: activeCardMethod.id, amount, currency: 'EUR' },
        });
        await expectApiError(res, 422, 'invalid_amount');
      });
    }

    test('rejects a missing amount', async ({ api, activeCardMethod }) => {
      const res = await api.post('/payments', {
        data: { payment_method_id: activeCardMethod.id, currency: 'EUR' },
      });
      await expectApiError(res, 422, 'invalid_amount');
    });
  });

  test.describe('Negative — currency', () => {

    for (const [label, currency] of INVALID_CURRENCIES) {
      test(`rejects a ${label} currency`, async ({ api, activeCardMethod }) => {
        const res = await api.post('/payments', {
          data: { payment_method_id: activeCardMethod.id, amount: 1000, currency },
        });
        await expectApiError(res, 422, 'unsupported_currency');
      });
    }

    test('rejects a missing currency', async ({ api, activeCardMethod }) => {
      const res = await api.post('/payments', {
        data: { payment_method_id: activeCardMethod.id, amount: 1000 },
      });
      await expectApiError(res, 422, 'unsupported_currency');
    });
  });

  test.describe('Negative — protocol level', () => {

    test('rejects malformed json with 400', async ({ api }) => {
      const res = await api.post('/payments', {
        headers: { 'Content-Type': 'application/json' },
        data: Buffer.from('{ "amount": 1000, '),
      });
      await expectApiError(res, 400, 'invalid_json');
    });

    test('rejects a non-json content-type with 415', async ({ api }) => {
      const res = await api.post('/payments', {
        headers: { 'Content-Type': 'text/plain' },
        data: Buffer.from('amount=1000'),
      });
      await expectApiError(res, 415, 'unsupported_media_type');
    });

    test('rejects a request with no api key with 401', async ({ unauthApi, activeCardMethod }) => {
      const res = await unauthApi.post('/payments', { data: paymentPayload(activeCardMethod.id) });
      await expectApiError(res, 401, 'invalid_api_key');
    });
  });
});