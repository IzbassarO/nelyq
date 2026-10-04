# Nelyq Task 001 Deep Audit and the Architecture We Should Build Next

## Executive verdict

**Task 001 is ready to become our first commit.** The correction pass fixed the most dangerous flaw in the original state machine: a network timeout, HTTP 5xx, or other ambiguous gateway failure no longer turns into a false terminal payment failure. Instead, Nelyq preserves `CAPTURE_PENDING`, keeps the stable `captureRequestId`, and leaves the transaction recoverable. The corrected implementation reports **152 passing tests**, including explicit tests for timeout/network/5xx ambiguity and repeated capture attempts. fileciteturn0file0

That design is directly aligned with PayPal's current guidance. PayPal recommends `PayPal-Request-Id` for POST/PUT calls; retrying the same operation with the same request ID is specifically intended to prevent duplicate transactions after network timeouts or HTTP 500 responses. PayPal states that the same request ID can return the original operation result rather than execute the financial action again. citeturn1search0turn1search1

My verdict is therefore:

> **GO — commit Task 001. Do not make another architectural rewrite before the first commit.**

However, the research uncovered several things that should materially shape **Task 002**.

The most important are:

1. `CAPTURE_PENDING` must remain non-terminal and reconcilable.
2. `captureRequestId` must become the exact PayPal `PayPal-Request-Id`.
3. A milestone should use **one PayPal Order + one purchase unit + one full final capture**.
4. We must explicitly send `final_capture: true`; PayPal's capture model otherwise permits additional captures. citeturn1search2
5. PayPal can return a **real provider-side `PENDING` capture**, which is different from a lost HTTP response, even if both remain under Nelyq's broader `CAPTURE_PENDING` state. citeturn1search2turn7search3
6. Webhooks are at-least-once delivery and must be authenticated, deduplicated, and safe against replay/reordering. PayPal retries unsuccessful deliveries up to 25 times over three days. citeturn2search2turn7search0
7. Authorization expiry must be represented using PayPal's returned `expiration_time`, not a hard-coded assumption. PayPal's 2026 docs are not perfectly consistent about regional authorization periods, which makes storing provider-supplied expiry the safer design. citeturn4search1turn4search15turn4search16
8. We should not introduce AI yet. Task 002 should finish the **financial spine** first.

The corrected Task 001 architecture also remains consistent with the larger winning-project strategy from the earlier research: AI should propose/evaluate, deterministic policy should decide what is permissible, and PayPal should be the authoritative financial rail. fileciteturn0file2

## What Task 001 got right

The current foundation is much stronger than the average hackathon repository because it already establishes the hard invariants before introducing API/framework complexity. The original implementation created the modular monolith, strict TypeScript workspace, framework-independent payment domain, deterministic policy package, application ports, and documented PayPal/AI boundaries; the correction then hardened failure semantics rather than adding speculative features. fileciteturn0file1 fileciteturn0file0

The resulting dependency direction is the one I would preserve:

```text
                    apps/web
                       │
                       ▼
                 application
                  /         \
                 ▼           ▼
              policy       ports
                 │           │
                 ▼           ▼
               domain     adapters
                            /   \
                           ▼     ▼
                       PayPal   DB
```

The particularly good decisions are these.

### Money is provider-independent and float-free

Using integer minor units as `bigint` and requiring an explicit currency is correct for the Nelyq domain. PayPal itself exchanges monetary values as decimal strings and has currency-specific decimal behavior; keeping floating-point arithmetic completely outside the payment domain avoids silent precision loss. fileciteturn0file1

The boundary should remain:

```text
Domain
Money(25000n, USD)

        ↓ adapter

PayPal
{
  "currency_code": "USD",
  "value": "250.00"
}
```

Never:

```text
250.00 -> JS number -> calculations -> PayPal
```

### The domain does not mirror PayPal statuses

This is also correct.

Nelyq's state machine should represent **what Nelyq knows and permits**, while the PayPal adapter interprets provider-specific statuses.

PayPal authorization resources have statuses such as `CREATED`, `CAPTURED`, `DENIED`, `PARTIALLY_CAPTURED`, `VOIDED`, and `PENDING`, while captures can have `COMPLETED`, `DECLINED`, `PENDING`, `FAILED`, `PARTIALLY_REFUNDED`, and `REFUNDED`. Copying all of those directly into our primary aggregate would make Nelyq a thin projection of PayPal rather than a product domain. citeturn4search0turn1search2

The current architecture should instead evolve like this:

```text
              Provider detail
                   │
                   ▼
          PayPal adapter mapper
                   │
                   ▼
             Typed outcome
                   │
                   ▼
          Nelyq state machine
```

### Persist-before-side-effect is the correct invariant

The current `capturePayment` design persists `CAPTURE_PENDING` and its idempotency identity before calling the external gateway. fileciteturn0file0

That is exactly what we need for the classic distributed-systems failure:

```text
Nelyq                          PayPal

CAPTURE_PENDING saved
     │
     ├──────── CAPTURE ─────────►
     │                           payment succeeds
     │
     X  connection disappears
```

Nelyq must not conclude:

```text
FAILED
```

because the only honest statement is:

```text
We requested capture,
but we do not yet know its authoritative outcome.
```

PayPal's own idempotency guidance explicitly addresses retries after network timeouts and HTTP 500 responses. citeturn1search1

### Stable `captureRequestId` is worth keeping

Claude noted that adding `captureRequestId` to the payment object went slightly beyond pure documentation. I agree with the addition for our **single-final-capture milestone model**.

For Nelyq v1:

```text
one milestone
    =
one PayPal authorization
    =
one intended final capture
    =
one captureRequestId
```

That means:

```text
Nelyq captureRequestId
        ||
        ||
PayPal-Request-Id
```

There should never be:

```text
retry #1 -> request ID A
retry #2 -> request ID B
retry #3 -> request ID C
```

for the same logical capture.

It must always be:

```text
logical capture operation
          │
          └── nelyq-cap-01J...
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
      attempt     retry        retry
        │           │            │
        └──── same PayPal-Request-Id ────
```

PayPal recommends precisely this idempotency mechanism for operations that create or modify payment state. citeturn1search0

## Findings that change Task 002

The deeper PayPal documentation review produced several architecture requirements that were not obvious from Task 001 alone.

### We must explicitly use a final capture

PayPal's capture resource contains `final_capture`, and the documented default is `false`. A false value means the merchant intends to perform additional captures against the same authorization. citeturn1search2

That conflicts with our current Nelyq invariant:

```text
AUTHORIZED
    ↓
requestCapture
    ↓
CAPTURE_PENDING
    ↓
CAPTURED
```

There is no:

```text
PARTIALLY_CAPTURED
CAPTURE_2_PENDING
CAPTURE_3_PENDING
```

and we do not want that complexity for this hackathon.

Therefore Task 002 should send:

```json
{
  "amount": {
    "currency_code": "USD",
    "value": "250.00"
  },
  "final_capture": true
}
```

The important conceptual rule is:

> **Nelyq v1 has one full final capture per milestone.**

PayPal technically supports partial capture and, in some circumstances, capture amounts beyond the original amount, but Nelyq should intentionally reject those capabilities because our product policy says the amount is the client-confirmed milestone amount. citeturn0search9turn6search11turn6search14

That gives us a very nice security property:

```text
SOW
 ↓
AI extracts "$250"
 ↓
HUMAN CONFIRMS $250
 ↓
domain stores 25000 USD
 ↓
PayPal authorization = $250
 ↓
AI later proposes release
 ↓
policy compares against STORED $250
 ↓
PayPal capture = EXACT $250
```

AI never provides the actual amount to the gateway.

### `CAPTURE_PENDING` has two distinct meanings

This is subtle and important.

Situation A:

```text
POST /capture
      ↓
network timeout

PayPal status:
UNKNOWN TO NELYQ
```

Situation B:

```text
POST /capture
      ↓
PayPal responds

capture.status = PENDING
```

PayPal explicitly supports a provider-side `PENDING` capture state, and it also publishes a `PAYMENT.CAPTURE.PENDING` webhook. citeturn1search2turn7search3

At the top-level aggregate, both can reasonably remain:

```text
CAPTURE_PENDING
```

But the persistence layer should distinguish them.

I recommend Task 002 add an operation record concept:

```text
Payment

state:
CAPTURE_PENDING

CaptureOperation

requestId: nelyq-cap-...
providerCaptureId: optional
providerStatus:
  NOT_OBSERVED
  PENDING
  COMPLETED
  DECLINED
  FAILED
lastAttemptAt:
lastError:
```

The aggregate stays clean while our infrastructure retains enough evidence to reconcile reality.

### We should not treat all 4xx responses as `DECLINED`

A `422` can describe multiple very different business conditions: expired authorization, amount problems, already-captured resources, or other validation/business-rule failures. PayPal also distinguishes server errors such as `500` and `503`. citeturn6search10turn6search1

Therefore the adapter should **never** do something like:

```ts
if (!response.ok) {
  return { kind: 'declined' };
}
```

Instead we need an explicit outcome classifier.

Conceptually:

```ts
type CaptureOutcome =
  | {
      kind: 'completed';
      captureId: string;
    }
  | {
      kind: 'pending';
      captureId: string;
      reason?: string;
    }
  | {
      kind: 'declined';
      providerCode?: string;
    }
  | {
      kind: 'confirmed-failure';
      providerCode?: string;
    };
```

And transport ambiguity stays an exception:

```ts
throw new GatewayOutcomeUnknownError(...)
```

The application layer then does:

```text
COMPLETED
   ↓
confirmCapture()
   ↓
CAPTURED

PENDING
   ↓
remain CAPTURE_PENDING

DECLINED / confirmed negative outcome
   ↓
recordDecline()

timeout / 500 where outcome is unknown
   ↓
remain CAPTURE_PENDING
   ↓
reconcile
```

PayPal's capture schema itself distinguishes `COMPLETED`, `DECLINED`, `PENDING`, and `FAILED`, which is why provider mapping must be typed rather than inferred from HTTP success/failure alone. citeturn1search2turn1search11

I would **not change Task 001's `DECLINED` state now**. Instead, Task 002 should document exactly which confirmed PayPal outcomes map into it. If real integration testing demonstrates that `FAILED` needs semantically distinct handling, we can add it deliberately then.

### Buyer approval is not authorization

PayPal's own sequence is:

```text
Create order
     ↓
Buyer approves order
     ↓
order.status = APPROVED
     ↓
merchant calls Authorize Order
     ↓
authorization resource created
```

An order cannot be authorized until buyer approval has occurred. citeturn6search16

Our domain distinction:

```text
AWAITING_BUYER_APPROVAL
          ↓
      AUTHORIZED
```

is therefore directionally correct, but Task 002 must be careful not to assume `onApprove()` itself means funds are authorized.

The server must actually call:

```text
POST /v2/checkout/orders/{order_id}/authorize
```

and parse the returned authorization.

### PayPal authorization itself can be pending

This is the next edge case.

PayPal authorization statuses include:

```text
CREATED
CAPTURED
DENIED
PARTIALLY_CAPTURED
VOIDED
PENDING
```

including `PENDING`, for example while authorization is under review. citeturn4search0turn4search18

So Task 002 should not have this hard-coded assumption:

```text
Authorize API 2xx
      =
Nelyq AUTHORIZED
```

The real mapping should inspect the resource.

We may eventually need:

```text
AWAITING_BUYER_APPROVAL
          ↓
AUTHORIZATION_PENDING
          ↓
AUTHORIZED
```

However, I would only add `AUTHORIZATION_PENDING` once we encounter/document the exact response path during the Sandbox adapter implementation. We should not expand the domain purely speculatively.

### Authorization expiration must be stored from PayPal

This deserves special attention because Nelyq deals with services, and work can take days.

PayPal documentation currently describes a three-day honor period and broadly documents authorization availability up to 29 days. However, another current PayPal guide says U.S. authorization validity may be three days while other regions can have longer windows. The authorization resource itself exposes an `expiration_time`. citeturn4search1turn4search13turn4search15

Therefore **do not encode `authorizedAt + 29 days` into Nelyq**.

Store what PayPal gives us:

```text
paypalAuthorizationId
authorizedAt
authorizationExpiresAt  ← provider supplied
```

Our future UI can then say:

```text
Payment authorized
Capture recommended before:
Oct 7

Authorization expiry:
Oct ...
```

For the hackathon demo, we will capture in minutes. Production semantics can later add reauthorization.

There is also a sandbox-specific trap: PayPal notes that sandbox authorizations do not naturally expire after 29 days, so expiration behavior needs negative testing rather than waiting. citeturn4search4

## Persistence, concurrency, and webhook architecture

Task 002 is where `packages/db` finally becomes justified.

I recommend only four core persistence concepts initially:

```text
payments
payment_events
payment_operations
webhook_inbox
```

Not fifteen tables.

### Payment record

Conceptually:

```text
payments
────────────────────────────────────────
id
state
amount_minor
currency
version

paypal_order_id
paypal_authorization_id
paypal_capture_id

authorization_created_at
authorization_expires_at

capture_request_id

created_at
updated_at
```

Important unique constraints:

```text
paypal_order_id          UNIQUE where non-null
paypal_authorization_id  UNIQUE where non-null
paypal_capture_id        UNIQUE where non-null
capture_request_id       UNIQUE where non-null
```

The `version` remains our optimistic concurrency control.

Task 001 already assumes atomic state + domain-event persistence. fileciteturn0file1 PostgreSQL supports row-level concurrency primitives such as `SELECT ... FOR UPDATE`, while conditional versioned updates can also implement optimistic concurrency safely. citeturn3search1turn3search13

For our architecture, I prefer the latter:

```sql
UPDATE payments
SET state = $new_state,
    version = version + 1
WHERE id = $id
  AND version = $expected_version;
```

Then:

```text
updated rows = 1
    ↓
success

updated rows = 0
    ↓
ConcurrencyConflictError
```

State update and event inserts must be in one database transaction.

### Operation record

A payment aggregate tells us **business state**.

An operation record tells us **what happened at the external boundary**.

Example:

```text
payment_operations
────────────────────────────────────────
id
payment_id

kind = CAPTURE
idempotency_key

provider = PAYPAL
provider_resource_id

status =
  REQUESTED
  PROVIDER_PENDING
  COMPLETED
  DECLINED
  FAILED
  OUTCOME_UNKNOWN

attempt_count
last_http_status
last_paypal_debug_id
created_at
updated_at
```

This makes reconciliation much easier without contaminating the core payment state machine with provider/network internals.

### Webhook inbox

PayPal retries webhook deliveries if it does not receive a `2xx`, potentially **up to 25 times over three days**. PayPal's documentation also describes webhook event IDs as identifiers suitable for deduplication. citeturn2search2turn2search1

So we need:

```text
webhook_inbox
────────────────────────────────────
provider
event_id UNIQUE
event_type
resource_id
received_at
verified_at
processed_at
raw_payload
```

The key invariant is:

```text
same PayPal event ID
        ↓
processed at most once
```

but repeated deliveries should still return a successful response once we know they are a duplicate.

### Verification must happen before mutation

PayPal explicitly says webhook authenticity must be verified; otherwise we have no assurance the sender is PayPal. It supports self-verification or posting the event back to PayPal's signature-verification endpoint. citeturn0search3turn2search2

For Nelyq, I recommend **self-verification eventually**, but postback verification is perfectly reasonable for the first integration.

There is one extremely important implementation detail: self-verification uses the **raw request body** to calculate the CRC32. Re-parsing and re-stringifying the JSON changes bytes and can invalidate verification. citeturn2search2

Next.js App Router Route Handlers expose standard Web `Request` APIs, so our webhook route can read the body with `request.text()` before parsing it. Next.js specifically documents Route Handlers as suitable for webhook endpoints. citeturn3search0turn3search14

The safe shape is:

```text
POST /api/webhooks/paypal
         │
         ▼
read raw body
         │
         ▼
collect PayPal signature headers
         │
         ▼
verify authenticity
         │
     invalid ───► reject / no state mutation
         │
       valid
         ▼
parse JSON
         │
         ▼
insert event_id into webhook_inbox
         │
     duplicate ─► already processed → 2xx
         │
        new
         ▼
reconcile payment
         │
         ▼
commit
         │
         ▼
2xx
```

The relevant signature material includes PayPal transmission headers, webhook ID, and the webhook payload; PayPal documents both cryptographic verification and the verify-signature endpoint. citeturn2search2

### Webhooks cannot be assumed ordered

Even if events usually arrive sequentially, distributed systems do not guarantee that our application will observe them in order. PayPal's own webhook guidance for its APIs warns about duplicates and event-order issues and recommends querying current API state where appropriate rather than blindly trusting event sequence. citeturn2search1turn7search1

So this must never happen:

```ts
if (event.type === 'PAYMENT.CAPTURE.COMPLETED') {
  payment.state = 'CAPTURED';
}
```

without checking the event belongs to the correct payment/capture and the transition is legal.

The domain state machine remains the guard.

## The exact Task 002 scope

We should now freeze the next milestone to one sentence:

> **Nelyq Task 002: implement a real, persistent, idempotent PayPal Sandbox authorization/capture adapter and verified webhook reconciliation path, with no AI.**

The target architecture becomes:

```text
                         Browser
                            │
                            ▼
                    Next.js web/API
                            │
                            ▼
                   Application layer
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        PaymentRepository            PaymentGateway
              │                           │
              ▼                           ▼
          PostgreSQL                  PayPal REST
                                           │
                                           ▼
                                    PayPal Sandbox
                                           │
                                      webhook
                                           │
                                           ▼
                              /api/webhooks/paypal
                                           │
                                      verification
                                           │
                                           ▼
                                      WebhookInbox
                                           │
                                           ▼
                                      Application
                                           │
                                           ▼
                                         Domain
```

The successful demo path should be:

```text
Nelyq milestone
$250.00 USD
       │
       ▼
Create PayPal Order
intent=AUTHORIZE
one purchase unit
       │
       ▼
PayPal Sandbox approval
       │
       ▼
Authorize Order
       │
       ▼
authorization ID + expiration_time stored
       │
       ▼
Nelyq AUTHORIZED
       │
       ▼
Capture requested
       │
       ▼
CAPTURE_PENDING + captureRequestId persisted
       │
       ▼
POST authorization/{id}/capture
PayPal-Request-Id = captureRequestId
amount = exactly $250
final_capture = true
       │
       ├──── timeout/5xx ─────────► CAPTURE_PENDING
       │                             reconciliation
       │
       ├──── PENDING ─────────────► CAPTURE_PENDING
       │
       ├──── confirmed denial ────► DECLINED
       │
       └──── COMPLETED ───────────► CAPTURED
                                      │
                                      ▼
                              verified webhook
                                      │
                                      ▼
                              idempotent ledger
```

Using one purchase unit is a particularly clean fit because PayPal's `AUTHORIZE` intent is documented as not supporting more than one purchase unit in an order. citeturn4search2

For Nelyq that naturally becomes:

> **one milestone = one payment order.**

That is simpler technically and much easier to explain to judges.

We should also cache and reuse PayPal OAuth access tokens server-side until their reported expiration instead of generating a new token for every API call; PayPal's OAuth response includes `expires_in` and its guidance recommends reusing tokens until they expire. Client secret and tokens stay server-side only. citeturn4search5

Task 002 should include PayPal negative testing for at least expired authorization and already-captured authorization, because PayPal explicitly provides those sandbox test paths. citeturn4search4

The minimum test matrix should be:

| Scenario | Expected Nelyq outcome |
|---|---|
| Create AUTHORIZE order | order reference stored |
| Buyer approves + authorize succeeds | `AUTHORIZED` |
| Authorization `PENDING` | no false `AUTHORIZED` |
| Capture `COMPLETED` | `CAPTURED` |
| Capture `PENDING` | `CAPTURE_PENDING` |
| Capture definitive denial | `DECLINED` |
| Network timeout | `CAPTURE_PENDING` |
| PayPal HTTP 500 | `CAPTURE_PENDING` until reconciliation |
| Retry same capture | same `PayPal-Request-Id` |
| Concurrent second capture request | no second gateway financial action |
| Completed webhook | safely reconciles to `CAPTURED` |
| Duplicate webhook | no duplicate event/state mutation |
| Invalid webhook signature | no state mutation |
| Webhook for unknown resource | logged/ignored safely |
| Out-of-order webhook | no illegal state transition |
| Wrong amount/currency proposal | blocked before PayPal |
| Expired authorization | capture prevented/reconciled appropriately |

## Immediate action and Task 002 prompt

Before the first commit, there is **one repository hygiene check** I would do.

Claude says it added:

```text
docs/deep-research-report-4.md
```

to `.prettierignore` because formatting that report failed.

Remember:

> `.prettierignore` does **not** stop Git from committing the file.

Since everything is currently untracked, `git add .` will still add that research report unless it is actually `.gitignore`d or removed.

Run:

```bash
find docs -maxdepth 2 -type f | sort
```

If `deep-research-report-4.md` is a private working/research artifact rather than project documentation, do **not** commit it. Keep the useful ADRs and architecture docs, but avoid polluting the public competition repository with raw internal research transcripts.

After that check, I would make the first commit:

```bash
git add .
git status
git commit -m "feat: establish payment-safe domain foundation"
git push -u origin main
```

Then create Task 002 with **Opus 5.5, high effort** initially. I would move to maximum effort only if the adapter/reconciliation design produces contradictions.

This is the prompt I recommend:

```text
You are the primary senior engineer for Nelyq by team BizAI.

MODEL:
Claude Opus 5.5
Effort: High

This is Task 002.

IMPORTANT GIT RULE:
The repository owner manually handles version control.

You MUST NOT run:
- git add
- git commit
- git push
- git pull
- git merge
- git rebase
- git reset
- branch-changing checkout/switch
- gh pr create
- any Git command that mutates repository state/history

Read-only Git commands are allowed.

Leave all changes uncommitted.

==================================================
MANDATORY READING
==================================================

Before changing code, read:

AGENTS.md
CLAUDE.md
README.md
docs/architecture/overview.md
docs/adr/0001-modular-monolith.md
docs/adr/0002-ai-is-not-a-payment-authority.md
docs/adr/0003-money-representation.md
docs/adr/0004-unknown-gateway-outcomes.md
docs/security/threat-model.md
packages/paypal/README.md

Inspect the complete domain, policy and application code and all tests.

Do not weaken any Task 001 invariant.

==================================================
TASK 002
REAL PAYPAL SANDBOX PAYMENT SPINE
==================================================

Goal:

Implement a real, persistent, idempotent PayPal Sandbox
AUTHORIZE -> CAPTURE -> VERIFIED WEBHOOK reconciliation flow.

NO AI in this task.

Definition of success:

1. Nelyq creates a real PayPal Sandbox order with intent=AUTHORIZE.
2. The buyer can approve it using PayPal Sandbox.
3. Nelyq calls the real Authorize Order endpoint server-side.
4. The PayPal authorization ID and expiration metadata are persisted.
5. Nelyq safely requests a full final capture.
6. CAPTURE_PENDING and a stable captureRequestId are persisted BEFORE the external capture call.
7. captureRequestId maps exactly to PayPal-Request-Id.
8. Every retry of the same logical capture uses the SAME PayPal-Request-Id.
9. Capture uses the Nelyq-recorded amount and currency, never an arbitrary client/AI amount.
10. Capture explicitly sends final_capture=true.
11. COMPLETED results in CAPTURED.
12. PayPal PENDING remains CAPTURE_PENDING.
13. transport timeout / network failure / ambiguous 5xx remains CAPTURE_PENDING.
14. a confirmed provider negative outcome may transition through the existing explicit decline path.
15. PayPal webhooks are authenticated before they mutate payment state.
16. Duplicate webhook events are idempotent.
17. Payment state + domain events remain transactionally consistent.
18. All real PayPal credentials stay server-side.
19. The implementation remains Sandbox-only for this hackathon task.
20. All tests and quality gates pass.

==================================================
PAYPAL SOURCE OF TRUTH
==================================================

Use current official PayPal Developer documentation as the source of truth.

Do not rely on remembered PayPal API behavior.

Important architecture facts to verify against current docs before implementation:

- Orders v2 intent AUTHORIZE
- Authorize Order endpoint
- Payments v2 capture-authorization endpoint
- PayPal-Request-Id idempotency
- capture statuses including COMPLETED/PENDING/DECLINED/FAILED
- authorization statuses including PENDING/DENIED
- authorization expiration_time
- final_capture semantics
- PayPal webhook signature verification
- webhook event IDs and duplicate delivery
- relevant capture webhook events

Document any discrepancy you find between current PayPal documentation
and this task rather than silently guessing.

==================================================
DOMAIN PRINCIPLES
==================================================

Nelyq domain states are NOT PayPal statuses.

Do not copy the complete PayPal state model into packages/domain.

Provider-specific mapping belongs in packages/paypal.

Preserve:

AI output (future)
  ->
typed proposal
  ->
deterministic policy
  ->
human authorization (future UI)
  ->
payment application use case
  ->
PayPal adapter
  ->
verified PayPal observation
  ->
domain transition

The PayPal adapter MUST NOT be allowed to mutate domain state directly.

==================================================
ONE MILESTONE = ONE PAYMENT
==================================================

For Nelyq v1, intentionally support:

one milestone
one PayPal order
one purchase unit
one authorization
one full final capture

Do NOT implement:
- split capture
- partial capture
- multiple captures
- over-capture
- multi-purchase-unit orders
- refunds
- reauthorization
- live PayPal mode
- marketplaces
- payouts

Keep future extension possible, but do not implement it.

==================================================
PERSISTENCE
==================================================

This task may introduce packages/db because persistence is now required.

Use PostgreSQL.

Choose a minimal, maintainable persistence approach.
Do not introduce a large infrastructure framework.

At minimum persist:

payments
payment_events
payment_operations
paypal_webhook_inbox

Preserve optimistic concurrency semantics from Task 001.

Payment state changes and corresponding domain events MUST be committed atomically.

Use unique constraints where appropriate for:

- PayPal order ID
- PayPal authorization ID
- PayPal capture ID
- captureRequestId / idempotency key
- PayPal webhook event ID

Do not depend on in-memory state for financial correctness.

==================================================
PAYMENT OPERATION MODEL
==================================================

Keep provider/network operation detail outside the core payment state where possible.

We need to distinguish:

A) PayPal capture has not produced a known provider result
B) PayPal explicitly returned provider status PENDING
C) PayPal confirmed COMPLETED
D) PayPal confirmed a negative outcome

The top-level payment may remain CAPTURE_PENDING in A and B.

Persist enough operation metadata to reconcile:

- logical operation ID
- stable idempotency key
- PayPal resource ID when known
- last observed provider status
- attempt count
- relevant PayPal debug ID
- timestamps
- last safe diagnostic error metadata

Never persist secrets.

==================================================
PAYPAL ADAPTER
==================================================

Create a real packages/paypal package.

Use PayPal REST APIs against:

https://api-m.sandbox.paypal.com

Do not use fake production adapters.

Do not hardcode success responses.

Native fetch is acceptable if it produces a smaller, clearer adapter than an SDK.

Implement server-side OAuth client-credentials token acquisition and safe reuse until expiration.

Credentials must come only from environment variables.

Never expose PAYPAL_CLIENT_SECRET or access tokens to browser code.

Create a narrow adapter around exactly the capabilities this task needs.

Validate all PayPal JSON before converting it into trusted internal types.

Unknown provider enum/status values must fail safely rather than being silently accepted.

==================================================
IDEMPOTENCY
==================================================

PayPal-Request-Id is mandatory for every supported state-changing PayPal call where the API supports it.

The capture invariant is especially strict:

Payment.requestCapture()
  generates/stores one captureRequestId
      ->
persist
      ->
PayPal capture
      PayPal-Request-Id = same captureRequestId

A retry of that same logical capture MUST reuse it.

Never generate a fresh PayPal-Request-Id merely because the previous HTTP request timed out.

Test this explicitly.

==================================================
CAPTURE RULES
==================================================

The capture amount and currency come from the trusted persisted Payment.

Do not use client-provided amount as execution authority.

Do not use a future AI-provided amount as execution authority.

For v1:
- capture exactly the authorized milestone amount
- same currency
- final_capture=true

Keep policy checks in packages/policy / application flow.

==================================================
AMBIGUOUS FAILURE RULE
==================================================

A thrown fetch error, timeout, connection reset, 5xx with ambiguous outcome, or other condition that cannot prove the financial result MUST NOT produce DECLINED.

CAPTURE_PENDING remains.

The operation becomes eligible for reconciliation/retry with the SAME idempotency key.

Never weaken this invariant just to simplify code.

==================================================
AUTHORIZATION LIFETIME
==================================================

Do NOT hard-code a universal 29-day lifetime.

Persist PayPal authorization expiration_time when returned.

Do not implement reauthorization yet.

If the authorization can no longer safely be captured, surface a typed non-success condition rather than pretending it is still valid.

Document production reauthorization as deferred.

==================================================
WEBHOOKS
==================================================

Add a dedicated PayPal webhook route.

Requirements:

- preserve the raw request body
- verify PayPal authenticity before state mutation
- use PAYPAL_WEBHOOK_ID
- validate required PayPal transmission headers
- parse payload only after obtaining the raw body needed for verification
- validate payload schema
- persist event ID for deduplication
- duplicate event delivery must be harmless
- unknown event types must not mutate payment state
- unknown payment/capture resources must not mutate unrelated payments
- illegal domain transitions remain illegal
- never trust a browser notification in place of PayPal observation

Subscribe/document only the events actually useful for this milestone,
including relevant capture completion/pending/denial events.

Do not assume webhook delivery order.

==================================================
WEBHOOK TRANSACTION FLOW
==================================================

Conceptually:

raw HTTP request
    ->
signature verification
    ->
schema validation
    ->
dedupe by PayPal event ID
    ->
correlate PayPal resource to Nelyq payment
    ->
legal application/domain reconciliation
    ->
persist payment + domain events + processed webhook atomically
    ->
2xx

If processing fails safely after verification, do not mark the event processed.

==================================================
NEXT.JS BOUNDARY
==================================================

Route Handlers are infrastructure adapters.

They must:
- parse/validate HTTP input
- authenticate/authorize where applicable
- call application use cases
- map results to HTTP responses

They must NOT:
- contain payment state-machine logic
- decide capture policy
- contain PayPal response-mapping business logic
- directly mutate database payment rows

Do not create giant route.ts files.

==================================================
AUTH / HUMAN APPROVAL
==================================================

Task 001 correctly noted that full user authentication and human approval are not implemented.

Do not fake production authentication.

For this Task 002 infrastructure spike, keep capture execution isolated and clearly Sandbox-only.

Do not expose an unauthenticated production-like money-moving route.

If a minimal demo-only mechanism is necessary to exercise Sandbox from the browser,
make the boundary explicit, sandbox-only, documented, and impossible to enable accidentally in a live environment.

Do not claim production authorization controls exist when they do not.

==================================================
TESTING
==================================================

Do not call real PayPal from normal unit tests.

Use deterministic fake HTTP boundaries/fixtures for adapter tests.

Also provide a separate explicit Sandbox smoke/integration path that requires real environment credentials and is NOT part of default CI.

At minimum test:

DOMAIN/APPLICATION
- all Task 001 tests remain green
- no duplicate capture request
- ambiguous gateway error leaves CAPTURE_PENDING
- same captureRequestId survives retry/reconciliation

PAYPAL ADAPTER
- decimal Money mapping
- AUTHORIZE order request mapping
- authorize response mapping
- authorization expiration_time parsing
- capture request sends final_capture=true
- capture request sends exact stored amount/currency
- capture request sends correct PayPal-Request-Id
- COMPLETED mapping
- PENDING mapping
- DECLINED mapping
- FAILED mapping handled deliberately
- unknown provider status rejected safely
- structured PayPal error parsing
- secrets never returned through public DTOs

PERSISTENCE
- optimistic concurrency conflict
- payment/event atomicity
- capture operation idempotency uniqueness
- provider reference uniqueness
- payment rehydration preserves invariants

WEBHOOK
- valid signature path
- invalid signature cannot mutate state
- missing signature headers rejected
- duplicate event is idempotent
- completed event reconciliation
- pending event reconciliation
- denied event reconciliation
- unknown event ignored safely
- unknown resource ignored/logged safely
- out-of-order event cannot violate state machine

RECONCILIATION
- timeout then retry uses the SAME idempotency key
- a later COMPLETED observation resolves CAPTURE_PENDING
- provider PENDING stays non-terminal

==================================================
DOCUMENTATION
==================================================

Add/update:

docs/architecture/overview.md
docs/security/threat-model.md
packages/paypal/README.md

Add appropriate ADRs for:

- PayPal adapter and provider-state mapping
- payment persistence / concurrency strategy
- webhook inbox + idempotent reconciliation

Add:

docs/paypal/sandbox-setup.md

It should explain:

- creating/using sandbox business and personal accounts
- required environment variables
- registering a webhook
- events to subscribe to
- how to run the real sandbox smoke test
- what should be visible in PayPal and Nelyq
- how to reset/retry safely

Do not commit credentials.

==================================================
NO AI
==================================================

Do not add:
- OpenAI
- Anthropic
- Gemini
- embeddings
- vector DB
- agents
- prompts
- contract extraction
- deliverable evaluation

Task 002 is the trusted financial spine.

==================================================
QUALITY GATES
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build

Also run any database migration/persistence tests you add.

If real PayPal credentials are available, describe but do not silently execute
irreversible or unexpected sandbox operations.
Ask before executing an interactive sandbox buyer approval flow if necessary.

Inspect:

git status --short
git diff --stat
git diff

Do NOT stage.
Do NOT commit.
Do NOT push.

==================================================
FINAL RESPONSE
==================================================

Report:

1. architecture decisions
2. packages/files added
3. database schema and constraints
4. PayPal API calls implemented
5. exact provider -> Nelyq status mapping
6. idempotency strategy
7. webhook verification strategy
8. reconciliation strategy
9. tests added and total test count
10. commands run and results
11. sandbox manual steps still required
12. security limitations still open
13. exact git status --short
14. suggested commit message

Explicitly end with:

"Changes are left uncommitted for the repository owner to review."
```

The architectural checkpoint after Task 002 should be brutally simple:

```text
Can Nelyq lose an HTTP response
after PayPal actually captured $250
and still converge to the truth
without charging twice?

               YES
```

When that answer is demonstrably **yes**, we will have solved the hardest payment-engineering part of Nelyq.

Only after that should Task 003 introduce the actual product workflow:

```text
Contract
   ↓
milestone
   ↓
$250 PayPal authorization
   ↓
deliverable
   ↓
AI evidence evaluation
   ↓
deterministic policy
   ↓
human approval
   ↓
the Task 002 payment engine
   ↓
verified capture
```

That order of development is the strongest path both technically and for judging: **first make money movement correct, then make AI useful, then make the experience beautiful.**