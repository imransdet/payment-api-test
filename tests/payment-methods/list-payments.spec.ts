import { test, expect } from '../fixtures/data.fixture';
import { paymentPayload, cardBlock } from '../support/data';
import { expectApiError, waitForSettled } from '../support/helpers';

test.describe('GET /payment-methods/{id}/payments', () => {

  test.describe('Happy path', () => {

    test('returns an empty data array for a method with no payments', async ({ api, activeCardMethod }) => {
      const res = await api.get(`/payment-methods/${activeCardMethod.id}/payments`);

      expect(res.status()).toBe(200);
      const body = await res.json();
      // Spec: the response object requires a `data` array.
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(0);
    });

    test('returns one entry after a single payment', async ({ api, activeCardMethod }) => {
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      const res = await api.get(`/payment-methods/${activeCardMethod.id}/payments`);
      const body = await res.json();

      expect(body.data).toHaveLength(1);
    });

    test('returns every payment created with the method', async ({ api, activeCardMethod }) => {
      const amounts = [100, 200, 300];
      for (const amount of amounts) {
        await api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount }) });
      }

      const res = await api.get(`/payment-methods/${activeCardMethod.id}/payments`);
      const body = await res.json();

      expect(body.data).toHaveLength(3);
    });

    test('lists payments oldest first', async ({ api, activeCardMethod }) => {
      // Spec: "Returns every payment created with this payment method, oldest first."
      for (const amount of [100, 200, 300]) {
        await api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount }) });
      }

      const body = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const timestamps = body.data.map((p: any) => new Date(p.created_at).getTime());
      const sorted = [...timestamps].sort((a, b) => a - b);

      expect(timestamps).toEqual(sorted);
    });

    test('does not include payments made with a different method', async ({ api, activeCardMethod, activeSepaMethod }) => {
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount: 111 }) });
      await api.post('/payments', { data: paymentPayload(activeSepaMethod.id, { amount: 222 }) });

      const cardList = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const sepaList = await (await api.get(`/payment-methods/${activeSepaMethod.id}/payments`)).json();

      expect(cardList.data).toHaveLength(1);
      expect(sepaList.data).toHaveLength(1);
      expect(cardList.data[0].amount).toBe(111);
      expect(sepaList.data[0].amount).toBe(222);
    });

    test('every entry references the parent payment method', async ({ api, activeCardMethod }) => {
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      const body = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();

      for (const payment of body.data) {
        expect(payment.payment_method_id).toBe(activeCardMethod.id);
      }
    });

    test('entries settle from processing to a terminal state', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();

      const early = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      expect(early.data[0].status).toBe('processing');

      await waitForSettled(api, `/payments/${created.id}`);

      const late = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      expect(['succeeded', 'failed']).toContain(late.data[0].status);
    });

    test('preserves holder_name intact', async ({ api }) => {
      // Contrast with DEFECT-2: this endpoint returns holder_name correctly.
      const holder_name = 'Imran Test';
      const method = await (await api.post('/payment-methods', {
        data: { type: 'adyen', card: cardBlock({ holder_name }) },
      })).json();
      await waitForSettled(api, `/payment-methods/${method.id}`);

      const created = await (await api.post('/payments', { data: paymentPayload(method.id) })).json();
      await waitForSettled(api, `/payments/${created.id}`);

      const body = await (await api.get(`/payment-methods/${method.id}/payments`)).json();
      expect(body.data[0].holder_name).toBe(holder_name);
    });
  });

  test.describe('Listed id integrity', () => {

    // DEFECT-1: this endpoint returns a payment `id` that matches no retrievable
    // payment. Every other field — payment_method_id, amount, currency, status
    // and created_at to the millisecond — matches the created payment exactly,
    // so the record is correct and only the id is wrong. Reproduced across
    // multiple runs at a 100% rate. A client cannot fetch the detail of a
    // payment it has just listed, which breaks reconciliation.
    // These tests are expected to fail until the defect is fixed.

    test('the listed id matches the id returned by POST /payments [DEFECT-1]', async ({ api, activeCardMethod }) => {
      const created = await (await api.post('/payments', {
        data: paymentPayload(activeCardMethod.id),
      })).json();

      const body = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();

      expect(body.data).toHaveLength(1);
      expect(
        body.data[0].id,
        'the listed payment id should match the id returned on creation',
      ).toBe(created.id);
    });

    test('a listed payment can be fetched by its own id [DEFECT-1]', async ({ api, activeCardMethod }) => {
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      const body = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const listedId = body.data[0].id;

      const res = await api.get(`/payments/${listedId}`);
      expect(
        res.status(),
        `payment ${listedId} was listed but cannot be retrieved`,
      ).toBe(200);
    });

    test('every listed id is retrievable [DEFECT-1]', async ({ api, activeCardMethod }) => {
      const createdIds: string[] = [];
      for (const amount of [100, 200, 300]) {
        const res = await api.post('/payments', { data: paymentPayload(activeCardMethod.id, { amount }) });
        createdIds.push((await res.json()).id);
      }

      const body = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const listedIds = body.data.map((p: any) => p.id);

      expect(listedIds.sort()).toEqual(createdIds.sort());
    });

    test('listed ids are stable across repeated reads [DEFECT-1]', async ({ api, activeCardMethod }) => {
      // If the id is generated per response rather than stored, two reads of an
      // unchanged resource will disagree.
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      const first = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();
      const second = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();

      expect(second.data[0].id).toBe(first.data[0].id);
    });

    test('listed ids use the payment id prefix', async ({ api, activeCardMethod }) => {
      await api.post('/payments', { data: paymentPayload(activeCardMethod.id) });

      const body = await (await api.get(`/payment-methods/${activeCardMethod.id}/payments`)).json();

      expect(body.data[0].id).toMatch(/^pay_[0-9a-f]{32}$/);
    });
  });

  test.describe('Negative', () => {

    const notFoundCases: Array<[string, string]> = [
      ['an unknown but well-formed id', 'pm_0000000000000000000000000000'],
      ['a malformed id', 'not-an-id'],
      ['a payment id on the payment-method route', 'pay_0000000000000000000000000000'],
    ];

    for (const [label, id] of notFoundCases) {
      test(`returns 404 for ${label}`, async ({ api }) => {
        const res = await api.get(`/payment-methods/${id}/payments`);
        await expectApiError(res, 404, 'not_found');
      });
    }

    test('returns 401 without an api key', async ({ unauthApi, activeCardMethod }) => {
      const res = await unauthApi.get(`/payment-methods/${activeCardMethod.id}/payments`);
      await expectApiError(res, 401, 'invalid_api_key');
    });

    test('auth is checked before existence', async ({ unauthApi }) => {
      const res = await unauthApi.get('/payment-methods/pm_0000000000000000000000000000/payments');
      await expectApiError(res, 401, 'invalid_api_key');
    });
  });
});