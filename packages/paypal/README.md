# packages/paypal

**Status: boundary only. There is no PayPal integration in this repository yet.**

This directory contains no code on purpose. A stub that returned successful responses would
be a fake integration, and nothing here should look like it moves money when it does not.

## What this package will be

The adapter that implements the `PaymentGateway` port from `@nelyq/application` against the
PayPal REST API, plus verification and translation of PayPal webhooks.

Task 002 implements the PayPal Sandbox vertical slice:

```
create order (intent: AUTHORIZE) → buyer approval → authorize → capture → verified webhook
```

## Rules for the implementation

- **It is the only code that talks to PayPal** and the only code that reads PayPal
  credentials. Credentials come from server-side environment variables (see
  `.env.example`) and are never logged, returned to a client, or passed to the AI adapter.
- **It translates; it does not decide.** PayPal statuses are mapped to calls on the domain
  (`authorize`, `confirmCapture`, `recordDecline`, ...). Whether a transition is allowed is the
  domain's decision. PayPal vocabulary stays inside this package.
- **Amounts cross the boundary through `Money`.** Use `toDecimalString()` to send and
  `fromDecimalString()` to parse. Never `parseFloat`, never `Number`.
- **Responses are validated.** A PayPal response is parsed against an explicit schema
  before any field is used. An authorization or capture for an amount other than the
  payment's amount is an error.
- **One idempotency identifier per capture.** The `idempotencyKey` on the port's request is
  the payment's `captureRequestId`. It must be sent as `PayPal-Request-Id`, unchanged, on
  the first attempt and on every retry or reconciliation of that capture. Never generate a
  new one for a re-send.
- **An unknown outcome is not a decline.** A timeout, a network error or a 5xx must surface
  as a thrown error and leave the payment `CAPTURE_PENDING`. Only a response that
  definitively refuses the operation may lead to `recordDecline`, through an explicit typed
  result. Which PayPal responses are definitive is to be established in this task, not
  assumed. See [ADR 0004](../../docs/adr/0004-unknown-gateway-outcomes.md).
- **Authorizations expire.** `AUTHORIZED` is not valid forever. Expiry handling and
  reauthorization are this task's to design; the domain has no state for them yet and none
  should be added until PayPal's actual behavior requires it.
- **Webhooks are untrusted until verified.** Verify the signature against the configured
  webhook ID before acting on the body. Deduplicate by PayPal event ID.
- **No PayPal SDK without an ADR.** Plain `fetch` against a small number of endpoints is
  the starting assumption.

## Expected mapping

A starting hypothesis to be confirmed against PayPal's documentation and Sandbox behavior
in Task 002, not a specification:

| PayPal signal                                     | Domain call            |
| ------------------------------------------------- | ---------------------- |
| Order created                                     | `requestBuyerApproval` |
| Order approved by buyer                           | none (not a state)     |
| Authorization created                             | `authorize`            |
| Capture completed (verified webhook)              | `confirmCapture`       |
| Authorization voided or expired                   | `voidAuthorization`    |
| Definitive refusal of an authorization or capture | `recordDecline`        |
| Timeout, network error, 5xx, any unknown outcome  | none: reconcile        |

See [docs/architecture/overview.md](../../docs/architecture/overview.md) for why Nelyq's
states differ from PayPal's.
