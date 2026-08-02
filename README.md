# Payment Simulation API — Test Suite

Automated API test suite for the Distribusion Payment Simulation API, built with
Playwright and TypeScript.

**Base URL:** `https://qa-interview-service.fly.dev`
**Contract:** `openapi.yaml` (OAS 3.1)

---

## Running the suite

```bash
npm install
cp .env.example .env      # then add your API key
npm test                  # full suite
npm run test:report       # open the HTML report
```

Run a single area:

```bash
npx playwright test tests/payment-methods
npx playwright test tests/payments
npx playwright test tests/e2e
```

**Two defects are documented as deliberately failing tests.** A fully green run
would mean the defects have been fixed. See `DEFECTS.md`.

---

## Summary of findings

| ID | Endpoint | Severity | Summary |
|----|----------|----------|---------|
| DEFECT-1 | `GET /payment-methods/{id}/payments` | High | Returns a payment `id` that matches no retrievable payment |
| DEFECT-2 | `GET /payments/{id}` | High | Returns `holder_name` with the final character removed |

Both are only visible by comparing the same record across endpoints. Each
endpoint is internally consistent and plausible in isolation; they disagree
with each other.

Three further observations are recorded as questions rather than defects — see
"Observations" below.

---

## Project structure

```
tests/
├── fixtures/
│   ├── api.fixture.ts        authenticated + unauthenticated request contexts
│   └── data.fixture.ts       provisions settled payment methods and payments
├── support/
│   ├── data.ts               payloads and test constants
│   ├── helpers.ts            polling, shared assertions
│   └── types.ts              typed restatement of the OpenAPI schemas
├── payment-methods/
│   ├── create.spec.ts        POST /payment-methods
│   ├── fetch.spec.ts         GET  /payment-methods/{id}
│   └── list-payments.spec.ts GET  /payment-methods/{id}/payments
├── payments/
│   ├── create.spec.ts        POST /payments
│   └── fetch.spec.ts         GET  /payments/{id}
├── e2e/
│   └── payment-flow.spec.ts  cross-endpoint lifecycle flows
└── exploratory/
    ├── discovery*.spec.ts    throwaway response recordings, no assertions
    ├── smoke.spec.ts         basic reachability check
    └── timing.spec.ts        measures settle-time stats (async handling, below)
```

`tests/exploratory/` is excluded from the default run via `testIgnore` in
`playwright.config.ts` — these are ad-hoc scripts kept for reference, not part
of the endpoint coverage described below.

One spec file per endpoint, plus an end-to-end file for behaviour that spans
several. Within each spec, tests are grouped by intent — happy path, settled
representation, negative cases, protocol-level errors — so a failure's location
in the report indicates what kind of thing broke.

---

## Testing strategy

### The documentation is the contract

Every assertion traces to a line in `openapi.yaml`. Where observed behaviour
diverges from the spec, the test asserts the **documented** behaviour and fails.
No test was adjusted to match a defect.

### Discovery before assertion

This is black-box testing: HTTP and documentation only. Before writing
assertions, a series of throwaway discovery specs recorded the actual responses
of every endpoint, every error path, and every documented error code.

That mattered. The API's initial responses return a minimal `processing`
representation, so the full response schema is not observable until a resource
settles. Writing assertions from the spec alone would have missed both defects
and produced tests that pass against the wrong representation.

The discovery specs are retained under `tests/exploratory/` for reference. They
contain no assertions and are excluded from the default run.

### Async handling

The spec documents asynchronous processing but gives no timing expectations, so
settle time was measured empirically:

| Resource | Median | p95 | Max (8 samples) |
|----------|--------|-----|-----------------|
| Payment method | 2401 ms | 3391 ms | 3391 ms |
| Payment | 2388 ms | 2455 ms | 2455 ms |

Polling is therefore configured at **15 s ceiling, 500 ms intervals** — roughly
four times the worst observed case. Fixed sleeps are not used anywhere.

Duration itself is never asserted; that would make the suite a performance test
against someone else's infrastructure. Instead, each async path asserts that a
terminal state is reached within the ceiling, which catches a resource stuck in
`processing` — a real failure mode for an async payment API.

### Rate limiting

The documented limit is 300 requests/minute per key. A full lifecycle test costs
roughly 12 requests. Workers are capped at 4 in `playwright.config.ts` to keep
the suite comfortably inside the limit. The limit itself is not tested, per the
brief.

### Test data

Fixed and deliberately chosen, not randomly generated:

- Reproducibility — a failure names the exact input that caused it.
- The API constrains it anyway. Card numbers must pass Luhn, IBANs must pass
  checksum, and the decline triggers are literal values from the docs.
- The inputs that find bugs are chosen, not stumbled into. DEFECT-2 was
  characterised as an off-by-one by sending names of increasing length in a
  controlled sequence — random data would have shown the symptom, not the rule.

Where variety is needed, the suite loops over a full named list rather than
sampling from it, so coverage is identical on every run.

### Isolation

Each test provisions its own data through fixtures and can run alone or in
parallel. No test depends on another's state or on execution order.

The cost is real: a payment method takes ~2.4 s to reach `active`, so setup
dominates runtime. At this scale that is an acceptable trade for the clarity.
If the suite grew substantially, the read-only specs would move to a
worker-scoped fixture that creates one method per worker and reuses it, keeping
isolation only for tests that create payments.

---

## Coverage

### Contract conformance
- Status codes and response shapes for all five endpoints
- The minimal `processing` representation versus the full settled representation
- All three payment method types (`adyen`, `checkout`, `sepa`)
- All four card brands (`visa`, `mastercard`, `amex`, `other`)
- All three currencies (`EUR`, `USD`, `GBP`)
- `created_at` format and immutability across state transitions
- Response stability across repeated reads

### Payment-specific behaviour
- Documented decline triggers for both card and SEPA, with correct
  `failure_reason`
- `failure_reason` present only on failed payments
- Amount and currency preserved through settlement, including on declines
- Multiple payments against one method, listed oldest first
- Payments correctly scoped to their own method

### Security properties
- Full PAN, CVC, IBAN and BIC never appear in any response
- Only `brand` + `last4` exposed for cards, `country` + `iban_last4` for SEPA
- Authentication checked before existence, so unauthenticated callers cannot
  enumerate valid IDs by status code

### Failure modes
- Every documented error code: `invalid_json` (400), `invalid_api_key` (401),
  `not_found` (404), `payload_too_large` (413), `unsupported_media_type` (415),
  and all 422 field codes
- Full error envelope asserted — `{ error: { code, message } }` — not just the
  status code
- Schema selection: wrong block for the type, both blocks, neither block
- Field validation: Luhn, expiry, CVC length, IBAN checksum, BIC format,
  amount type and sign, currency enum
- Malformed, empty and non-object JSON bodies

### Deliberately not tested
- **Rate limiting.** The brief asks not to exceed it.
- **Validation precedence.** When two fields are invalid, the spec does not say
  which error wins. Asserting either way would invent a contract. Each negative
  case therefore mutates a single field.
- **BIC persistence.** A BIC is validated on write but never returned by any
  endpoint, so black-box testing can prove it was accepted but not that it was
  stored. A coverage gap caused by the API surface, not by the suite.

---

## Observations (questions, not defects)

These do not violate the documented contract, but are worth review:

**No upper bound on `amount`.** The spec sets `minimum: 1` with no maximum, and
an amount of 999,999,999,999 minor units (~€10bn) is accepted. Intentional?

**Payments succeed against a method still `processing`.** The spec never
requires a method to be `active` before it can be charged, and such payments
settle to `succeeded`. Recorded so a future change in behaviour is visible.

**No idempotency mechanism.** Two identical `POST /payments` requests create two
distinct payments. No idempotency key is documented, so this is expected — but
duplicate-charge protection is usually a requirement for a payment API.

---

## If I had more time

- Contract testing directly against `openapi.yaml` with a schema validator, so
  the suite fails automatically when the API drifts from the spec, rather than
  relying on hand-written type definitions.
- A CI workflow with the HTML report published as an artifact.
- Concurrency testing around the async transition — several payments created
  against one method simultaneously while it is still processing.
- Response-time trending, to distinguish a genuine regression from a slow day.
