import console, { log } from 'node:console';
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
import { describe } from 'node:test';

test.describe('GET /payments/{id}', () => {

    test('GET success payment status', async ({api, activeCardMethod}) => {
        /* const resp = await api.post('/payment-methods', {data: cardMethod()});
        expect(resp.status()).toBe(201);

        const respBody = await resp.json();
        // console.log(`Created payment method: ${JSON.stringify(respBody, null, 2)}`);

        const successPmRes = await waitForSettled(api, `/payment-methods/${respBody.id}`);
        // console.log(`Settled payment method: ${JSON.stringify(successPmRes, null, 2)}`);

        expect(successPmRes).toMatchObject({
            id: respBody.id,
            type: "adyen",
            status: "active",
            created_at: respBody.created_at,
            card: {
                brand: "visa",
                last4: "1111",
                exp_month: 12,
                exp_year: 2030,
                holder_name: "Imran Test"
            }
        });*/

        const respCreatePayment = await api.post('/payments', {
            data: paymentPayload(activeCardMethod.id)
        });

        expect(respCreatePayment.status()).toBe(201);
        const respCreatePaymentBody = await respCreatePayment.json();
        // console.log(`Created payment: ${JSON.stringify(respCreatePaymentBody, null, 2)}`);

        const settledRes = await waitForSettled(api, `/payments/${respCreatePaymentBody.id}`);
        // console.log(`Settled payment: ${JSON.stringify(settledRes, null, 2)}`);

        expect(settledRes).toMatchObject({
            id: respCreatePaymentBody.id,
            payment_method_id: activeCardMethod.id,
            // holder_name: "Imran Test",
            amount: 1000,
            currency: "EUR",
            status: "succeeded",
            created_at: respCreatePaymentBody.created_at
        });



    });

});


describe('GET /payment-methods/{id}/payments', () => {
    test('Get payments under PM', async ({api, activeCardMethod}) => {

        const payload = paymentPayload(activeCardMethod.id);

        const createPayment = await api.post('/payments', {data: payload});
        expect(createPayment.status()).toBe(201);

        const cpBody = await createPayment.json();
        console.log(`Created Payment ${JSON.stringify(cpBody, null, 2)}`);
        
        const resSettledPayment = await waitForSettled(api, `/payments/${cpBody.id}`);

        const respGetPayments = await api.get(`/payment-methods/${activeCardMethod.id}/payments`);
        const body = await respGetPayments.json();

        // console.log(`Payments against PM ${JSON.stringify(await respGetPayments.json(), null, 2)}`);

        expect(body).toMatchObject({
            data: [
                {
                    id: cpBody.id,
                    payment_method_id: activeCardMethod.id,
                    amount: payload.amount,
                    currency: payload.currency,
                    status: "succeeded",
                    created_at: cpBody.created_at
                }
            ]
        });
    });
});