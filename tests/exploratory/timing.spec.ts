import { test } from '../fixtures/api.fixture';
import type { APIRequestContext } from '@playwright/test';

const POLL_MS = 250;
const SAMPLES = 8;

const validCard = () => ({
  holder_name: 'Imran Test',
  number: '4111111111111111',
  exp_month: 12,
  exp_year: 2027,
  cvc: '123',
});

/** Returns ms elapsed from creation until the resource left `processing`. */
async function timeToSettle(api: APIRequestContext, path: string, startedAt: number): Promise<number> {
  for (let i = 0; i < 120; i++) {
    const res = await api.get(path);
    const body = await res.json();
    if (body.status !== 'processing') return Date.now() - startedAt;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return -1;
}

function stats(label: string, values: number[]): void {
  const ok = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!ok.length) { console.log(`${label}: no samples settled`); return; }
  const p95 = ok[Math.min(ok.length - 1, Math.ceil(ok.length * 0.95) - 1)];
  console.log(
    `${label.padEnd(18)} n=${ok.length}`,
    `min=${ok[0]}ms`,
    `median=${ok[Math.floor(ok.length / 2)]}ms`,
    `p95=${p95}ms`,
    `max=${ok[ok.length - 1]}ms`,
  );
  console.log(`  raw: ${ok.join(', ')}`);
}

test('measure: time to terminal state', async ({ api }) => {
  test.setTimeout(180_000);

  const pmTimes: number[] = [];
  const payTimes: number[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    // Payment method: processing -> active
    const t0 = Date.now();
    const pmRes = await api.post('/payment-methods', { data: { type: 'adyen', card: validCard() } });
    const pm = await pmRes.json();
    pmTimes.push(await timeToSettle(api, `/payment-methods/${pm.id}`, t0));

    // Payment: processing -> succeeded
    const t1 = Date.now();
    const payRes = await api.post('/payments', {
      data: { payment_method_id: pm.id, amount: 1000, currency: 'EUR' },
    });
    const pay = await payRes.json();
    payTimes.push(await timeToSettle(api, `/payments/${pay.id}`, t1));
  }

  console.log('\n=== TIME TO TERMINAL STATE ===');
  stats('payment method', pmTimes);
  stats('payment', payTimes);
  console.log(`\npoll interval used: ${POLL_MS}ms (resolution is ±${POLL_MS}ms)`);
});