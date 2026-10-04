# Nelyq

AI-verifiable milestone commerce for service work.

> AI understands the work. PayPal moves the money. Policy keeps humans in control.

Built by team BizAI for the PayPal AI Hackathon 2026.

**This is not production-ready.** It is an early foundation: a payment domain model, a
policy engine and their tests. It has no PayPal integration, no AI features, no
persistence and no authentication yet. See [Status](#status).

## The problem

Paying for service work by milestone depends on someone deciding that a milestone is done.
Clients do not want to pay for unfinished work; contractors do not want to wait on a
client who will not review. The acceptance criteria are usually buried in a contract, and
checking a deliverable against them is slow and contentious.

AI can read the contract and the deliverable. It should not be trusted to release the
payment.

## Core flow

The intended product flow:

1. A client uploads a statement of work (SOW).
2. AI extracts structured milestones and acceptance criteria.
3. The client reviews and confirms them.
4. A PayPal payment is authorized for a milestone.
5. The contractor submits a deliverable.
6. AI evaluates the evidence against each acceptance criterion.
7. A deterministic policy engine decides whether a capture is allowed at all.
8. A human explicitly approves the capture.
9. The server captures the payment through PayPal.
10. A verified PayPal webhook updates Nelyq's authoritative payment state.
11. Every step is recorded in an audit trail.

The first engineering milestone (v0.1) is the payment spine alone, steps 4 and 7–11, with no
AI. Only the framework-free core of that spine is built so far.

Nelyq coordinates payments that PayPal executes. It is not escrow, a bank, a lender or a
fiduciary, and it does not hold funds.

## Safety invariant

**AI never has authority to move money.** Model output is untrusted input:

```
AI output → typed proposal → schema validation → deterministic policy
          → human approval when required → server-side executor → PayPal
          → verified webhook → authoritative internal state
```

A model cannot hold PayPal credentials, choose or change an amount, skip a payment state,
bypass approval, or assert that a webhook occurred. See
[ADR 0002](docs/adr/0002-ai-is-not-a-payment-authority.md).

## Architecture

A modular monolith with hexagonal boundaries. Dependencies point inward:

```
domain  ←  policy  ←  application  ←  adapters (PayPal, AI, persistence)  ←  web
```

The domain and policy packages are pure TypeScript with no I/O. External systems sit behind
ports declared by the application layer. The boundaries are enforced by lint rules and
compiler settings, not just convention.

- [Architecture overview](docs/architecture/overview.md) — layers, trust boundaries, the
  payment state machine
- [ADR 0001: Modular monolith](docs/adr/0001-modular-monolith.md)
- [ADR 0002: AI is not a payment authority](docs/adr/0002-ai-is-not-a-payment-authority.md)
- [ADR 0003: Money representation](docs/adr/0003-money-representation.md)
- [ADR 0004: Unknown gateway outcomes](docs/adr/0004-unknown-gateway-outcomes.md)
- [Threat model](docs/security/threat-model.md)

## Repository structure

```
apps/
  web/            Next.js app (static homepage only)
packages/
  domain/         Money, Payment state machine, domain events and errors
  policy/         Deterministic financial policy (capture proposals)
  application/    Ports and use cases (capturePayment)
  paypal/         Adapter boundary, documented; no code yet
  ai/             Adapter boundary, documented; no code yet
docs/
  architecture/   Overview
  adr/            Architecture decision records
  security/       Threat model
AGENTS.md         Rules for AI coding agents
CLAUDE.md         Practical instructions for Claude Code
```

## Local development

Requires Node.js 22.12 or newer and pnpm 12.

```sh
pnpm install
pnpm dev          # http://localhost:3000
```

No environment variables are needed yet. `.env.example` lists the ones the PayPal adapter
will use.

## Checks

```sh
pnpm lint            # ESLint, including architecture boundary rules
pnpm typecheck       # strict TypeScript across all packages
pnpm test            # unit tests (Vitest)
pnpm format:check    # Prettier
```

## Status

| Area                                            | State                          |
| ----------------------------------------------- | ------------------------------ |
| Workspace, tooling, strict TypeScript           | Done                           |
| `Money` value object                            | Done, tested                   |
| Payment state machine and domain events         | Done, tested                   |
| Capture policy                                  | Done, tested                   |
| Application ports and `capturePayment` use case | Done, tested with test doubles |
| PayPal Sandbox integration                      | Not started (next task)        |
| Webhook verification                            | Not started                    |
| Persistence and audit ledger                    | Not started                    |
| Authentication and human-approval gate          | Not started                    |
| AI milestone extraction and evaluation          | Not started                    |
| Product UI                                      | Not started                    |

## License

[MIT](LICENSE)
