[← README](README.md)

# Test Plan — Distribusion Payment Simulation API

| | |
|---|---|
| **System under test** | Distribusion Payment Simulation API v1.0.0 |
| **Base URL** | `https://qa-interview-service.fly.dev` |
| **Contract** | `openapi.yaml` (OAS 3.1) |
| **Test type** | Black-box API testing — HTTP and documentation only |
| **Framework** | Playwright Test + TypeScript |
| **Author** | Imran Ali |

---

## 1. Scope

### 1.1 In scope

Five endpoints across two resources:

| # | Endpoint | Method | Resource |
|---|----------|--------|----------|
| 1 | `/payment-methods` | POST | Payment method |
| 2 | `/payment-methods/{id}` | GET | Payment method |
| 3 | `/payment-methods/{id}/payments` | GET | Payment method → payments |
| 4 | `/payments` | POST | Payment |
| 5 | `/payments/{id}` | GET | Payment |

Testing covers contract conformance, business logic, asynchronous state
transitions, security properties of the response payloads, and every documented
failure mode.

### 1.2 Out of scope, with rationale

| Excluded | Rationale |
|----------|-----------|
| Rate limiting (429) | The brief explicitly asks not to load or stress test beyond the limit |
| Performance / load testing | Not requested; the service is a shared remote instance |
| Validation precedence | When two fields are invalid the spec does not define which error wins. Asserting either way would invent a contract |
| BIC persistence | A BIC is validated on write but never returned by any endpoint. Black-box testing can prove acceptance, not storage |
| Internal state, DB, logs | No access — black box only |
| UI / Swagger page | Not part of the API contract |

---

## 2. Test strategy

### 2.1 Documentation as contract

Every assertion traces to a line in `openapi.yaml`. Where observed behaviour
diverges from the specification, the test asserts the **documented** behaviour
and is expected to fail. No test is adjusted to accommodate a defect.

### 2.2 Discovery before assertion

Because this is black-box testing and the API returns a minimal `processing`
representation on creation, the full response schema is not observable until a
resource settles. A discovery phase precedes assertion writing:

| Pass | Purpose |
|------|---------|
| 1 | Map the happy path across all five endpoints |
| 2 | Capture settled representations, decline paths, error envelopes |
| 3 | Reverse-engineer validation rules from 422 messages |
| 4 | SEPA and checkout lifecycles, race conditions, cross-type mismatches |
| 5 | BIC, card brands, truncation characterisation, 413 |
| 6 | Measure asynchronous settle time |

Discovery specs contain no assertions and are excluded from the default run.

### 2.3 Asynchronous handling

Settle time is undocumented, so it was measured empirically (n=8 per resource):

| Resource | Median | p95 | Max |
|----------|--------|-----|-----|
| Payment method | 2401 ms | 3391 ms | 3391 ms |
| Payment | 2388 ms | 2455 ms | 2455 ms |

**Polling configuration:** 15 s ceiling, 500 ms intervals — approximately 4×
worst observed case. No fixed sleeps anywhere in the suite.

Duration is never asserted, as that would make the suite a performance test
against third-party infrastructure. Each async path instead asserts that a
terminal state is reached within the ceiling — a canary for a resource stuck in
`processing`.

### 2.4 Test data

Fixed and deliberately chosen. Rationale:

- Reproducibility — a failure names the exact input that caused it
- The API constrains it regardless: Luhn-valid PANs, checksum-valid IBANs, and
  three literal decline triggers from the documentation
- Bug-finding inputs are selected, not stumbled into

Where variety is required the suite iterates the complete named list rather than
sampling, so coverage is identical on every run.

**Fixed values sourced from the documentation:**

| Constant | Value | Documented behaviour |
|----------|-------|---------------------|
| Declining card | `4000000000000002` | Payments end `failed` / `card_declined` |
| Declining IBAN | `DE62370400440532013001` | Payments end `failed` / `debit_declined` |
| Any Luhn-valid card | e.g. `4111111111111111` | Payments succeed |

### 2.5 Isolation and parallelism

Each test provisions its own data via fixtures; no test depends on another's
state or on execution order. Workers are capped at **4** so that poll traffic
stays inside the documented 300 requests/minute limit (a full lifecycle test
costs approximately 12 requests).

### 2.6 Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Async timing causes flakiness | Poll with generous ceiling; never sleep |
| Rate limit exceeded by parallelism | Worker cap of 4, 500 ms poll interval |
| Remote service unavailable | Suite fails fast with clear HTTP status in the message |
| Hardcoded expiry year ages out | `exp_year: 2030`, far future |
| Shared key contaminated by other runs | Assertions scoped to resources created within the test |

---

## 3. Test case matrix

**#** runs continuously across the whole matrix — 3.1 ends at 50, so 3.2 picks
up at 51, and so on through 159 at the end of 3.6.

**Link** points to the exact source line implementing the case. Parameterised
cases (a `for` loop generating several rows) share one source line, since
that's the one line of code that produces all of them.

**Automated:** every case below traces to a running Playwright test — see the
[Automation coverage](#automation-coverage) rollup after the matrix.

---

### 3.1 `POST /payment-methods` — Create a payment method

Spec file: `tests/payment-methods/create.spec.ts`

#### Happy path

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 1 | Create with `type: adyen` and a valid card block | 201, minimal processing shape | [L10](tests/payment-methods/create.spec.ts#L10) | Yes |
| 2 | Create with `type: checkout` and a valid card block | 201, minimal processing shape | [L10](tests/payment-methods/create.spec.ts#L10) | Yes |
| 3 | Create with `type: sepa` and a valid sepa block | 201, minimal processing shape | [L20](tests/payment-methods/create.spec.ts#L20) | Yes |
| 4 | Create sepa with an optional 8-character BIC | 201 | [L29](tests/payment-methods/create.spec.ts#L29) | Yes |
| 5 | Create sepa with an optional 11-character BIC | 201 | [L39](tests/payment-methods/create.spec.ts#L39) | Yes |
| 6 | Create sepa with an IBAN containing spaces | 201 — spec states spaces allowed | [L47](tests/payment-methods/create.spec.ts#L47) | Yes |
| 7 | Two concurrent creations | Distinct `id` values | [L56](tests/payment-methods/create.spec.ts#L56) | Yes |

#### Sensitive data handling

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 8 | Inspect creation response keys | Exactly `id`, `status`, `created_at` — no card data | [L71](tests/payment-methods/create.spec.ts#L71) | Yes |
| 9 | Inspect settled card representation | Only `brand` + `last4`; no `number`, no `cvc`, full PAN absent from body | [L78](tests/payment-methods/create.spec.ts#L78) | Yes |
| 10 | Inspect settled sepa representation | Only `country` + `iban_last4`; full IBAN absent from body | [L97](tests/payment-methods/create.spec.ts#L97) | Yes |

#### Negative — schema selection (expect 422 `schema_mismatch`)

| # | Scenario | Link | Automated |
|---|----------|------|-----------|
| 11 | `type` omitted | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 12 | `type` is an unknown value (`stripe`) | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 13 | `type` is `null` | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 14 | `type: adyen` with no `card` block | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 15 | `type: checkout` with no `card` block | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 16 | `type: sepa` with no `sepa` block | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 17 | `type: adyen` carrying a `sepa` block | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 18 | `type: sepa` carrying a `card` block | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |
| 19 | Both `card` and `sepa` blocks present | [L128](tests/payment-methods/create.spec.ts#L128) | Yes |

#### Negative — card field validation (expect 422)

| # | Scenario | Expected code | Link | Automated |
|---|----------|---------------|------|-----------|
| 20 | `holder_name` empty string | `invalid_holder_name` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 21 | `holder_name` null | `invalid_holder_name` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 22 | `holder_name` omitted | `invalid_holder_name` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 23 | `number` fails the Luhn check | `invalid_card_number` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 24 | `number` non-numeric | `invalid_card_number` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 25 | `number` shorter than 12 digits | `invalid_card_number` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 26 | `number` empty string | `invalid_card_number` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 27 | `exp_month` is 0 | `card_expired` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 28 | `exp_month` is 13 | `card_expired` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 29 | `exp_year` in the past | `card_expired` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 30 | `exp_year` given as two digits | `card_expired` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 31 | `cvc` shorter than 3 digits | `invalid_cvc` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 32 | `cvc` longer than 4 digits | `invalid_cvc` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 33 | `cvc` contains letters | `invalid_cvc` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |
| 34 | `cvc` omitted | `invalid_cvc` | [L156](tests/payment-methods/create.spec.ts#L156) | Yes |

#### Negative — sepa field validation (expect 422)

| # | Scenario | Expected code | Link | Automated |
|---|----------|---------------|------|-----------|
| 35 | `holder_name` empty | `invalid_holder_name` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 36 | IBAN with an invalid checksum | `invalid_iban` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 37 | IBAN too short | `invalid_iban` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 38 | IBAN is arbitrary text | `invalid_iban` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 39 | IBAN empty string | `invalid_iban` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 40 | IBAN omitted | `invalid_iban` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 41 | BIC of 7 characters | `invalid_bic` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 42 | BIC of 9 characters | `invalid_bic` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 43 | BIC in lowercase | `invalid_bic` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |
| 44 | BIC of digits only | `invalid_bic` | [L182](tests/payment-methods/create.spec.ts#L182) | Yes |

#### Negative — protocol level

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 45 | Malformed JSON body | 400 `invalid_json` | [L191](tests/payment-methods/create.spec.ts#L191) | Yes |
| 46 | Empty request body | 400 `invalid_json` | [L199](tests/payment-methods/create.spec.ts#L199) | Yes |
| 47 | `Content-Type: text/plain` | 415 `unsupported_media_type` | [L207](tests/payment-methods/create.spec.ts#L207) | Yes |
| 48 | Body exceeding 1 MiB | 413 `payload_too_large` | [L215](tests/payment-methods/create.spec.ts#L215) | Yes |
| 49 | No `X-Api-Key` header | 401 `invalid_api_key` | [L226](tests/payment-methods/create.spec.ts#L226) | Yes |
| 50 | Unknown `X-Api-Key` value | 401 `invalid_api_key` | [L231](tests/payment-methods/create.spec.ts#L231) | Yes |

---

### 3.2 `GET /payment-methods/{id}` — Fetch a payment method

Spec file: `tests/payment-methods/fetch.spec.ts`

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 51 | Fetch immediately after creation | 200, exactly `id` / `status: processing` / `created_at` | [L14](tests/payment-methods/fetch.spec.ts#L14) | Yes |
| 52 | Fetch an adyen method after settlement | 200, `status: active`, masked card block | [L31](tests/payment-methods/fetch.spec.ts#L31) | Yes |
| 53 | Fetch a checkout method after settlement | 200, `status: active`, masked card block | [L31](tests/payment-methods/fetch.spec.ts#L31) | Yes |
| 54 | Fetch a sepa method after settlement | 200, `status: active`, sepa block, no card block | [L51](tests/payment-methods/fetch.spec.ts#L51) | Yes |
| 55 | Card method response has no sepa block | `sepa` property absent | [L64](tests/payment-methods/fetch.spec.ts#L64) | Yes |
| 56 | `created_at` format | Valid ISO 8601 with milliseconds | [L68](tests/payment-methods/fetch.spec.ts#L68) | Yes |
| 57 | `created_at` compared before and after settlement | Unchanged | [L73](tests/payment-methods/fetch.spec.ts#L73) | Yes |
| 58 | Two successive reads of the same settled method | Identical bodies | [L80](tests/payment-methods/fetch.spec.ts#L80) | Yes |
| 59 | Time to reach `active` | Terminal state within the 15 s ceiling | [L90](tests/payment-methods/fetch.spec.ts#L90) | Yes |
| 60 | Register a method using the declining card | Still settles to `active` — the trigger applies to payments | [L103](tests/payment-methods/fetch.spec.ts#L103) | Yes |
| 61 | Full PAN and CVC search in the response body | Absent | [L114](tests/payment-methods/fetch.spec.ts#L114) | Yes |
| 62 | Full IBAN and BIC search in the response body | Absent | [L124](tests/payment-methods/fetch.spec.ts#L124) | Yes |
| 63 | Unknown but well-formed `pm_` id | 404 `not_found` | [L141](tests/payment-methods/fetch.spec.ts#L141) | Yes |
| 64 | Malformed id | 404 `not_found` | [L141](tests/payment-methods/fetch.spec.ts#L141) | Yes |
| 65 | A `pay_` id on the payment-method route | 404 `not_found` | [L141](tests/payment-methods/fetch.spec.ts#L141) | Yes |
| 66 | Numeric id | 404 `not_found` | [L141](tests/payment-methods/fetch.spec.ts#L141) | Yes |
| 67 | No API key | 401 `invalid_api_key` | [L147](tests/payment-methods/fetch.spec.ts#L147) | Yes |
| 68 | Unknown API key | 401 `invalid_api_key` | [L152](tests/payment-methods/fetch.spec.ts#L152) | Yes |
| 69 | No API key against a non-existent id | 401 before 404 — must not leak which ids exist | [L159](tests/payment-methods/fetch.spec.ts#L159) | Yes |

---

### 3.3 `GET /payment-methods/{id}/payments` — List a method's payments

Spec file: `tests/payment-methods/list-payments.spec.ts`

#### Happy path

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 70 | Method with no payments | 200, `data` present and empty | [L9](tests/payment-methods/list-payments.spec.ts#L9) | Yes |
| 71 | Method with one payment | `data` length 1 | [L20](tests/payment-methods/list-payments.spec.ts#L20) | Yes |
| 72 | Method with three payments | `data` length 3 | [L29](tests/payment-methods/list-payments.spec.ts#L29) | Yes |
| 73 | Ordering of multiple payments | Oldest first, per the spec | [L41](tests/payment-methods/list-payments.spec.ts#L41) | Yes |
| 74 | Two methods each with one payment | Each list contains only its own payment | [L54](tests/payment-methods/list-payments.spec.ts#L54) | Yes |
| 75 | `payment_method_id` on each entry | Matches the parent method | [L67](tests/payment-methods/list-payments.spec.ts#L67) | Yes |
| 76 | List before and after settlement | Entries transition `processing` → terminal | [L78](tests/payment-methods/list-payments.spec.ts#L78) | Yes |
| 77 | `holder_name` on a listed entry | Returned intact — control case for DEFECT-2 | [L92](tests/payment-methods/list-payments.spec.ts#L92) | Yes |

#### Listed id integrity — expected to fail (DEFECT-1)

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 78 | Listed `id` compared to the id from `POST /payments` | Must match | [L118](tests/payment-methods/list-payments.spec.ts#L118) | Yes |
| 79 | `GET /payments/{listed_id}` | Must return 200 | [L132](tests/payment-methods/list-payments.spec.ts#L132) | Yes |
| 80 | Three payments — full set of listed ids vs created ids | Sets must be equal | [L145](tests/payment-methods/list-payments.spec.ts#L145) | Yes |
| 81 | Two successive reads of the same list | Ids must be stable — distinguishes generated-per-response from corrupted-at-write | [L158](tests/payment-methods/list-payments.spec.ts#L158) | Yes |
| 82 | Format of the listed id | Matches `^pay_[0-9a-f]{32}$` | [L169](tests/payment-methods/list-payments.spec.ts#L169) | Yes |

#### Negative

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 83 | Unknown but well-formed method id | 404 `not_found` | [L187](tests/payment-methods/list-payments.spec.ts#L187) | Yes |
| 84 | Malformed id | 404 `not_found` | [L187](tests/payment-methods/list-payments.spec.ts#L187) | Yes |
| 85 | A `pay_` id on this route | 404 `not_found` | [L187](tests/payment-methods/list-payments.spec.ts#L187) | Yes |
| 86 | No API key | 401 `invalid_api_key` | [L193](tests/payment-methods/list-payments.spec.ts#L193) | Yes |
| 87 | No API key against a non-existent method | 401 before 404 | [L198](tests/payment-methods/list-payments.spec.ts#L198) | Yes |

---

### 3.4 `POST /payments` — Create a payment

Spec file: `tests/payments/create.spec.ts`

#### Happy path

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 88 | Charge an active card method | 201, minimal processing shape | [L16](tests/payments/create.spec.ts#L16) | Yes |
| 89 | Inspect creation response keys | Exactly `id`, `status`, `created_at` | [L23](tests/payments/create.spec.ts#L23) | Yes |
| 90 | Currency `EUR` | 201 | [L31](tests/payments/create.spec.ts#L31) | Yes |
| 91 | Currency `USD` | 201 | [L31](tests/payments/create.spec.ts#L31) | Yes |
| 92 | Currency `GBP` | 201 | [L31](tests/payments/create.spec.ts#L31) | Yes |
| 93 | Amount at the documented minimum of 1 | 201 | [L40](tests/payments/create.spec.ts#L40) | Yes |
| 94 | Large amount (99,999,999) | 201 | [L48](tests/payments/create.spec.ts#L48) | Yes |
| 95 | Charge an active sepa method | 201 | [L56](tests/payments/create.spec.ts#L56) | Yes |
| 96 | Three concurrent payments on one method | All 201, three distinct ids | [L62](tests/payments/create.spec.ts#L62) | Yes |
| 97 | Two identical requests | Two distinct payments — no idempotency documented | [L75](tests/payments/create.spec.ts#L75) | Yes |

#### Settlement outcomes

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 98 | Payment on a valid card | `succeeded`, no `failure_reason` | [L88](tests/payments/create.spec.ts#L88) | Yes |
| 99 | Payment on the declining card | `failed` / `card_declined` | [L99](tests/payments/create.spec.ts#L99) | Yes |
| 100 | Payment on the declining IBAN | `failed` / `debit_declined` | [L112](tests/payments/create.spec.ts#L112) | Yes |
| 101 | Amount and currency on a declined payment | Preserved through settlement | [L125](tests/payments/create.spec.ts#L125) | Yes |

#### Business logic observations

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 102 | Charge a method still in `processing` | Accepted, settles `succeeded` — recorded so a change is visible | [L142](tests/payments/create.spec.ts#L142) | Yes |
| 103 | Amount of 999,999,999,999 | Accepted — no upper bound documented | [L155](tests/payments/create.spec.ts#L155) | Yes |

#### Negative — `payment_method_id` (expect 422 `unknown_payment_method`)

| # | Scenario | Link | Automated |
|---|----------|------|-----------|
| 104 | Omitted | [L178](tests/payments/create.spec.ts#L178) | Yes |
| 105 | Unknown but well-formed `pm_` id | [L178](tests/payments/create.spec.ts#L178) | Yes |
| 106 | Malformed id | [L178](tests/payments/create.spec.ts#L178) | Yes |
| 107 | Empty string | [L178](tests/payments/create.spec.ts#L178) | Yes |
| 108 | Null | [L178](tests/payments/create.spec.ts#L178) | Yes |
| 109 | Numeric | [L178](tests/payments/create.spec.ts#L178) | Yes |
| 110 | A real `pay_` id used as a method id | [L186](tests/payments/create.spec.ts#L186) | Yes |

#### Negative — `amount` (expect 422 `invalid_amount`)

| # | Scenario | Link | Automated |
|---|----------|------|-----------|
| 111 | Zero | [L197](tests/payments/create.spec.ts#L197) | Yes |
| 112 | Negative | [L197](tests/payments/create.spec.ts#L197) | Yes |
| 113 | Decimal | [L197](tests/payments/create.spec.ts#L197) | Yes |
| 114 | Numeric string | [L197](tests/payments/create.spec.ts#L197) | Yes |
| 115 | Null | [L197](tests/payments/create.spec.ts#L197) | Yes |
| 116 | Boolean | [L197](tests/payments/create.spec.ts#L197) | Yes |
| 117 | Omitted | [L205](tests/payments/create.spec.ts#L205) | Yes |

#### Negative — `currency` (expect 422 `unsupported_currency`)

| # | Scenario | Link | Automated |
|---|----------|------|-----------|
| 118 | Lowercase (`eur`) | [L216](tests/payments/create.spec.ts#L216) | Yes |
| 119 | Unsupported code (`XYZ`) | [L216](tests/payments/create.spec.ts#L216) | Yes |
| 120 | Too long (`EURO`) | [L216](tests/payments/create.spec.ts#L216) | Yes |
| 121 | Empty string | [L216](tests/payments/create.spec.ts#L216) | Yes |
| 122 | Numeric ISO code (978) | [L216](tests/payments/create.spec.ts#L216) | Yes |
| 123 | Omitted | [L224](tests/payments/create.spec.ts#L224) | Yes |

#### Negative — protocol level

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 124 | Malformed JSON | 400 `invalid_json` | [L234](tests/payments/create.spec.ts#L234) | Yes |
| 125 | `Content-Type: text/plain` | 415 `unsupported_media_type` | [L242](tests/payments/create.spec.ts#L242) | Yes |
| 126 | No API key | 401 `invalid_api_key` | [L250](tests/payments/create.spec.ts#L250) | Yes |

---

### 3.5 `GET /payments/{id}` — Fetch a payment

Spec file: `tests/payments/fetch.spec.ts`

#### Representation

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 127 | Fetch immediately after creation | 200, exactly `id` / `status: processing` / `created_at` | [L9](tests/payments/fetch.spec.ts#L9) | Yes |
| 128 | Fetch a succeeded payment | All required fields present per the `Payment` schema | [L26](tests/payments/fetch.spec.ts#L26) | Yes |
| 129 | `failure_reason` on a succeeded payment | Absent — spec says present only when failed | [L41](tests/payments/fetch.spec.ts#L41) | Yes |
| 130 | `failure_reason` on a failed payment | One of `card_declined`, `debit_declined` | [L46](tests/payments/fetch.spec.ts#L46) | Yes |
| 131 | Amount and currency requested vs returned | Identical | [L56](tests/payments/fetch.spec.ts#L56) | Yes |
| 132 | `payment_method_id` | References the method that was charged | [L65](tests/payments/fetch.spec.ts#L65) | Yes |
| 133 | `created_at` before and after settlement | Unchanged | [L69](tests/payments/fetch.spec.ts#L69) | Yes |
| 134 | Two successive reads | Identical bodies | [L78](tests/payments/fetch.spec.ts#L78) | Yes |
| 135 | Time to reach a terminal state | Within the 15 s ceiling | [L85](tests/payments/fetch.spec.ts#L85) | Yes |

#### `holder_name` integrity — expected to fail (DEFECT-2)

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 136 | `holder_name` of `"A"` | Returned as `"A"` | [L110](tests/payments/fetch.spec.ts#L110) | Yes |
| 137 | `holder_name` of `"AB"` | Returned as `"AB"` | [L110](tests/payments/fetch.spec.ts#L110) | Yes |
| 138 | `holder_name` of `"Bob"` | Returned as `"Bob"` | [L110](tests/payments/fetch.spec.ts#L110) | Yes |
| 139 | `holder_name` of `"Imran"` | Returned as `"Imran"` | [L110](tests/payments/fetch.spec.ts#L110) | Yes |
| 140 | `holder_name` of `"Imran Test"` | Returned as `"Imran Test"` | [L110](tests/payments/fetch.spec.ts#L110) | Yes |
| 141 | `holder_name` vs the payment method's holder name | Must match | [L128](tests/payments/fetch.spec.ts#L128) | Yes |
| 142 | Single-character `holder_name` | Must not settle to an empty string — `required` field | [L135](tests/payments/fetch.spec.ts#L135) | Yes |

#### Sensitive data and negative cases

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 143 | Search the payment body for PAN and CVC | Absent; no `card` property | [L153](tests/payments/fetch.spec.ts#L153) | Yes |
| 144 | Unknown but well-formed `pay_` id | 404 `not_found` | [L172](tests/payments/fetch.spec.ts#L172) | Yes |
| 145 | Malformed id | 404 `not_found` | [L172](tests/payments/fetch.spec.ts#L172) | Yes |
| 146 | An unknown `pm_` id on the payment route | 404 `not_found` | [L172](tests/payments/fetch.spec.ts#L172) | Yes |
| 147 | Numeric id | 404 `not_found` | [L172](tests/payments/fetch.spec.ts#L172) | Yes |
| 148 | A *real* `pm_` id on the payment route | 404 — namespaces must not be confused | [L178](tests/payments/fetch.spec.ts#L178) | Yes |
| 149 | No API key | 401 `invalid_api_key` | [L183](tests/payments/fetch.spec.ts#L183) | Yes |
| 150 | Unknown API key | 401 `invalid_api_key` | [L188](tests/payments/fetch.spec.ts#L188) | Yes |
| 151 | No API key against a non-existent id | 401 before 404 | [L195](tests/payments/fetch.spec.ts#L195) | Yes |

---

### 3.6 End-to-end flows

Spec file: `tests/e2e/payment-flow.spec.ts`

| # | Scenario | Steps | Link | Automated |
|---|----------|-------|------|-----------|
| 152 | Card payment full lifecycle | Create method → active → charge → succeeded → appears in list → no sensitive data anywhere | [L7](tests/e2e/payment-flow.spec.ts#L7) | Yes |
| 153 | SEPA payment full lifecycle | Create sepa method → active → charge → succeeded → IBAN never exposed | [L55](tests/e2e/payment-flow.spec.ts#L55) | Yes |
| 154 | Declined card full lifecycle | Method still registers active → payment fails `card_declined` → still listed | [L83](tests/e2e/payment-flow.spec.ts#L83) | Yes |
| 155 | Declined SEPA full lifecycle | Method active → payment fails `debit_declined` | [L108](tests/e2e/payment-flow.spec.ts#L108) | Yes |
| 156 | One method, three payments | All settle, all listed with correct amounts | [L125](tests/e2e/payment-flow.spec.ts#L125) | Yes |

#### Cross-endpoint consistency — expected to fail (DEFECT-1, DEFECT-2)

| # | Scenario | Expected | Link | Automated |
|---|----------|----------|------|-----------|
| 157 | Same payment read from detail and list endpoints | Every field identical, including `id` and `holder_name` | [L145](tests/e2e/payment-flow.spec.ts#L145) | Yes |
| 158 | `holder_name` read from all three endpoints | Identical on all three | [L166](tests/e2e/payment-flow.spec.ts#L166) | Yes |
| 159 | Fetch a listed payment by its listed id | 200, correct `payment_method_id` | [L185](tests/e2e/payment-flow.spec.ts#L185) | Yes |

---

## 4. Coverage summary

### Automation coverage

Verified by cross-referencing every ID above against its spec file and
confirming the count with `npx playwright test --list` (2026-08-02):

| Area | Spec file | Cases in plan | Automated | Not automated |
|------|-----------|---------------:|----------:|---------------:|
| `POST /payment-methods` | `tests/payment-methods/create.spec.ts` | 50 | 50 | 0 |
| `GET /payment-methods/{id}` | `tests/payment-methods/fetch.spec.ts` | 19 | 19 | 0 |
| `GET /payment-methods/{id}/payments` | `tests/payment-methods/list-payments.spec.ts` | 18 | 18 | 0 |
| `POST /payments` | `tests/payments/create.spec.ts` | 39 | 39 | 0 |
| `GET /payments/{id}` | `tests/payments/fetch.spec.ts` | 25 | 25 | 0 |
| End-to-end | `tests/e2e/payment-flow.spec.ts` | 8 | 8 | 0 |
| **Total** | | **159** | **159** | **0** |

**159/159 planned cases are automated (100%).** Every row in section 3 has a
one-to-one Playwright test; nothing in the plan is manual-only or pending
implementation. The exploratory scripts under `tests/exploratory/` (discovery,
smoke, timing) sit outside this plan by design — they support the strategy in
section 2 but assert nothing themselves, so they are not counted as test cases.

Note that several rows are parameterised in code (currencies, card types,
holder-name lengths), so the executed test count differs slightly from the case
count above.

### Coverage by category

| Category | Approximate share |
|----------|-------------------|
| Happy path and contract conformance | 30% |
| Negative — field validation | 35% |
| Negative — protocol and auth | 15% |
| Security properties of responses | 8% |
| Asynchronous behaviour | 7% |
| Cross-endpoint consistency | 5% |

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
- **Rate limiting as a feature.** No test deliberately exceeds 300 req/min to
  assert the API's own 429/`Retry-After` behaviour — the brief asks not to
  load or stress test beyond the limit. Separately, the suite *respects* the
  limit operationally (worker cap, retry-with-backoff, CI concurrency guard —
  see README "Rate limiting" / "CI") so its own traffic doesn't trip it by
  accident. Not testing the limit and not tripping the limit are different
  concerns; only the first is out of scope.
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

## 5. Entry and exit criteria

**Entry**
- API reachable and the API key valid
- `openapi.yaml` available as the contract of record
- Discovery phase complete; actual response shapes recorded

**Exit**
- All planned cases implemented and executed
- Every failure triaged as either a defect or a test error
- Defects documented with reproduction steps and evidence
- No test modified to accommodate a defect

---

## 6. Expected results

The suite is expected to **fail**, deliberately. Approximately 13 tests assert
documented behaviour that the API does not exhibit:

| Group | Cases (#) | Defect |
|-------|-------|--------|
| `Listed id integrity` | 78 … 81 | DEFECT-1 |
| `holder_name integrity` | 136 … 142 | DEFECT-2 |
| `Cross-endpoint consistency` | 157 … 159 | Both |

A fully green run would indicate the defects have been fixed.

In a production repository these would be converted to `test.fail()` annotations
with ticket references once triaged, so the suite reports green and flips to red
automatically when the defect is fixed. They are left failing here because the
brief asks for tests that catch divergence from the documentation, and a passing
suite would bury the finding.

See `DEFECTS.md` for full reproduction steps and evidence.
