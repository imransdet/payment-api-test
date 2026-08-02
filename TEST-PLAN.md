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

Settle time is undocumented, so it was measured (n=8 per resource):

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

**ID convention:** `{RESOURCE}-{OPERATION}-{NNN}`
`PM` = payment method, `PAY` = payment, `E2E` = end-to-end.
`C` = create, `F` = fetch, `L` = list.

**Priority:** P1 = contract-critical, P2 = important, P3 = edge case.

---

### 3.1 `POST /payment-methods` — Create a payment method

Spec file: `tests/payment-methods/create.spec.ts`

#### Happy path

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-C-001 | P1 | Create with `type: adyen` and a valid card block | 201, minimal processing shape |
| PM-C-002 | P1 | Create with `type: checkout` and a valid card block | 201, minimal processing shape |
| PM-C-003 | P1 | Create with `type: sepa` and a valid sepa block | 201, minimal processing shape |
| PM-C-004 | P2 | Create sepa with an optional 8-character BIC | 201 |
| PM-C-005 | P2 | Create sepa with an optional 11-character BIC | 201 |
| PM-C-006 | P2 | Create sepa with an IBAN containing spaces | 201 — spec states spaces allowed |
| PM-C-007 | P2 | Two concurrent creations | Distinct `id` values |

#### Sensitive data handling

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-C-008 | P1 | Inspect creation response keys | Exactly `id`, `status`, `created_at` — no card data |
| PM-C-009 | P1 | Inspect settled card representation | Only `brand` + `last4`; no `number`, no `cvc`, full PAN absent from body |
| PM-C-010 | P1 | Inspect settled sepa representation | Only `country` + `iban_last4`; full IBAN absent from body |

#### Negative — schema selection (expect 422 `schema_mismatch`)

| ID | Priority | Scenario |
|----|----------|----------|
| PM-C-011 | P1 | `type` omitted |
| PM-C-012 | P1 | `type` is an unknown value (`stripe`) |
| PM-C-013 | P2 | `type` is `null` |
| PM-C-014 | P1 | `type: adyen` with no `card` block |
| PM-C-015 | P1 | `type: checkout` with no `card` block |
| PM-C-016 | P1 | `type: sepa` with no `sepa` block |
| PM-C-017 | P2 | `type: adyen` carrying a `sepa` block |
| PM-C-018 | P2 | `type: sepa` carrying a `card` block |
| PM-C-019 | P2 | Both `card` and `sepa` blocks present |

#### Negative — card field validation (expect 422)

| ID | Priority | Scenario | Expected code |
|----|----------|----------|---------------|
| PM-C-020 | P1 | `holder_name` empty string | `invalid_holder_name` |
| PM-C-021 | P2 | `holder_name` null | `invalid_holder_name` |
| PM-C-022 | P1 | `holder_name` omitted | `invalid_holder_name` |
| PM-C-023 | P1 | `number` fails the Luhn check | `invalid_card_number` |
| PM-C-024 | P1 | `number` non-numeric | `invalid_card_number` |
| PM-C-025 | P2 | `number` shorter than 12 digits | `invalid_card_number` |
| PM-C-026 | P2 | `number` empty string | `invalid_card_number` |
| PM-C-027 | P2 | `exp_month` is 0 | `card_expired` |
| PM-C-028 | P2 | `exp_month` is 13 | `card_expired` |
| PM-C-029 | P1 | `exp_year` in the past | `card_expired` |
| PM-C-030 | P3 | `exp_year` given as two digits | `card_expired` |
| PM-C-031 | P1 | `cvc` shorter than 3 digits | `invalid_cvc` |
| PM-C-032 | P2 | `cvc` longer than 4 digits | `invalid_cvc` |
| PM-C-033 | P2 | `cvc` contains letters | `invalid_cvc` |
| PM-C-034 | P1 | `cvc` omitted | `invalid_cvc` |

#### Negative — sepa field validation (expect 422)

| ID | Priority | Scenario | Expected code |
|----|----------|----------|---------------|
| PM-C-035 | P1 | `holder_name` empty | `invalid_holder_name` |
| PM-C-036 | P1 | IBAN with an invalid checksum | `invalid_iban` |
| PM-C-037 | P2 | IBAN too short | `invalid_iban` |
| PM-C-038 | P2 | IBAN is arbitrary text | `invalid_iban` |
| PM-C-039 | P2 | IBAN empty string | `invalid_iban` |
| PM-C-040 | P1 | IBAN omitted | `invalid_iban` |
| PM-C-041 | P2 | BIC of 7 characters | `invalid_bic` |
| PM-C-042 | P2 | BIC of 9 characters | `invalid_bic` |
| PM-C-043 | P3 | BIC in lowercase | `invalid_bic` |
| PM-C-044 | P3 | BIC of digits only | `invalid_bic` |

#### Negative — protocol level

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-C-045 | P1 | Malformed JSON body | 400 `invalid_json` |
| PM-C-046 | P2 | Empty request body | 400 `invalid_json` |
| PM-C-047 | P1 | `Content-Type: text/plain` | 415 `unsupported_media_type` |
| PM-C-048 | P2 | Body exceeding 1 MiB | 413 `payload_too_large` |
| PM-C-049 | P1 | No `X-Api-Key` header | 401 `invalid_api_key` |
| PM-C-050 | P1 | Unknown `X-Api-Key` value | 401 `invalid_api_key` |

---

### 3.2 `GET /payment-methods/{id}` — Fetch a payment method

Spec file: `tests/payment-methods/fetch.spec.ts`

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-F-001 | P1 | Fetch immediately after creation | 200, exactly `id` / `status: processing` / `created_at` |
| PM-F-002 | P1 | Fetch an adyen method after settlement | 200, `status: active`, masked card block |
| PM-F-003 | P1 | Fetch a checkout method after settlement | 200, `status: active`, masked card block |
| PM-F-004 | P1 | Fetch a sepa method after settlement | 200, `status: active`, sepa block, no card block |
| PM-F-005 | P2 | Card method response has no sepa block | `sepa` property absent |
| PM-F-006 | P2 | `created_at` format | Valid ISO 8601 with milliseconds |
| PM-F-007 | P1 | `created_at` compared before and after settlement | Unchanged |
| PM-F-008 | P2 | Two successive reads of the same settled method | Identical bodies |
| PM-F-009 | P1 | Time to reach `active` | Terminal state within the 15 s ceiling |
| PM-F-010 | P2 | Register a method using the declining card | Still settles to `active` — the trigger applies to payments |
| PM-F-011 | P1 | Full PAN and CVC search in the response body | Absent |
| PM-F-012 | P1 | Full IBAN and BIC search in the response body | Absent |
| PM-F-013 | P1 | Unknown but well-formed `pm_` id | 404 `not_found` |
| PM-F-014 | P2 | Malformed id | 404 `not_found` |
| PM-F-015 | P2 | A `pay_` id on the payment-method route | 404 `not_found` |
| PM-F-016 | P3 | Numeric id | 404 `not_found` |
| PM-F-017 | P1 | No API key | 401 `invalid_api_key` |
| PM-F-018 | P1 | Unknown API key | 401 `invalid_api_key` |
| PM-F-019 | P1 | No API key against a non-existent id | 401 before 404 — must not leak which ids exist |

---

### 3.3 `GET /payment-methods/{id}/payments` — List a method's payments

Spec file: `tests/payment-methods/list-payments.spec.ts`

#### Happy path

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-L-001 | P1 | Method with no payments | 200, `data` present and empty |
| PM-L-002 | P1 | Method with one payment | `data` length 1 |
| PM-L-003 | P1 | Method with three payments | `data` length 3 |
| PM-L-004 | P1 | Ordering of multiple payments | Oldest first, per the spec |
| PM-L-005 | P1 | Two methods each with one payment | Each list contains only its own payment |
| PM-L-006 | P1 | `payment_method_id` on each entry | Matches the parent method |
| PM-L-007 | P2 | List before and after settlement | Entries transition `processing` → terminal |
| PM-L-008 | P1 | `holder_name` on a listed entry | Returned intact — control case for DEFECT-2 |

#### Listed id integrity — expected to fail (DEFECT-1)

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-L-009 | P1 | Listed `id` compared to the id from `POST /payments` | Must match |
| PM-L-010 | P1 | `GET /payments/{listed_id}` | Must return 200 |
| PM-L-011 | P1 | Three payments — full set of listed ids vs created ids | Sets must be equal |
| PM-L-012 | P2 | Two successive reads of the same list | Ids must be stable — distinguishes generated-per-response from corrupted-at-write |
| PM-L-013 | P2 | Format of the listed id | Matches `^pay_[0-9a-f]{32}$` |

#### Negative

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PM-L-014 | P1 | Unknown but well-formed method id | 404 `not_found` |
| PM-L-015 | P2 | Malformed id | 404 `not_found` |
| PM-L-016 | P2 | A `pay_` id on this route | 404 `not_found` |
| PM-L-017 | P1 | No API key | 401 `invalid_api_key` |
| PM-L-018 | P1 | No API key against a non-existent method | 401 before 404 |

---

### 3.4 `POST /payments` — Create a payment

Spec file: `tests/payments/create.spec.ts`

#### Happy path

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-C-001 | P1 | Charge an active card method | 201, minimal processing shape |
| PAY-C-002 | P1 | Inspect creation response keys | Exactly `id`, `status`, `created_at` |
| PAY-C-003 | P1 | Currency `EUR` | 201 |
| PAY-C-004 | P1 | Currency `USD` | 201 |
| PAY-C-005 | P1 | Currency `GBP` | 201 |
| PAY-C-006 | P2 | Amount at the documented minimum of 1 | 201 |
| PAY-C-007 | P2 | Large amount (99,999,999) | 201 |
| PAY-C-008 | P1 | Charge an active sepa method | 201 |
| PAY-C-009 | P2 | Three concurrent payments on one method | All 201, three distinct ids |
| PAY-C-010 | P2 | Two identical requests | Two distinct payments — no idempotency documented |

#### Settlement outcomes

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-C-011 | P1 | Payment on a valid card | `succeeded`, no `failure_reason` |
| PAY-C-012 | P1 | Payment on the declining card | `failed` / `card_declined` |
| PAY-C-013 | P1 | Payment on the declining IBAN | `failed` / `debit_declined` |
| PAY-C-014 | P2 | Amount and currency on a declined payment | Preserved through settlement |

#### Business logic observations

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-C-015 | P2 | Charge a method still in `processing` | Accepted, settles `succeeded` — recorded so a change is visible |
| PAY-C-016 | P3 | Amount of 999,999,999,999 | Accepted — no upper bound documented |

#### Negative — `payment_method_id` (expect 422 `unknown_payment_method`)

| ID | Priority | Scenario |
|----|----------|----------|
| PAY-C-017 | P1 | Omitted |
| PAY-C-018 | P1 | Unknown but well-formed `pm_` id |
| PAY-C-019 | P2 | Malformed id |
| PAY-C-020 | P2 | Empty string |
| PAY-C-021 | P2 | Null |
| PAY-C-022 | P3 | Numeric |
| PAY-C-023 | P2 | A real `pay_` id used as a method id |

#### Negative — `amount` (expect 422 `invalid_amount`)

| ID | Priority | Scenario |
|----|----------|----------|
| PAY-C-024 | P1 | Zero |
| PAY-C-025 | P1 | Negative |
| PAY-C-026 | P1 | Decimal |
| PAY-C-027 | P2 | Numeric string |
| PAY-C-028 | P2 | Null |
| PAY-C-029 | P3 | Boolean |
| PAY-C-030 | P1 | Omitted |

#### Negative — `currency` (expect 422 `unsupported_currency`)

| ID | Priority | Scenario |
|----|----------|----------|
| PAY-C-031 | P1 | Lowercase (`eur`) |
| PAY-C-032 | P1 | Unsupported code (`XYZ`) |
| PAY-C-033 | P2 | Too long (`EURO`) |
| PAY-C-034 | P2 | Empty string |
| PAY-C-035 | P3 | Numeric ISO code (978) |
| PAY-C-036 | P1 | Omitted |

#### Negative — protocol level

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-C-037 | P1 | Malformed JSON | 400 `invalid_json` |
| PAY-C-038 | P1 | `Content-Type: text/plain` | 415 `unsupported_media_type` |
| PAY-C-039 | P1 | No API key | 401 `invalid_api_key` |

---

### 3.5 `GET /payments/{id}` — Fetch a payment

Spec file: `tests/payments/fetch.spec.ts`

#### Representation

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-F-001 | P1 | Fetch immediately after creation | 200, exactly `id` / `status: processing` / `created_at` |
| PAY-F-002 | P1 | Fetch a succeeded payment | All required fields present per the `Payment` schema |
| PAY-F-003 | P1 | `failure_reason` on a succeeded payment | Absent — spec says present only when failed |
| PAY-F-004 | P1 | `failure_reason` on a failed payment | One of `card_declined`, `debit_declined` |
| PAY-F-005 | P1 | Amount and currency requested vs returned | Identical |
| PAY-F-006 | P1 | `payment_method_id` | References the method that was charged |
| PAY-F-007 | P1 | `created_at` before and after settlement | Unchanged |
| PAY-F-008 | P2 | Two successive reads | Identical bodies |
| PAY-F-009 | P1 | Time to reach a terminal state | Within the 15 s ceiling |

#### `holder_name` integrity — expected to fail (DEFECT-2)

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-F-010 | P1 | `holder_name` of `"A"` | Returned as `"A"` |
| PAY-F-011 | P1 | `holder_name` of `"AB"` | Returned as `"AB"` |
| PAY-F-012 | P1 | `holder_name` of `"Bob"` | Returned as `"Bob"` |
| PAY-F-013 | P1 | `holder_name` of `"Imran"` | Returned as `"Imran"` |
| PAY-F-014 | P1 | `holder_name` of `"Imran Test"` | Returned as `"Imran Test"` |
| PAY-F-015 | P1 | `holder_name` vs the payment method's holder name | Must match |
| PAY-F-016 | P1 | Single-character `holder_name` | Must not settle to an empty string — `required` field |

#### Sensitive data and negative cases

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| PAY-F-017 | P1 | Search the payment body for PAN and CVC | Absent; no `card` property |
| PAY-F-018 | P1 | Unknown but well-formed `pay_` id | 404 `not_found` |
| PAY-F-019 | P2 | Malformed id | 404 `not_found` |
| PAY-F-020 | P2 | An unknown `pm_` id on the payment route | 404 `not_found` |
| PAY-F-021 | P3 | Numeric id | 404 `not_found` |
| PAY-F-022 | P2 | A *real* `pm_` id on the payment route | 404 — namespaces must not be confused |
| PAY-F-023 | P1 | No API key | 401 `invalid_api_key` |
| PAY-F-024 | P1 | Unknown API key | 401 `invalid_api_key` |
| PAY-F-025 | P1 | No API key against a non-existent id | 401 before 404 |

---

### 3.6 End-to-end flows

Spec file: `tests/e2e/payment-flow.spec.ts`

| ID | Priority | Scenario | Steps |
|----|----------|----------|-------|
| E2E-001 | P1 | Card payment full lifecycle | Create method → active → charge → succeeded → appears in list → no sensitive data anywhere |
| E2E-002 | P1 | SEPA payment full lifecycle | Create sepa method → active → charge → succeeded → IBAN never exposed |
| E2E-003 | P1 | Declined card full lifecycle | Method still registers active → payment fails `card_declined` → still listed |
| E2E-004 | P1 | Declined SEPA full lifecycle | Method active → payment fails `debit_declined` |
| E2E-005 | P2 | One method, three payments | All settle, all listed with correct amounts |

#### Cross-endpoint consistency — expected to fail (DEFECT-1, DEFECT-2)

| ID | Priority | Scenario | Expected |
|----|----------|----------|----------|
| E2E-006 | P1 | Same payment read from detail and list endpoints | Every field identical, including `id` and `holder_name` |
| E2E-007 | P1 | `holder_name` read from all three endpoints | Identical on all three |
| E2E-008 | P1 | Fetch a listed payment by its listed id | 200, correct `payment_method_id` |

---

## 4. Coverage summary

| Area | Cases |
|------|-------|
| `POST /payment-methods` | 50 |
| `GET /payment-methods/{id}` | 19 |
| `GET /payment-methods/{id}/payments` | 18 |
| `POST /payments` | 39 |
| `GET /payments/{id}` | 25 |
| End-to-end | 8 |
| **Total** | **159** |

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

| Group | Cases | Defect |
|-------|-------|--------|
| `Listed id integrity` | PM-L-009 … PM-L-012 | DEFECT-1 |
| `holder_name integrity` | PAY-F-010 … PAY-F-016 | DEFECT-2 |
| `Cross-endpoint consistency` | E2E-006 … E2E-008 | Both |

A fully green run would indicate the defects have been fixed.

In a production repository these would be converted to `test.fail()` annotations
with ticket references once triaged, so the suite reports green and flips to red
automatically when the defect is fixed. They are left failing here because the
brief asks for tests that catch divergence from the documentation, and a passing
suite would bury the finding.

See `DEFECTS.md` for full reproduction steps and evidence.
