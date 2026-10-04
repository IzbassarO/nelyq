# packages/ai

**Status: boundary only. There is no AI functionality in this repository yet.**

No provider SDK is installed and no code exists here. This document defines the boundary
the implementation must respect. The reasoning is in
[ADR 0002](../../docs/adr/0002-ai-is-not-a-payment-authority.md).

## What this package will be

The adapter for the two AI tasks in the product:

1. Extract structured milestones and acceptance criteria from a SOW.
2. Evaluate a submitted deliverable against each acceptance criterion.

## The boundary

```
untrusted documents ──► model ──► untrusted output
                                        │
                                 schema validation     (this package)
                                        │
                                  typed proposal       (e.g. CaptureProposal in @nelyq/policy)
                                        │
                          deterministic policy + human approval
                                        │
                                 application use case
```

**Model output cannot invoke payment execution.** The only thing this package may hand to
the rest of the system is a validated, typed value. What happens next is decided by
`packages/policy`, a human, and the payment state machine.

## Rules for the implementation

- **Output is validated or discarded.** Every model response is parsed against an explicit
  schema. There is no fallback that passes raw text onward.
- **Documents are data.** SOW and deliverable content goes into the prompt as clearly
  delimited material to analyze. It is never placed where instructions go, and nothing in
  it is followed.
- **No tools that act.** The model is not given tools that reach the payment gateway, the
  database, or arbitrary network access.
- **No secrets.** No PayPal credential or other secret is ever included in a prompt, and
  this package must not import `packages/paypal`.
- **No amounts from the model.** Payment amounts come from client-confirmed milestones.
  A model-produced amount is, at most, something policy compares against the stored one.
- **Uncertainty is surfaced.** An evaluation that cannot be parsed, or that the model is
  unsure of, is reported as such. It never defaults to "criterion met".

## Not decided yet

The provider, the validation library, and the shape of the milestone and evaluation types.
These will be chosen in the task that introduces the first AI feature, with an ADR if the
choice constrains the architecture.
