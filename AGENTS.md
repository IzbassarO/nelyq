# Instructions for AI coding agents

Nelyq moves real money. These rules apply to every agent and every change. If a rule blocks
you, stop and say so; do not work around it.

## Before you change anything

- Read [docs/architecture/overview.md](docs/architecture/overview.md) before touching a
  package boundary, a port, or the payment state machine.
- Read [ADR 0002](docs/adr/0002-ai-is-not-a-payment-authority.md) before touching anything
  that connects AI output to payments.
- Read [docs/security/threat-model.md](docs/security/threat-model.md) before touching
  webhooks, credentials, or payment execution.
- Read [ADR 0004](docs/adr/0004-unknown-gateway-outcomes.md) before touching gateway error
  handling, retries, or reconciliation.

## Version control

- **Never run `git add`, `git commit`, `git push`, `git pull`, `git merge`, `git rebase`,
  `git reset`, a branch-switching `git checkout`/`git switch`, or `gh pr create`.** The
  repository owner handles version control manually.
- Read-only commands are fine: `git status`, `git diff`, `git log`,
  `git branch --show-current`.
- Leave your changes uncommitted and unstaged.

## Safety invariants

Never weaken one of these to make a test, a type check, or a demo pass. If a test fails
because of an invariant, the test or the calling code is what is wrong.

1. **No AI-controlled financial execution.** Model output is untrusted input. It becomes a
   typed, validated proposal or it is discarded. It never reaches the payment gateway
   without deterministic policy and, where required, human approval. Models get no tools
   that act, and no secrets.
2. **No floating point for money.** Amounts are `Money` (integer minor units, `bigint`).
   No `number` amounts, no `parseFloat`, no `toFixed`, no arithmetic on decimal strings.
3. **The domain has no infrastructure dependencies.** `packages/domain` imports nothing.
   `packages/policy` and `packages/application` import only domain and policy. No Next.js,
   React, HTTP, database, SDK, or `process.env` in any of them. External systems go behind
   a port.
4. **Payment state changes only through `Payment` transitions.** Never construct or patch a
   payment's state directly, and never add a transition just to make a flow convenient.
5. **Financial actions are idempotent.** Persist the intent before calling the gateway, and
   send an idempotency key. A retried or duplicated request must not move money twice.
   Re-sending the same operation reuses its stored identifier (`captureRequestId`); never
   generate a new one.
6. **An unknown outcome is not a failure.** A timeout, network error or gateway 5xx leaves
   the payment where it is, to be reconciled. Only a definitive refusal from the gateway
   may be recorded as `DECLINED`. Never map a thrown error to a terminal state.
7. **Webhooks are untrusted until verified.** No state change from a webhook before its
   signature is verified. A browser or a model saying a payment happened is not evidence.
8. **The server decides from stored state.** Never trust state, amounts, or permissions
   sent by a client.
9. **Validate external input at the boundary** where it enters: HTTP requests, webhook
   bodies, gateway responses, model output, environment variables.

## Secrets

- No secrets in the repository. Only `.env.example`, with empty values, is committed.
- No secrets in frontend code. Nothing sensitive in a `NEXT_PUBLIC_` variable or a client
  component.
- No secrets in logs, error messages, prompts, or test fixtures.

## Honesty in code and docs

- **No fake production integrations.** No stubbed PayPal client that returns success, no
  hardcoded responses, no mock placed where production code would live. Test doubles
  belong in test files.
- No fake data in the UI: no invented transactions, dashboards, or AI output.
- Documentation states what exists. Do not describe a planned mitigation or feature as
  implemented. Update the status in the threat model when it changes.
- Nelyq is not escrow, a bank, a lender, a fiduciary, or a credit scoring system. Do not
  describe it as any of these, in code, UI copy or docs.

## How to work

- Keep the change scoped to the task. No drive-by refactors and no speculative features.
- Add or update tests whenever behavior changes. Test behavior, not implementation
  details.
- Do not change the architecture silently. A new dependency in a core package, a new
  package, a change to a port's contract, or a new payment state needs an ADR in
  `docs/adr/`.
- No `any`, no unsafe type assertions, no `@ts-ignore`, and no disabled lint rules without
  a comment explaining why it is unavoidable.
- No new dependencies without a concrete need. Do not add an ORM, an auth provider, an AI
  SDK, or a PayPal SDK as a side effect of another task.
- Do not create placeholder files or empty modules. If something does not exist yet,
  document the boundary instead.
- Before finishing, run `pnpm lint`, `pnpm typecheck`, `pnpm test` and
  `pnpm format:check`, and report the real results.
