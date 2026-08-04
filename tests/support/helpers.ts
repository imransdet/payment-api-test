import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { PaymentMethod, Payment } from '../fixtures/data.fixture';

/**
 * Observed settle time is ~2.4s median, 3.4s worst case over 8 samples.
 * 15s is ~4x worst case — absorbs cold starts without hanging a failing run.
 * 500ms intervals keep poll traffic well inside the 300 req/min limit.
 */

export const SETTLE_TIMEOUT = 15_000;
export const POLL_INTERVAL = 500;

const RATE_LIMIT_MAX_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 500;

/**
 * Wraps an API context so `get`/`post` retry on 429 with backoff instead of
 * failing the test. Defense-in-depth alongside the worker cap: that cap
 * only holds if nothing else shares the rate limit budget at the same time.
 * Any other status is returned untouched — only 429 triggers a retry, and
 * `Retry-After` is honoured when the API sends one.
 */
export function withRateLimitRetry(context: APIRequestContext): APIRequestContext {
  return new Proxy(context, {
    get(target, prop, receiver) {
      if (prop !== 'get' && prop !== 'post') return Reflect.get(target, prop, receiver);

      const original = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<any>;
      return async (...args: unknown[]) => {
        for (let attempt = 0; ; attempt++) {
          const res = await original.apply(target, args);
          if (res.status() !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) return res;

          const retryAfter = res.headers()['retry-after'];
          const delay = retryAfter ? Number(retryAfter) * 1000 : RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
        }
      };
    },
  }) as APIRequestContext;
}

/** Waits for a resource to leave `processing`, then returns its body. */
export async function waitForSettled(
  api: APIRequestContext,
  path: string,
): Promise<any> {
  await expect
    .poll(
      async () => {
        const res = await api.get(path);
        if (!res.ok()) return `http_${res.status()}`;
        return (await res.json()).status;
      },
      {
        timeout: SETTLE_TIMEOUT,
        intervals: [POLL_INTERVAL],
        message: `Resource at ${path} never left "processing"`,
      },
    )
    .not.toBe('processing');

  const res = await api.get(path);
  return res.json();
}

/** Creates a payment method and waits until it is `active`. Returns the body. */
export async function createActiveMethod(
  api: APIRequestContext,
  payload: Record<string, unknown>,
): Promise<PaymentMethod> {
  const res = await api.post('/payment-methods', { data: payload });
  expect(res.status(), 'payment method should be created').toBe(201);
  const { id } = await res.json();
  return waitForSettled(api, `/payment-methods/${id}`);
}

/** Creates a payment and waits until it is `succeeded` or `failed`. */
export async function createSettledPayment(
  api: APIRequestContext,
  payload: Record<string, unknown>,
): Promise<Payment> {
  const res = await api.post('/payments', { data: payload });
  expect(res.status(), 'payment should be created').toBe(201);
  const { id } = await res.json();
  return waitForSettled(api, `/payments/${id}`);
}

/** Asserts the documented error envelope: { error: { code, message } }. */
export async function expectApiError(
  res: { status(): number; json(): Promise<any> },
  status: number,
  code: string,
): Promise<void> {
  expect(res.status()).toBe(status);
  const body = await res.json();
  expect(body).toMatchObject({
    error: {
      code,
      message: expect.any(String),
    },
  });
}

/** Asserts the minimal processing representation from the spec. */
export function expectProcessingShape(body: any): void {
  expect(body).toMatchObject({
    id: expect.any(String),
    status: 'processing',
    created_at: expect.any(String),
  });
  expect(new Date(body.created_at).toString()).not.toBe('Invalid Date');
}