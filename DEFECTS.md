# Defect Report

Distribusion Payment Simulation API — findings from the automated test suite.

Both defects share a characteristic worth noting up front: **each endpoint is
internally consistent and plausible when tested in isolation.** The faults are
only visible when the same record is compared across endpoints. A suite that
tests each endpoint independently, however thorough, would report a fully green
run.

---

## DEFECT-1 — List endpoint returns a payment `id` that matches no payment

**Endpoint:** `GET /payment-methods/{id}/payments`
**Severity:** High
**Reproducibility:** 100% — reproduced across 4 separate runs, 7 payments

### Summary

Every payment returned by the list endpoint carries an `id` that does not
correspond to any retrievable payment. All other fields — `payment_method_id`,
`holder_name`, `amount`, `currency`, `status` and `created_at` to the
millisecond — match the created payment exactly. The record is correct; only the
identifier is wrong.

### Steps to reproduce

1. `POST /payment-methods` with a valid card block; wait for `active`
2. `POST /payments` against that method — note the returned `id`
3. `GET /payment-methods/{method_id}/payments`
4. Compare the `id` in `data[0]` with the `id` from step 2

### Evidence

```
POST /payments returned:
  id         = pay_a13f2f26d4144767996b0ced21f96151
  created_at = 2026-08-01T20:03:42.489Z

GET /payment-methods/{id}/payments returned:
  id         = pay_2ebc261c98e0430ca0502b69293d1552   ← different
  created_at = 2026-08-01T20:03:42.489Z               ← identical
  payment_method_id, amount, currency, status — all identical
```

A second run with two payments against one method showed both entries
mismatched, each with a `created_at` identical to its corresponding created
payment.

### Expected

Per the spec, the endpoint *"returns every payment created with this payment
method"*, and `Payment.id` is a required field. The listed `id` must match the
`id` returned by `POST /payments`, and `GET /payments/{listed_id}` must return
that payment.

### Actual

`GET /payments/{listed_id}` returns `404 not_found`. A client cannot retrieve
the detail of a payment it has just listed.

### Impact

Breaks reconciliation. Any client that lists payments and then fetches details —
a reporting job, a support tool, a settlement process — fails. The listed
identifier cannot be used for refunds, disputes, or cross-referencing against an
external ledger. For a payment service this is a data-integrity fault rather
than a cosmetic one.

### Covering tests

`tests/payment-methods/list-payments.spec.ts` → `Listed id integrity`
`tests/e2e/payment-flow.spec.ts` → `Cross-endpoint consistency`

The test `listed ids are stable across repeated reads` distinguishes the two
possible mechanisms: if it fails, the identifier is generated per response; if
it passes, the identifier is stored but was corrupted once at write time.

---

## DEFECT-2 — Payment detail endpoint truncates `holder_name`

**Endpoint:** `GET /payments/{id}`
**Severity:** High
**Reproducibility:** 100% — deterministic at every input length

### Summary

The `holder_name` field returned by `GET /payments/{id}` is missing its final
character. The truncation is a clean off-by-one, independent of length,
character set, or payment method type.

### Steps to reproduce

1. `POST /payment-methods` with `card.holder_name = "Imran Test"`; wait for
   `active`
2. `POST /payments` against that method; wait for settlement
3. `GET /payments/{payment_id}` and inspect `holder_name`

### Evidence

Controlled sequence of increasing lengths, same record read from three
endpoints:

| Sent | `GET /payment-methods/{id}` | `GET /payments/{id}` | `GET .../{id}/payments` |
|------|------|------|------|
| `"A"` | `"A"` | `""` | `"A"` |
| `"AB"` | `"AB"` | `"A"` | `"AB"` |
| `"Bob"` | `"Bob"` | `"Bo"` | `"Bob"` |
| `"Imran"` | `"Imran"` | `"Imra"` | `"Imran"` |
| `"Imran Test"` | `"Imran Test"` | `"Imran Tes"` | `"Imran Test"` |
| `"A Very Long Holder Name Indeed"` | *(intact)* | *(final char dropped)* | *(intact)* |

Also reproduced on SEPA payments and on failed payments, so it is not specific
to card methods or to successful settlement.

### Expected

Per the spec, `Payment.holder_name` is *"the holder name of the payment method
this payment was made with"*, and is a required field. It should match the
holder name registered on the payment method exactly.

### Actual

The final character is removed. A single-character holder name returns an empty
string, which additionally violates the `required` constraint on the field in
any meaningful sense.

### Scope

The same field is returned **correctly** by `GET /payment-methods/{id}` and by
`GET /payment-methods/{id}/payments`. The fault is isolated to the
`GET /payments/{id}` serializer.

### Impact

Corrupted account-holder names on payment records. Affects receipts,
chargeback evidence, and any name-matching against bank records — a common
requirement for SEPA direct debit. Silent: the response is well-formed and
passes schema validation, so nothing downstream would flag it.

### Covering tests

`tests/payments/fetch.spec.ts` → `holder_name integrity`
`tests/e2e/payment-flow.spec.ts` → `holder_name is consistent across all three endpoints`

The end-to-end test is the clearest single artifact: three assertions on the
same field of the same record, two passing and one failing.

---

## Observations — not defects

Recorded for review. None violates the documented contract.

### No upper bound on `amount`

`CreatePayment.amount` specifies `minimum: 1` with no maximum. An amount of
999,999,999,999 minor units (~€10bn) is accepted and settles to `succeeded`.
Not a contract violation, but unusual for a payment API.

### Payments succeed against a method still in `processing`

The spec describes payment methods becoming `active` but never requires that
state before a charge. A payment created against a method still processing is
accepted and settles to `succeeded`. Recorded in the suite so a future change in
this behaviour is caught.

### No idempotency mechanism

Two identical `POST /payments` requests create two distinct payments. No
idempotency key is documented, so this is expected behaviour — but
duplicate-charge protection is a normal requirement for a payment API and may be
worth confirming as an intentional omission.

### `exp_month: 13` returns `card_expired`

`CreateCardPaymentMethod.card.exp_month` specifies `maximum: 12`, so a value of
13 is arguably a schema violation rather than an expiry problem, and
`schema_mismatch` would be a closer fit. `card_expired` is a documented code and
its message covers the case, so this is a naming nitpick rather than a defect.
