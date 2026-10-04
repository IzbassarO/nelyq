# Architecture overview

Nelyq is a modular monolith built as a pnpm workspace. One deployable web application; the
logic that decides whether money may move lives in small framework-free packages with a
strict dependency direction.

This document describes what exists today and the boundaries future work must respect. Where
something is planned rather than built, it says so.

## Layers

```
UI                      apps/web (Next.js)
 │
 ▼
application use cases   packages/application
 │
 ▼
domain + policy         packages/domain, packages/policy     ← deterministic, no I/O
 │
 ▼
ports                   interfaces in packages/application
 ▲
 │ implemented by
adapters                packages/paypal, packages/ai, packages/db (planned)
```

Dependencies point inward only:

| Package                | May import                                 | Status                            |
| ---------------------- | ------------------------------------------ | --------------------------------- |
| `packages/domain`      | nothing                                    | implemented                       |
| `packages/policy`      | `domain`                                   | implemented (capture policy)      |
| `packages/application` | `domain`, `policy`                         | implemented (ports, one use case) |
| `packages/paypal`      | `application`, `domain`, PayPal HTTP       | boundary documented only          |
| `packages/ai`          | `application`, `domain`, an AI provider    | boundary documented only          |
| `packages/db`          | `application`, `domain`, a database client | not created yet                   |
| `packages/ui`          | React                                      | not created yet                   |
| `apps/web`             | everything; wires adapters into use cases  | static homepage only              |

The first three rows are enforced, not just documented:

- **Dependency lists.** `domain` declares no dependencies, so under pnpm's strict
  `node_modules` nothing else can be resolved from it.
- **Lint.** `eslint.config.mjs` restricts `domain` to relative imports, and `policy` and
  `application` to relative imports plus `@nelyq/domain` / `@nelyq/policy`.
- **Compiler.** These packages compile with `lib: ES2023` and `types: []`: no DOM, no Node
  globals. `process.env`, `fetch` and `console` do not type-check there.

Packages are consumed as TypeScript source (`exports` points at `src/index.ts`). There is no
build step or build orchestrator because nothing needs one yet.

## Trust boundaries

Everything that crosses into the application from outside is untrusted until validated at
the boundary where it enters.

| Input                           | Trust                                                             |
| ------------------------------- | ----------------------------------------------------------------- |
| Browser requests, UI state      | Untrusted. The server re-reads stored state for every decision.   |
| Uploaded SOWs and deliverables  | Untrusted data. Never instructions, to a human or to a model.     |
| AI model output                 | Untrusted input. Becomes a typed proposal or is discarded.        |
| PayPal webhooks                 | Untrusted until the signature is verified.                        |
| PayPal API responses            | Authenticated by TLS and credentials, still parsed and validated. |
| Stored payment state and events | Authoritative.                                                    |

The rule that shapes the whole system is in
[ADR 0002](../adr/0002-ai-is-not-a-payment-authority.md): nothing an AI produces can move
money. The only path to the payment gateway is:

```
proposal (from a person or an AI evaluation)
  → schema validation into a typed proposal
  → deterministic policy, evaluated against stored payment state
  → human approval when required                    (not implemented yet)
  → application use case persists the intent
  → payment gateway port → PayPal                   (adapter not implemented yet)
  → verified webhook → authoritative internal state (not implemented yet)
```

## Payment lifecycle

`Payment` (in `packages/domain`) is the payment for one milestone: a fixed amount moving
through the states below. It is immutable; each transition returns a new `Payment` and the
domain event that records it, or throws `IllegalPaymentTransitionError`.

### States are Nelyq's, not PayPal's

PayPal has separate status vocabularies for orders, authorizations and captures. Copying
them into the domain would couple the core to one provider and import distinctions Nelyq
does not act on. A Nelyq state exists only if Nelyq makes a different decision because of
it.

| State                     | Meaning                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CREATED`                 | Nelyq has a payment record. Nothing exists at the gateway yet.                                             |
| `AWAITING_BUYER_APPROVAL` | A gateway order exists and the buyer has been asked to approve it.                                         |
| `AUTHORIZED`              | The gateway confirmed a hold on the funds. Not a guarantee the hold is still valid.                        |
| `CAPTURE_PENDING`         | A capture was durably requested; its final external outcome may still need confirmation or reconciliation. |
| `CAPTURED`                | The gateway confirmed the capture. Terminal.                                                               |
| `CANCELED`                | Abandoned before any funds were held. Terminal.                                                            |
| `VOIDED`                  | The authorization was released or expired without a capture. Terminal.                                     |
| `DECLINED`                | The gateway definitively refused the authorization or capture in flight. Terminal.                         |

Decisions worth knowing:

- **No `APPROVED` state.** PayPal reports an order as approved when the buyer consents, but
  that signal arrives through the browser and grants nothing by itself. The fact Nelyq acts
  on is the gateway confirming an authorization, so the payment goes straight from
  `AWAITING_BUYER_APPROVAL` to `AUTHORIZED`.
- **`CAPTURE_PENDING` is separate from `CAPTURED`.** Deciding to capture and learning that
  the capture happened are different facts, possibly minutes apart. The pending state is
  persisted _before_ the gateway is called, which is what stops a second capture attempt.
  `CAPTURED` is recorded only on confirmation from the gateway.
- **`CANCELED` and `VOIDED` are distinct** because they answer a question the audit trail
  will be asked: were funds ever held?
- **An unknown outcome is not a failure.** A timeout, network error or gateway 5xx during
  capture says nothing about whether the funds moved, so it never causes a transition. The
  payment stays `CAPTURE_PENDING`, which has only two exits, both requiring a known
  outcome: `confirmCapture` and `recordDecline`. See
  [ADR 0004](../adr/0004-unknown-gateway-outcomes.md).
- **`DECLINED` is only for a definitive refusal.** There is deliberately no generic
  "failed" state, because that name would not rule out "the call threw". `DECLINED` is
  reachable only from the two states with an authorization or capture in flight. A declined payment is not revived.
  Whether a declined capture should instead allow the still-held authorization to be
  voided or captured again is open until Task 002.
- **One stable idempotency identifier per capture.** Requesting a capture records
  `captureRequestId` on the payment (the ID of the `payment.capture_requested` event).
  Every send of that capture, including retries and reconciliation, must carry that value.
  Task 002 maps it to PayPal's `PayPal-Request-Id`; that mapping is not implemented.
- **`AUTHORIZED` is not valid forever.** Authorizations expire. Expiry and reauthorization
  are intentionally deferred to Task 002; until then nothing checks an authorization's age,
  and no code may assume a capture against it will succeed.
- **The amount never changes.** There is no transition or method that alters it. Partial
  captures and refunds are out of scope for v0.1.

### Transitions

| Transition             | From                                         | To                        |
| ---------------------- | -------------------------------------------- | ------------------------- |
| `requestBuyerApproval` | `CREATED`                                    | `AWAITING_BUYER_APPROVAL` |
| `authorize`            | `AWAITING_BUYER_APPROVAL`                    | `AUTHORIZED`              |
| `requestCapture`       | `AUTHORIZED`                                 | `CAPTURE_PENDING`         |
| `confirmCapture`       | `CAPTURE_PENDING`                            | `CAPTURED`                |
| `cancel`               | `CREATED`, `AWAITING_BUYER_APPROVAL`         | `CANCELED`                |
| `voidAuthorization`    | `AUTHORIZED`                                 | `VOIDED`                  |
| `recordDecline`        | `AWAITING_BUYER_APPROVAL`, `CAPTURE_PENDING` | `DECLINED`                |

Anything not in this table throws. That includes repeats: calling `requestCapture` on a
payment that is already `CAPTURE_PENDING` is an illegal transition, not a no-op, so a
duplicate request can never produce a second event. Whether a repeat is a harmless
duplicate (a redelivered webhook, say) is for the application layer to decide by looking at
the current state first.

The table is defined once in `packages/domain/src/payment-state.ts` and restated
independently in the domain tests, which exercise every state against every transition.

## Domain events

Each transition yields exactly one event. Events are plain structured data:

- `eventId`, `type` (a stable string such as `payment.capture_requested`), `paymentId`
- `sequence`: the event's position in that payment's history, starting at 1
- `occurredAt`, `fromState`, `toState`
- transition-specific data: the amount, or the gateway reference involved

The domain never reads a clock or generates an ID; the caller supplies both. This is not
event sourcing: the current `Payment` is stored as state, and events are the audit record
of how it got there.

## Ports

Defined in `packages/application/src/ports.ts`. Each one exists because the implemented use
case needs it; they grow with use cases, not ahead of them.

| Port                | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `PaymentRepository` | Loads payments; saves new state and appends its events atomically. |
| `PaymentGateway`    | Moves money. Currently only `captureAuthorization`.                |
| `Clock`             | Supplies event timestamps.                                         |
| `IdGenerator`       | Supplies event and payment IDs.                                    |

Two contracts matter for safety:

- **State and audit events commit together.** They go through one `save` call because a
  state change without its event (or the reverse) is a corrupted ledger.
- **`save` rejects a duplicate `(paymentId, sequence)`.** This is optimistic concurrency:
  when two requests race to capture the same payment, exactly one write succeeds, and the
  loser never reaches the gateway.

There is no separate audit-log port yet. Records that are not payment transitions, such as
rejected proposals and human approvals, will need one; it will be designed with the
persistence adapter.

## The implemented use case

`capturePayment` (in `packages/application`) exists to prove the boundaries compose:

1. Load the payment from the repository. Nothing from the caller is trusted about its state.
2. Evaluate the proposal with `evaluateCaptureProposal` (`packages/policy`).
3. Transition to `CAPTURE_PENDING` and persist it with its event.
4. Call the gateway with the **stored** amount and the payment's `captureRequestId` as the
   idempotency key.

If the gateway call throws, the error propagates and the payment stays `CAPTURE_PENDING`.
The outcome is unknown, so the use case records no terminal transition and starts no new
capture. Reconciling that state, by re-sending with the same idempotency key or by a
verified webhook, is Task 002 work.

It is exercised only by tests, with in-memory test doubles. No route calls it, and it has
no authentication or human-approval gate in front of it yet.

## What does not exist yet

- PayPal integration of any kind (Task 002: Sandbox order → authorize → capture → webhook).
- Persistence. There is no database, so nothing is stored outside tests.
- Authentication, authorization and the human-approval gate.
- Any AI functionality.
- Reconciliation of payments left in `CAPTURE_PENDING`.
- Authorization expiry tracking and reauthorization.
- Use cases other than `capturePayment`.
