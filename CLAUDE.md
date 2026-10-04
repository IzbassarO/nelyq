# CLAUDE.md

The rules in AGENTS.md are binding and are imported here:

@AGENTS.md

## The two you must not forget

- **Do not mutate git state.** No `git add`, `commit`, `push`, `pull`, `merge`, `rebase`,
  `reset`, branch switches, or `gh pr create`. End every task with changes uncommitted and
  report `git status --short`.
- **Nothing an AI produces may move money.** If a task seems to need that, stop and ask.

## Commands

Run from the repository root.

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm install`      | Install dependencies                                |
| `pnpm lint`         | ESLint, including the package-boundary import rules |
| `pnpm typecheck`    | `tsc --noEmit` in every package                     |
| `pnpm test`         | All unit tests (Vitest), one run                    |
| `pnpm format`       | Prettier, write                                     |
| `pnpm format:check` | Prettier, check only                                |
| `pnpm dev`          | Next.js dev server for `apps/web`                   |
| `pnpm build`        | Production build of `apps/web`                      |

One test file: `pnpm vitest run packages/domain/src/payment.test.ts`.

If `pnpm` is not on the PATH, use `npx pnpm@<version>` with the version from
`packageManager` in `package.json`. Do not install tools globally.

## Where things are

| Path                   | Contents                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| `packages/domain`      | `Money`, `Payment` state machine, events, errors. Imports nothing. |
| `packages/policy`      | Deterministic policy. `evaluateCaptureProposal`.                   |
| `packages/application` | Ports (`ports.ts`) and use cases (`capturePayment`).               |
| `packages/paypal`      | README only. Adapter arrives in Task 002.                          |
| `packages/ai`          | README only. No AI code yet.                                       |
| `apps/web`             | Next.js App Router. Static homepage only.                          |
| `docs/`                | Architecture overview, ADRs, threat model.                         |

## Working in this codebase

- Packages are consumed as TypeScript source; there is no build step for them. Relative
  imports have no file extension.
- Core packages compile without DOM or Node types. If `process`, `fetch`, `console` or
  `crypto` fails to type-check in `domain`, `policy` or `application`, that is the boundary
  working. Add a port; do not add the types.
- The domain never reads the clock or generates IDs. Pass `{ eventId, occurredAt }` into
  transitions; in use cases get them from the `Clock` and `IdGenerator` ports.
- Build test payments with `paymentInState(...)` from `@nelyq/domain/testing`. It walks
  real transitions, so fixtures are always in reachable states.
- The transition table lives in `packages/domain/src/payment-state.ts` and is restated in
  `payment.test.ts`. Changing one without the other fails the suite on purpose. A new
  state or transition also needs the overview doc updated, and an ADR.
- Test doubles for ports live in test files, never in `src` as importable production code.
- Tests import `describe`, `it`, `expect` from `vitest` explicitly; there are no globals.
- If you add a workspace package that `apps/web` imports, add it to `transpilePackages` in
  a Next.js config.

## When finishing a task

1. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`.
2. If behavior changed, confirm a test would fail without your change.
3. If a threat-model status changed, update `docs/security/threat-model.md`.
4. Report results as they are, including failures, then `git status --short`.
