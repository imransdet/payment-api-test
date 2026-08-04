import { test, expect } from '../fixtures/data.fixture';
import { CARDS, IBANS, CARD_TYPES, cardMethod } from '../support/data';
import {
  expectApiError,
  expectProcessingShape,
  waitForSettled,
  SETTLE_TIMEOUT,
} from '../support/helpers';

test.describe('GET /payment-methods/{id}', () => {

  test.describe('Processing representation', () => {

    test('returns the minimal processing shape immediately after creation', async ({ api }) => {
      const created = await (await api.post('/payment-methods', { data: cardMethod() })).json();

      const res = await api.get(`/payment-methods/${created.id}`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      // Spec: initial GETs return only { id, status, created_at }.
      expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'status']);
      expectProcessingShape(body);
      expect(body.id).toBe(created.id);
    });
  });

  test.describe('Settled representation', () => {

    for (const type of CARD_TYPES) {
      test(`a ${type} method settles to active with masked card details`, async ({ api }) => {
        const created = await (await api.post('/payment-methods', { data: cardMethod(type) })).json();
        const settled = await waitForSettled(api, `/payment-methods/${created.id}`);

        // console.log(`Settled ${type} method: ${JSON.stringify(settled, null, 2)}`);

        expect(settled).toMatchObject({
          id: created.id,
          type,
          status: 'active',
          created_at: created.created_at,
          card: {
            brand: 'visa',
            last4: '1111',
            exp_month: 12,
            exp_year: 2030,
            holder_name: 'Imran Test',
          },
        });
      });
    }

    test('a sepa method settles to active with masked bank details', async ({ activeSepaMethod }) => {
      expect(activeSepaMethod).toMatchObject({
        type: 'sepa',
        status: 'active',
        sepa: {
          holder_name: 'Imran Test',
          country: 'DE',
          iban_last4: '3000',
        },
      });
      expect(activeSepaMethod).not.toHaveProperty('card');
    });

    test('a card method carries no sepa block', async ({ activeCardMethod }) => {
      expect(activeCardMethod).not.toHaveProperty('sepa');
    });

    test('created_at is a valid ISO 8601 timestamp', async ({ activeCardMethod }) => {
      expect(activeCardMethod.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(activeCardMethod.created_at).toString()).not.toBe('Invalid Date');
    });

    test('created_at does not change between processing and active', async ({ api }) => {
      const created = await (await api.post('/payment-methods', { data: cardMethod() })).json();
      const settled = await waitForSettled(api, `/payment-methods/${created.id}`);

      expect(settled.created_at).toBe(created.created_at);
    });

    test('the settled representation is stable across repeated reads', async ({ activeCardMethod, api }) => {
      const a = await (await api.get(`/payment-methods/${activeCardMethod.id}`)).json();
      const b = await (await api.get(`/payment-methods/${activeCardMethod.id}`)).json();

      expect(a).toEqual(b);
    });
  });

  test.describe('Async processing', () => {

    test('reaches a terminal state within the polling ceiling', async ({ api }) => {
      // Not an SLA assertion — a canary for a resource stuck in `processing`.
      // Observed settle time is ~2.4s median, 3.4s worst over 8 samples.
      const created = await (await api.post('/payment-methods', { data: cardMethod() })).json();

      const start = Date.now();
      const settled = await waitForSettled(api, `/payment-methods/${created.id}`);
      const elapsed = Date.now() - start;

      expect(settled.status).toBe('active');
      expect(elapsed).toBeLessThan(SETTLE_TIMEOUT);
    });

    test('a declining card still settles to active', async ({ decliningCardMethod }) => {
      // The decline trigger applies to payments, not to method registration.
      expect(decliningCardMethod).toMatchObject({
        status: 'active',
        card: { last4: '0002' },
      });
    });
  });

  test.describe('Sensitive data is never returned', () => {

    test('no full PAN or cvc appears in the response', async ({ api }) => {
      const created = await (await api.post('/payment-methods', { data: cardMethod() })).json();
      const settled = await waitForSettled(api, `/payment-methods/${created.id}`);

      const raw = JSON.stringify(settled);
      expect(raw, 'full card number must not be returned').not.toContain(CARDS.visa);
      expect(settled.card).not.toHaveProperty('number');
      expect(settled.card).not.toHaveProperty('cvc');
    });

    test('no full iban appears in the response', async ({ activeSepaMethod }) => {
      expect(JSON.stringify(activeSepaMethod)).not.toContain(IBANS.valid);
      expect(activeSepaMethod.sepa).not.toHaveProperty('iban');
      expect(activeSepaMethod.sepa).not.toHaveProperty('bic');
    });
  });

  test.describe('Negative', () => {

    const notFoundCases: Array<[string, string]> = [
      ['an unknown but well-formed id', 'pm_0000000000000000000000000000'],
      ['a malformed id', 'not-an-id'],
      ['a payment id on the payment-method route', 'pay_0000000000000000000000000000'],
      ['a numeric id', '12345'],
    ];

    for (const [label, id] of notFoundCases) {
      test(`returns 404 for ${label}`, async ({ api }) => {
        const res = await api.get(`/payment-methods/${id}`);
        await expectApiError(res, 404, 'not_found');
      });
    }

    test('returns 401 without an api key', async ({ unauthApi, activeCardMethod }) => {
      const res = await unauthApi.get(`/payment-methods/${activeCardMethod.id}`);
      await expectApiError(res, 401, 'invalid_api_key');
    });

    test('returns 401 with an unknown api key', async ({ api, activeCardMethod }) => {
      const res = await api.get(`/payment-methods/${activeCardMethod.id}`, {
        headers: { 'X-Api-Key': 'key_not_a_real_key' },
      });
      await expectApiError(res, 401, 'invalid_api_key');
    });

    test('auth is checked before existence', async ({ unauthApi }) => {
      // A missing key on a non-existent resource should still be 401, not 404 —
      // otherwise the API leaks which ids exist to unauthenticated callers.
      const res = await unauthApi.get('/payment-methods/pm_0000000000000000000000000000');
      await expectApiError(res, 401, 'invalid_api_key');
    });
  });
});