/**
 * Ports: what the application needs from the outside world. Adapters implement these;
 * use cases depend only on the interfaces. A port grows when a use case needs it to, not
 * before.
 */
import type { GatewayReference, Money, Payment, PaymentEvent, PaymentId } from '@nelyq/domain';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Returns a new unique ID. The caller validates it before use. */
  generate(): string;
}

/** Thrown by {@link PaymentRepository.save} when another writer got there first. */
export class ConcurrencyConflictError extends Error {
  constructor(readonly paymentId: PaymentId) {
    super(`Payment ${paymentId} was modified concurrently`);
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * Persistence for payments and their audit trail.
 *
 * State and events are saved through one method because they must commit atomically: a
 * state change without its audit event, or the reverse, is a corrupted ledger.
 */
export interface PaymentRepository {
  findById(id: PaymentId): Promise<Payment | undefined>;

  /**
   * Atomically stores the payment's new state and appends its events.
   *
   * Must reject with {@link ConcurrencyConflictError} if any event's (paymentId, sequence)
   * already exists. That is what makes concurrent duplicate requests safe: exactly one
   * writer wins. Stored events are append-only and must never be updated or deleted.
   */
  save(payment: Payment, events: readonly PaymentEvent[]): Promise<void>;
}

export interface CaptureAuthorizationRequest {
  readonly paymentId: PaymentId;
  readonly authorizationReference: GatewayReference;
  readonly amount: Money;
  /**
   * Identifies this capture operation, not this call. It is the payment's
   * `captureRequestId` and is the same on every send of the same capture, including
   * retries and reconciliation. The adapter must forward it to the gateway unchanged so
   * that sending twice can never capture twice.
   */
  readonly idempotencyKey: string;
}

export interface PaymentGateway {
  /**
   * Asks the gateway to capture previously authorized funds.
   *
   * Resolving means the gateway accepted the request, not that the money has moved: the
   * payment only becomes CAPTURED when the gateway's verified confirmation is recorded.
   *
   * Rejecting means the outcome is unknown. A timeout, a dropped connection or a gateway
   * 5xx may or may not have captured the funds, so a thrown error is never evidence of a
   * decline and must never drive a terminal transition. The payment stays CAPTURE_PENDING
   * until it is reconciled.
   *
   * There is deliberately no way to report a definitive decline through this method yet.
   * When the gateway integration needs one it must be an explicit typed result, not
   * something inferred from an error.
   */
  captureAuthorization(request: CaptureAuthorizationRequest): Promise<void>;
}
