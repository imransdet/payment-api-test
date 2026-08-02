import { test as apiTest, expect } from './api.fixture';
import { cardMethod, sepaMethod, paymentPayload, CARDS, IBANS } from '../support/data';
import { createActiveMethod, createSettledPayment } from '../support/helpers';

/** Settled payment method as returned by GET /payment-methods/{id}. */
export type PaymentMethod = {
  id: string;
  type: 'adyen' | 'checkout' | 'sepa';
  status: 'active';
  created_at: string;
  card?: {
    brand: 'visa' | 'mastercard' | 'amex' | 'other';
    last4: string;
    exp_month: number;
    exp_year: number;
    holder_name: string;
  };
  sepa?: {
    holder_name: string;
    country: string;
    iban_last4: string;
  };
};

/** Settled payment as returned by GET /payments/{id}. */
export type Payment = {
  id: string;
  payment_method_id: string;
  holder_name: string;
  amount: number;
  currency: 'EUR' | 'USD' | 'GBP';
  status: 'succeeded' | 'failed';
  failure_reason?: 'card_declined' | 'debit_declined';
  created_at: string;
};

type DataFixtures = {
  activeCardMethod: PaymentMethod;
  activeSepaMethod: PaymentMethod;
  decliningCardMethod: PaymentMethod;
  decliningSepaMethod: PaymentMethod;
  succeededPayment: { payment: Payment; method: PaymentMethod };
};

export const test = apiTest.extend<DataFixtures>({
  activeCardMethod: async ({ api }, use) => {
    await use(await createActiveMethod(api, cardMethod()));
  },

  activeSepaMethod: async ({ api }, use) => {
    await use(await createActiveMethod(api, sepaMethod()));
  },

  decliningCardMethod: async ({ api }, use) => {
    await use(await createActiveMethod(api, cardMethod('adyen', { number: CARDS.declined })));
  },

  decliningSepaMethod: async ({ api }, use) => {
    await use(await createActiveMethod(api, sepaMethod({ iban: IBANS.declined })));
  },

  succeededPayment: async ({ api }, use) => {
    const method = await createActiveMethod(api, cardMethod());
    const payment = await createSettledPayment(api, paymentPayload(method.id));
    await use({ payment, method });
  },
});

export { expect };