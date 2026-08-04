// Canonical payloads and test constants, got from openapi.yaml.

export const CARDS = {
  visa: '4111111111111111',
  mastercard: '5555555555554444',
  amex: '378282246310005',
  // Unrecognised brand → expect brand: "other"
  other: '6011111111111117',
  // Documented decline trigger → failed / card_declined
  declined: '4000000000000002',
} as const;

export const IBANS = {
  valid: 'DE89370400440532013000',
  // Spec: "checksum-valid IBAN; spaces allowed"
  spaced: 'DE89 3704 0044 0532 0130 00',
  // Documented decline trigger → failed / debit_declined
  declined: 'DE62370400440532013001',
} as const;

// Bank Identification Codes
export const BICS = {
  short: 'DEUTDEFF',
  long: 'DEUTDEFF500',
} as const;

export const CURRENCIES = ['EUR', 'USD', 'GBP'] as const;
export const CARD_TYPES = ['adyen', 'checkout'] as const;
export const ALL_TYPES = ['adyen', 'checkout', 'sepa'] as const;

export type CardType = (typeof CARD_TYPES)[number];

// Spec: amount is a positive integer in minor units, minimum 1, no documented maximum.
export const AMOUNTS = {
  minimum: 1,
  typical: 1000,
  large: 99_999_999,
  /** Accepted despite being ~€10bn — no upper bound is documented. */
  unbounded: 999_999_999_999,
} as const;

export const INVALID_AMOUNTS: Array<[string, unknown]> = [
  ['zero', 0],
  ['negative', -100],
  ['decimal', 10.5],
  ['numeric string', '1000'],
  ['null', null],
  ['boolean', true],
];

export const INVALID_CURRENCIES: Array<[string, unknown]> = [
  ['lowercase', 'eur'],
  ['unsupported code', 'XYZ'],
  ['too long', 'EURO'],
  ['empty', ''],
  ['numeric', 978],
];

// A valid card block. Overrides let negative tests mutate one field.
export function cardBlock(overrides: Record<string, unknown> = {}) {
  return {
    holder_name: 'Imran Test',
    number: CARDS.visa,
    exp_month: 12,
    // Far-future so the suite doesn't start failing on a calendar date.
    exp_year: 2030,
    cvc: '123',
    ...overrides,
  };
}

// A valid sepa block.
export function sepaBlock(overrides: Record<string, unknown> = {}) {
  return {
    holder_name: 'Imran Test',
    iban: IBANS.valid,
    ...overrides,
  };
}

export function cardMethod(type: CardType = 'adyen', card: Record<string, unknown> = {}) {
  return { type, card: cardBlock(card) };
}

export function sepaMethod(sepa: Record<string, unknown> = {}) {
  return { type: 'sepa', sepa: sepaBlock(sepa) };
}

export function paymentPayload(
  paymentMethodId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    payment_method_id: paymentMethodId,
    amount: AMOUNTS.typical,
    currency: 'EUR',
    ...overrides,
  };
}