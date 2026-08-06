import console, { log } from 'node:console';
import { test, expect } from '../fixtures/api.fixture';
import { CARDS, IBANS, BICS, CARD_TYPES, cardBlock, cardMethod, sepaMethod } from '../support/data';
import { expectApiError, expectProcessingShape, waitForSettled } from '../support/helpers';

test.describe('POST /payments', () => {

    test('Create Payment and check success status', async ({api}) => {
        const created = await (await api.post('/payment-methods', {data: cardMethod()})).json();

        const waitForSuccessStatus = await waitForSettled(api, `/payment-methods/${created.id}`);
        console.log(`Success Status: ${JSON.stringify(waitForSuccessStatus, null, 2)}`);
        

        const getSuccessStatus = await api.get (`/payment-methods/${created.id}`);
        expect(getSuccessStatus.status()).toBe(200);

        expect(waitForSuccessStatus).toMatchObject({
            id: created.id,
            type: "adyen",
            status: "active",
            created_at: created.created_at,
            card: {
                brand: "visa",
                last4: "1111",
                exp_month: 12,
                exp_year: 2030,
                holder_name: "Imran Test"
            }
        });

        expect(waitForSuccessStatus).toMatchObject({
            status: 'active',
            type: 'adyen',
            id: created.id,

            card: {
                brand: 'visa',
                last4: '1111'
            }
        });

    

       

    });




});

