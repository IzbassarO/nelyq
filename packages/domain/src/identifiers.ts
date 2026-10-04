import { DomainError } from './errors';

declare const brand: unique symbol;
type Branded<Name extends string> = string & { readonly [brand]: Name };

export type PaymentId = Branded<'PaymentId'>;
export type EventId = Branded<'EventId'>;

/**
 * An identifier assigned by the external payment gateway (an order, authorization or
 * capture). Opaque to the domain: it is stored and passed back, never interpreted.
 */
export type GatewayReference = Branded<'GatewayReference'>;

// Nelyq-issued IDs are embedded in gateway requests and idempotency keys, so keep them URL-safe.
const NELYQ_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Gateway-issued IDs are not ours to constrain beyond "printable, no whitespace, bounded".
const GATEWAY_REFERENCE = /^[\x21-\x7E]{1,255}$/;

function wellFormed(kind: string, pattern: RegExp, value: string): string {
  if (!pattern.test(value)) {
    // The rejected value is deliberately not echoed: it may be large or attacker-controlled.
    throw new DomainError('INVALID_IDENTIFIER', `Malformed ${kind}`);
  }
  return value;
}

// These casts are the only places a plain string becomes a branded identifier.
export const parsePaymentId = (value: string) =>
  wellFormed('payment ID', NELYQ_ID, value) as PaymentId;
export const parseEventId = (value: string) => wellFormed('event ID', NELYQ_ID, value) as EventId;
export const parseGatewayReference = (value: string) =>
  wellFormed('gateway reference', GATEWAY_REFERENCE, value) as GatewayReference;
