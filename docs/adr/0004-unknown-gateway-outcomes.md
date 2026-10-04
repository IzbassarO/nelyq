# ADR 0004: An unknown gateway outcome is not a failure

Status: Accepted (2026-10-04)

## Context

A request to capture funds can end three ways: the gateway confirms it, the gateway
definitively refuses it, or Nelyq does not find out. The third is common. A timeout, a
dropped connection or a gateway 5xx says nothing about whether the funds moved; the capture
may have succeeded just before the response was lost.

The first version of the payment model had a generic `FAILED` state reached by a generic
`fail` transition, including from `CAPTURE_PENDING`. Nothing in the name or the type
distinguished "the gateway refused" from "the call threw". An adapter that mapped a timeout
to `fail` would have marked a payment terminally failed while the buyer's money was
captured, with no state left from which to discover or record that.

## Decision

1. **A thrown or ambiguous gateway error never causes a terminal transition.** The payment
   stays where it is. For a capture that is `CAPTURE_PENDING`.

2. **`CAPTURE_PENDING` means: a capture operation has been durably requested and its final
   external outcome may still need confirmation or reconciliation.** It has exactly two
   exits, both requiring knowledge of the outcome: `confirmCapture` and `recordDecline`.
   There is no way to start a second capture, cancel, or void from it.

3. **The generic failure is replaced by a definitive one.** `FAILED` becomes `DECLINED` and
   `fail` becomes `recordDecline`, with the event `payment.declined`. It records that the
   gateway definitively refused the authorization or capture that was in flight: the
   outcome is known, and that operation moved no money. It is allowed only from
   `AWAITING_BUYER_APPROVAL` and `CAPTURE_PENDING`, the two states with such an operation in
   flight.

   The transition from `CREATED` is removed. No funds are involved before an order exists,
   so a payment that cannot proceed from there is canceled.

   `DECLINED` is Nelyq's word for "a definitive refusal", not a mirror of any provider's
   status. Which provider responses count as definitive is decided in Task 002.

4. **Each capture operation has one stable idempotency identifier.** It is the ID of the
   payment's `payment.capture_requested` event, stored on the payment as
   `captureRequestId` at the moment the capture is requested and never changed. Every send
   of that capture carries it as the gateway request's idempotency key: the first attempt,
   any retry, and any reconciliation. Code that re-sends a pending capture must read this
   value, never generate a new one. A new key would make the gateway treat the re-send as a
   second capture.

   Task 002 will map this identifier to PayPal's `PayPal-Request-Id` header. That mapping
   is not implemented.

5. **`AUTHORIZED` is not assumed valid forever.** It records that the gateway confirmed a
   hold when the transition happened. Authorizations expire, and a capture against an
   expired one will not succeed. Expiry tracking and reauthorization are intentionally
   deferred to Task 002, where the provider's actual rules can be confirmed rather than
   guessed. No state is added for them now; `voidAuthorization` already covers an
   authorization that was released or expired without a capture.

6. **The gateway port reports a thrown error as "unknown" and nothing else.**
   `PaymentGateway.captureAuthorization` has no channel for a definitive decline yet. When
   Task 002 needs one, it must be an explicit typed result, not something inferred from an
   error's shape.

## Consequences

- A payment can sit in `CAPTURE_PENDING` until something resolves it. Until Task 002 adds
  reconciliation (re-sending with the same key, or a verified webhook), nothing does. That
  is the safe failure: a stuck payment is visible and recoverable; a wrongly terminal one
  is neither.
- `capturePayment` lets the gateway error propagate. Callers must treat it as "outcome
  unknown", not as "capture failed".
- A reconciler needs nothing beyond the stored payment: the authorization reference, the
  amount and `captureRequestId` are all on it.
- A definitive capture decline is terminal for the payment even if the authorization is
  still held at the gateway. Whether that should instead return the payment to a state
  from which the hold can be voided or a new capture approved is left open until real
  decline behavior is observed in Task 002.
