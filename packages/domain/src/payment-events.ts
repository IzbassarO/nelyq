import type { EventId, GatewayReference, PaymentId } from './identifiers';
import type { Money } from './money';
import type { PaymentState } from './payment-state';

interface PaymentEventBase<Type extends string> {
  readonly eventId: EventId;
  /** Stable machine-readable name. Renaming one is a breaking change to the audit ledger. */
  readonly type: Type;
  readonly paymentId: PaymentId;
  /**
   * Position of this event in the payment's history, starting at 1. A store that enforces
   * uniqueness of (paymentId, sequence) gets optimistic concurrency control for free.
   */
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly fromState: PaymentState | null;
  readonly toState: PaymentState;
}

export interface PaymentCreated extends PaymentEventBase<'payment.created'> {
  readonly amount: Money;
}

export interface BuyerApprovalRequested extends PaymentEventBase<'payment.buyer_approval_requested'> {
  readonly orderReference: GatewayReference;
}

export interface PaymentAuthorized extends PaymentEventBase<'payment.authorized'> {
  readonly authorizationReference: GatewayReference;
}

/**
 * `eventId` is also the capture operation's idempotency identifier: it is stored on the
 * payment as `captureRequestId` and must accompany every send of this capture.
 */
export interface CaptureRequested extends PaymentEventBase<'payment.capture_requested'> {
  readonly authorizationReference: GatewayReference;
  readonly amount: Money;
}

export interface PaymentCaptured extends PaymentEventBase<'payment.captured'> {
  readonly captureReference: GatewayReference;
}

export type PaymentCanceled = PaymentEventBase<'payment.canceled'>;
export type AuthorizationVoided = PaymentEventBase<'payment.authorization_voided'>;
export type PaymentDeclined = PaymentEventBase<'payment.declined'>;

export type PaymentEvent =
  | PaymentCreated
  | BuyerApprovalRequested
  | PaymentAuthorized
  | CaptureRequested
  | PaymentCaptured
  | PaymentCanceled
  | AuthorizationVoided
  | PaymentDeclined;
