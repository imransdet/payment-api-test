# Payment API Tests

Playwright API test suite for the payments service — covers payment methods (creation, fetch, listing), payments (creation, fetch), an end-to-end payment flow, and discovery/smoke checks.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable   | Description                        |
|------------|-------------------------------------|
| `BASE_URL` | Base URL of the payment API         |
| `API_KEY`  | API key sent via `X-Api-Key` header |

## Running tests

```bash
npx playwright test
```

Run a single file (use the path, since some spec filenames repeat across folders):

```bash
npx playwright test tests/payments/create.spec.ts
npx playwright test tests/payment-methods/create.spec.ts
```

View the HTML report after a run:

```bash
npm run test:report
```

## Structure

```
tests/
├── e2e/               # End-to-end payment flow
├── payment-methods/   # Payment methods API (create, fetch, list)
├── payments/          # Payments API (create, fetch)
├── fixtures/          # Shared Playwright fixtures (authenticated/unauthenticated API contexts)
├── support/           # Test data and helper utilities
├── discovery*.spec.ts # API discovery checks
├── smoke.spec.ts      # Smoke tests
└── timing.spec.ts     # Timing checks
```
