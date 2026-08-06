import console, { log } from 'node:console';
import { test, expect } from '../fixtures/api.fixture';
import { CARDS, IBANS, BICS, CARD_TYPES, cardBlock, cardMethod, sepaMethod } from '../support/data';
import { expectApiError, expectProcessingShape, waitForSettled } from '../support/helpers';

test.describe('POST /payment-methods', () => {
    test('create payment method with adyen', async ({api}) => {
        
        const res = await api.post('/payment-methods', {data: cardMethod()});
        console.log(`Method Created: ${JSON.stringify(await res.json(), null, 2)}`);

        expect(res.status()).toBe(201);

        expectProcessingShape(await res.json());

        const body = await res.json();

        expect(body.status).toBe('processing');
        expect(typeof body.id).toBe('string');
        // typeof only proves it's a string — this proves it follows the pm_<32 hex chars> format,
        // e.g. pm_951fe876c1fa4d14bce66821476ef9f5
        expect(body.id).toMatch(/^pm_[0-9a-f]{32}$/);
        expect(typeof body.created_at).toBe('string');

        // typeof only proves it's a string — this proves it actually parses as a date.
        expect(new Date(body.created_at).toString()).not.toBe('Invalid Date');

    });
}); 


test.describe('POST /payment-methods', () => {


    test('Create payment method with SEPA', async ({api}) => {

        const resp = await api.post('/payment-methods', {data: sepaMethod()});

        console.log(`Payment method with SEPA: ${JSON.stringify(await resp.json(), null, 2)}`);

        expect(resp.status()).toBe(201);

        const body = await resp.json();

        expect(body.status).toBe('processing');
        expect(typeof body.created_at).toBe('string');

    });

});

test.describe('POST ABC', () => {

    test('Create payment method with checkout error', async ({api}) => {


        const resp = await api.post('/payment-methods', {data: cardMethod()});

        // console.log(`Check error: ${JSON.stringify(await resp.json(), null, 2)}`);

        expect(resp.status()).toBe(422);

        const respBody = await resp.json();

        // console.log(`The JS object: ${JSON.stringify(respBody, null, 2)}`);
        

        expect(respBody.error.message).toBe('type must be one of: adyen, checkout, sepa.');

        expect(expectApiError(resp, 422, 'schema_mismatch'));

    });
});

test.describe('GET /payment-methods/:pmId', () => {

    test('Check processing status quick', async ({api}) => {
        const created = await (await api.post('/payment-methods', {data: cardMethod()})).json();
        console.log(`Created PM: ${JSON.stringify(created, null, 2)}`);

        const getResp = await api.get(`/payment-methods/${created.id}`);
        console.log(`GET Status ${JSON.stringify(await getResp.json(), null, 2)}`);
        expect(getResp.status()).toBe(200);
    });

    test('Check success status', async ({api}) => {

        const created = await (await api.post('/payment-methods', {data: sepaMethod()})).json();
        const resp = await waitForSettled(api, `/payment-methods/${created.id}`);

        const statusCodeChk = await api.get(`/payment-methods/${created.id}`);
        // const statusCodeChkBody = await statusCodeChk.json();

        expect(statusCodeChk.status()).toBe(200);
        console.log(`Success status: ${JSON.stringify(resp, null, 2)}`);

        expect(resp).toMatchObject({
            id: created.id,
            type: 'sepa',
            status: 'active',
            created_at: created.created_at,
            sepa: {
                holder_name: 'Imran Test',
                country: 'DE',
                iban_last4: '3000',
            },
            });

        // expect(statusCodeChkBody.type).toBe('sepa');
        // expect(statusCodeChkBody.status).toBe('active');
        // expect(statusCodeChkBody.id).toBe(created.id);
        // expect(statusCodeChkBody.created_at).toBe(created.created_at);

        // expect(statusCodeChkBody.sepa.holder_name).toBe('Imran Test');
        // expect(statusCodeChkBody.sepa.country).toBe('DE');
        // expect(statusCodeChkBody.sepa.iban_last4).toBe('3000');

    });
});