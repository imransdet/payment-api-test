import { test, expect } from '../fixtures/api.fixture';
import { CARDS, IBANS, BICS, CARD_TYPES, cardBlock, cardMethod, sepaMethod } from '../support/data';
import { expectApiError, expectProcessingShape, waitForSettled } from '../support/helpers';

test.describe('POST /payment-methods', () => {

  test.describe('Happy path', () => {

    for (const type of CARD_TYPES) {
      test(`creates a ${type} card method and returns 201 processing`, async ({ api }) => {
        const res = await api.post('/payment-methods', { data: cardMethod(type) });

        // console.log(`Output of ${type}: ${JSON.stringify(await res.json(), null, 2)}`);

        expect(res.status()).toBe(201);
        expectProcessingShape(await res.json());
      });
    }

    test('creates a sepa method and returns 201 processing', async ({ api }) => {
      const res = await api.post('/payment-methods', { data: sepaMethod() });

      //console.log(`Output of sepa: ${JSON.stringify(await res.json(), null, 2)}`);

      expect(res.status()).toBe(201);
      expectProcessingShape(await res.json());
    });

    test('accepts an optional 8-character bic', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        data: sepaMethod({ bic: BICS.short }),
      });

    // console.log(`Output of sepa with 8-char bic: ${JSON.stringify(await res.json(), null, 2)}`);

      expect(res.status()).toBe(201);
    });

    test('accepts an optional 11-character bic', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        data: sepaMethod({ bic: BICS.long }),
      });

      expect(res.status()).toBe(201);
    });

    test('accepts an iban containing spaces', async ({ api }) => {
      // Spec: "checksum-valid IBAN; spaces allowed"
      const res = await api.post('/payment-methods', {
        data: sepaMethod({ iban: IBANS.spaced }),
      });

      expect(res.status()).toBe(201);
    });

    test('returns a unique id per creation', async ({ api }) => {
      const [a, b] = await Promise.all([
        api.post('/payment-methods', { data: cardMethod() }),
        api.post('/payment-methods', { data: cardMethod() }),
      ]);

      const idA = (await a.json()).id;
      const idB = (await b.json()).id;

      expect(idA).not.toBe(idB);
    });
  });

  test.describe('Card data is never echoed back', () => {

    test('the creation response contains no card fields at all', async ({ api }) => {
      const res = await api.post('/payment-methods', { data: cardMethod() });
      const body = await res.json();

      expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'status']);
    });

    test('the settled representation exposes only brand and last4', async ({ api }) => {
      // Spec: "Full card numbers, CVCs and IBANs are never returned by any endpoint."
      const { id } = await (await api.post('/payment-methods', { data: cardMethod() })).json();
      const settled = await waitForSettled(api, `/payment-methods/${id}`);

      // console.log(`Settled card method: ${JSON.stringify(settled, null, 2)}`);

      const raw = JSON.stringify(settled);
      expect(raw, 'full PAN must not be returned').not.toContain(CARDS.visa);
      expect(raw, 'cvc must not be returned').not.toContain('123');

      expect(settled.card).toMatchObject({
        brand: 'visa',
        last4: '1111',
      });
      expect(settled.card).not.toHaveProperty('number');
      expect(settled.card).not.toHaveProperty('cvc');
    });

    test('the settled sepa representation exposes only country and iban_last4', async ({ api }) => {
      const { id } = await (await api.post('/payment-methods', { data: sepaMethod() })).json();
      const settled = await waitForSettled(api, `/payment-methods/${id}`);

      console.log(`Settled sepa method: ${JSON.stringify(settled, null, 2)}`);
      
      expect(JSON.stringify(settled)).not.toContain(IBANS.valid);
      expect(settled.sepa).toMatchObject({
        holder_name: 'Imran Test',
        country: 'DE',
        iban_last4: '3000',
      });
      expect(settled.sepa).not.toHaveProperty('iban');
    });
  });

  test.describe('Negative — type and schema selection', () => {

    const schemaCases: Array<[string, Record<string, unknown>]> = [
      ['type is missing', { card: cardBlock() }],
      ['type is unknown', { type: 'stripe', card: cardBlock() }],
      ['type is null', { type: null, card: cardBlock() }],
      ['adyen without a card block', { type: 'adyen' }],
      ['checkout without a card block', { type: 'checkout' }],
      ['sepa without a sepa block', { type: 'sepa' }],
      ['adyen carrying a sepa block', { type: 'adyen', sepa: { holder_name: 'X', iban: IBANS.valid } }],
      ['sepa carrying a card block', { type: 'sepa', card: cardBlock() }],
      ['both blocks present', { type: 'adyen', card: cardBlock(), sepa: { holder_name: 'X', iban: IBANS.valid } }],
    ];

    for (const [label, payload] of schemaCases) {
      test(`rejects when ${label}`, async ({ api }) => {
        const res = await api.post('/payment-methods', { data: payload });
        await expectApiError(res, 422, 'schema_mismatch');
      });
    }
  });

  test.describe('Negative — card field validation', () => {

    const cardCases: Array<[string, Record<string, unknown>, string]> = [
      ['holder_name is empty', { holder_name: '' }, 'invalid_holder_name'],
      ['holder_name is null', { holder_name: null }, 'invalid_holder_name'],
      ['holder_name is missing', { holder_name: undefined }, 'invalid_holder_name'],
      ['number fails the Luhn check', { number: '4111111111111112' }, 'invalid_card_number'],
      ['number is non-numeric', { number: 'abcdefghijklmnop' }, 'invalid_card_number'],
      ['number is too short', { number: '41111' }, 'invalid_card_number'],
      ['number is empty', { number: '' }, 'invalid_card_number'],
      ['exp_month is 0', { exp_month: 0 }, 'card_expired'],
      ['exp_month is 13', { exp_month: 13 }, 'card_expired'],
      ['exp_year is in the past', { exp_year: 2020 }, 'card_expired'],
      ['exp_year is two digits', { exp_year: 30 }, 'card_expired'],
      ['cvc is too short', { cvc: '12' }, 'invalid_cvc'],
      ['cvc is too long', { cvc: '12345' }, 'invalid_cvc'],
      ['cvc contains letters', { cvc: 'abc' }, 'invalid_cvc'],
      ['cvc is missing', { cvc: undefined }, 'invalid_cvc'],
    ];

    for (const [label, override, code] of cardCases) {
      test(`rejects when ${label}`, async ({ api }) => {
        const card = cardBlock(override);
        // `undefined` values are dropped during JSON serialisation, which is
        // how the "missing field" cases are expressed.
        const res = await api.post('/payment-methods', { data: { type: 'adyen', card } });
        await expectApiError(res, 422, code);
      });
    }
  });

  test.describe('Negative — sepa field validation', () => {

    const sepaCases: Array<[string, Record<string, unknown>, string]> = [
      ['holder_name is empty', { holder_name: '' }, 'invalid_holder_name'],
      ['iban has a bad checksum', { iban: 'DE89370400440532013099' }, 'invalid_iban'],
      ['iban is too short', { iban: 'DE89' }, 'invalid_iban'],
      ['iban is not an iban', { iban: 'not-an-iban' }, 'invalid_iban'],
      ['iban is empty', { iban: '' }, 'invalid_iban'],
      ['iban is missing', { iban: undefined }, 'invalid_iban'],
      ['bic is 7 characters', { bic: 'DEUTDEF' }, 'invalid_bic'],
      ['bic is 9 characters', { bic: 'DEUTDEFF5' }, 'invalid_bic'],
      ['bic is lowercase', { bic: 'deutdeff' }, 'invalid_bic'],
      ['bic is digits only', { bic: '12345678' }, 'invalid_bic'],
    ];

    for (const [label, override, code] of sepaCases) {
      test(`rejects when ${label}`, async ({ api }) => {
        const res = await api.post('/payment-methods', { data: sepaMethod(override) });
        await expectApiError(res, 422, code);
      });
    }
  });

  test.describe('Negative — protocol level', () => {

    test('rejects a malformed json body with 400', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        headers: { 'Content-Type': 'application/json' },
        data: Buffer.from('{ "type": "adyen", '),
      });
      await expectApiError(res, 400, 'invalid_json');
    });

    test('rejects an empty body with 400', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        headers: { 'Content-Type': 'application/json' },
        data: Buffer.from(''),
      });
      await expectApiError(res, 400, 'invalid_json');
    });

    test('rejects a non-json content-type with 415', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        headers: { 'Content-Type': 'text/plain' },
        data: Buffer.from('hello'),
      });
      await expectApiError(res, 415, 'unsupported_media_type');
    });

    test('rejects a body over 1 MiB with 413', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        headers: { 'Content-Type': 'application/json' },
        data: Buffer.from(JSON.stringify({
          type: 'adyen',
          card: cardBlock({ holder_name: 'x'.repeat(2_000_000) }),
        })),
      });
      await expectApiError(res, 413, 'payload_too_large');
    });

    test('rejects a request with no api key with 401', async ({ unauthApi }) => {
      const res = await unauthApi.post('/payment-methods', { data: cardMethod() });
      await expectApiError(res, 401, 'invalid_api_key');
    });

    test('rejects a request with an unknown api key with 401', async ({ api }) => {
      const res = await api.post('/payment-methods', {
        headers: { 'X-Api-Key': 'key_not_a_real_key' },
        data: cardMethod(),
      });
      await expectApiError(res, 401, 'invalid_api_key');
    });
  });
});