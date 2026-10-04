# ADR 0001: Modular monolith with hexagonal boundaries

Status: Accepted (2026-10-04)

## Context

Nelyq combines three things with very different risk profiles: a web UI, AI interpretation
of documents, and payment execution. The team is small and the first milestone is a single
payment flow. The main architectural risk is not scale; it is the rules about when money
may move getting tangled with framework code, provider SDKs or model output, where they
become hard to test and easy to bypass.

## Decision

Build one deployable application as a pnpm workspace of packages, with dependencies
pointing inward:

```
domain  ←  policy  ←  application  ←  adapters (paypal, ai, db)  ←  apps/web
```

- `domain` and `policy` are pure TypeScript: no I/O, no framework, no environment access.
- `application` orchestrates use cases and declares ports (interfaces) for everything
  external.
- Adapters implement ports. `apps/web` is the composition root that wires them together.
- Packages are consumed as TypeScript source. No build step, no task runner.
- The inward rule is enforced by package dependency lists, an ESLint import restriction,
  and compiler settings that exclude DOM and Node globals from the core packages.

## Alternatives considered

- **Microservices.** Rejected. Network boundaries would add distributed-transaction
  problems to a payment flow that currently needs one transaction, with no team or scaling
  pressure to justify them.
- **Everything inside the Next.js app.** Rejected. Route handlers that mix HTTP, PayPal
  calls and state rules are exactly where a check gets skipped. It would also make the
  payment rules untestable without the framework.
- **A build orchestrator (Turborepo, Nx) from the start.** Deferred. The current packages
  type-check and test in seconds. Add one when that stops being true.

## Consequences

- Payment rules are testable in milliseconds with no mocks of frameworks or networks.
- Swapping or adding an adapter does not touch the rules.
- More packages and some indirection (ports) than a single-app layout would have.
- Module boundaries can be promoted to service boundaries later if there is ever a reason;
  the reverse is much harder.
- Adding a dependency to `domain`, or an import of infrastructure from `application`, is an
  architectural change and needs a new ADR, not just a lint suppression.
