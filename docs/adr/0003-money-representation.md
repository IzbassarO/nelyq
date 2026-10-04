# ADR 0003: Money as integer minor units

Status: Accepted (2026-10-04)

## Context

JavaScript's `number` is a binary float: `0.1 + 0.2 !== 0.3`, and integers above 2^53 lose
precision silently. Payment systems that use it for amounts eventually charge someone the
wrong amount. PayPal's API exchanges amounts as decimal strings (`"10.00"`), and the number
of decimal places depends on the currency (two for USD, none for JPY).

## Decision

`Money` in `packages/domain` is an immutable value object holding:

- `amountMinor: bigint` — an integer count of the currency's minor unit (cents for USD).
- `currency` — one of an explicit set of supported ISO 4217 codes, each with its
  minor-unit digit count.

Rules:

- **`bigint`, not `number`.** It is exact at any magnitude, and mixing it with a `number`
  in arithmetic throws a `TypeError` instead of quietly producing a float.
- **Never negative.** Direction (payment, refund) is expressed by the operation, not the
  sign.
- **Currency is always explicit.** There is no default currency. Two amounts are equal only
  if both the currency and the amount match.
- **Supported currencies are a closed list** (currently USD, EUR, GBP, JPY). Adding one is a
  one-line code change that states its minor-unit digits. An unknown code is an error.
- **Serialization is explicit, with two named boundaries:**
  - `toJSON()` / `Money.fromJSON()` for persistence and transport:
    `{ "amountMinor": "1050", "currency": "USD" }`. The amount is a string so no JSON parser
    can turn it into a float. `fromJSON` treats its input as untrusted.
  - `toDecimalString()` / `Money.fromDecimalString()` for gateways: `"10.50"`.
- **Parsing never rounds.** `"10.005"` as USD is an error, not `10.00` or `10.01`.
  Exponent notation, separators, signs and whitespace are rejected.

## Not included

- **Arithmetic.** Nothing in v0.1 adds or subtracts money, so `Money` has no such methods.
  When a use case needs them (milestone totals, partial captures), they must throw on
  mismatched currencies rather than coerce.
- **Currency conversion.** Out of scope.
- **Amount limits.** A maximum payment size is a policy rule, not a property of money.

## Alternatives considered

- **`number` in minor units.** Safe below 2^53 and convenient for JSON, but nothing stops
  `amount * 0.1` or a JSON float from entering. `bigint` makes those mistakes loud.
- **A decimal library.** Adds a dependency to the one package that should have none, for
  capabilities (arbitrary precision arithmetic) that are not needed.
- **Decimal strings throughout.** Matches PayPal's wire format but makes every comparison a
  parsing problem and bakes one provider's format into the domain.

## Consequences

- `JSON.stringify` on a raw `bigint` throws, so amounts cannot leak across a boundary
  without going through `toJSON()` or `toDecimalString()`. This is intended.
- Database columns for amounts must be integer or numeric types, never floating point.
- UI formatting for display (`$10.50`) belongs to the UI layer and must start from
  `Money`, not from a float.
