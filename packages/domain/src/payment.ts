import { DomainError, IllegalPaymentTransitionError } from './errors';
import type { EventId, GatewayReference, PaymentId } from './identifiers';
import type { Money } from './money';
import type {
  AuthorizationVoided,
  BuyerApprovalRequested,
  CaptureRequested,
  PaymentAuthorized,
  PaymentCanceled,
  PaymentCaptured,
  PaymentCreated,
  PaymentDeclined,
  PaymentEvent,
} from './payment-events';
import {
  canTransition,
  PAYMENT_TRANSITIONS,
  type PaymentState,
  type PaymentTransitionName,
} from './payment-state';

/**
 * Supplied by the caller for every transition. The domain never reads a clock or generates
 * an ID itself, so every transition is deterministic and replayable.
 */
export interface TransitionContext {
  readonly eventId: EventId;
  readonly occurredAt: Date;
}

export interface PaymentTransition<Event extends PaymentEvent = PaymentEvent> {
  readonly payment: Payment;
  readonly event: Event;
}

/** Facts recorded by transitions. Each is written once and never changed afterwards. */
interface RecordedFacts {
  readonly orderReference: GatewayReference | undefined;
  readonly authorizationReference: GatewayReference | undefined;
  readonly captureRequestId: EventId | undefined;
  readonly captureReference: GatewayReference | undefined;
}

interface PaymentProps extends RecordedFacts {
  readonly id: PaymentId;
  readonly amount: Money;
  readonly state: PaymentState;
  readonly version: number;
}

/**
 * The payment for one milestone: a fixed amount moving through Nelyq's payment lifecycle.
 *
 * Immutable. Every transition returns a new Payment plus the event that records it, or
 * throws {@link IllegalPaymentTransitionError}. Repeating a transition is illegal like any
 * other: deciding whether a repeat is a harmless duplicate belongs to the application layer.
 *
 * The amount is fixed at creation. There is deliberately no way to change it.
 */
export class Payment implements PaymentProps {
  readonly id: PaymentId;
  readonly amount: Money;
  readonly state: PaymentState;
  /** Number of events applied so far; equals the `sequence` of the latest event. */
  readonly version: number;
  readonly orderReference: GatewayReference | undefined;
  readonly authorizationReference: GatewayReference | undefined;
  /**
   * The stable idempotency identifier of this payment's capture operation: the ID of its
   * capture-requested event. Every send of that capture, including retries and
   * reconciliation, must carry this value. Generating a fresh one risks a double capture.
   */
  readonly captureRequestId: EventId | undefined;
  readonly captureReference: GatewayReference | undefined;

  private constructor(props: PaymentProps) {
    this.id = props.id;
    this.amount = props.amount;
    this.state = props.state;
    this.version = props.version;
    this.orderReference = props.orderReference;
    this.authorizationReference = props.authorizationReference;
    this.captureRequestId = props.captureRequestId;
    this.captureReference = props.captureReference;
    Object.freeze(this);
  }

  static create(
    input: { readonly id: PaymentId; readonly amount: Money },
    ctx: TransitionContext,
  ): PaymentTransition<PaymentCreated> {
    if (input.amount.isZero()) {
      throw new DomainError('INVALID_PAYMENT_AMOUNT', 'A payment must be for more than zero');
    }
    const payment = new Payment({
      id: input.id,
      amount: input.amount,
      state: 'CREATED',
      version: 1,
      orderReference: undefined,
      authorizationReference: undefined,
      captureRequestId: undefined,
      captureReference: undefined,
    });
    return {
      payment,
      event: {
        eventId: ctx.eventId,
        type: 'payment.created',
        paymentId: payment.id,
        sequence: payment.version,
        occurredAt: ctx.occurredAt,
        fromState: null,
        toState: payment.state,
        amount: payment.amount,
      },
    };
  }

  /** An order exists at the gateway and the buyer has been asked to approve it. */
  requestBuyerApproval(
    orderReference: GatewayReference,
    ctx: TransitionContext,
  ): PaymentTransition<BuyerApprovalRequested> {
    const { payment, base } = this.apply('requestBuyerApproval', ctx, { orderReference });
    return {
      payment,
      event: { ...base, type: 'payment.buyer_approval_requested', orderReference },
    };
  }

  /**
   * The gateway has confirmed that the funds are authorized (held, not yet moved).
   *
   * This records that a hold existed when it was confirmed. Authorizations expire, so
   * AUTHORIZED must not be read as "still valid now"; expiry and reauthorization are
   * deferred to the gateway integration.
   */
  authorize(
    authorizationReference: GatewayReference,
    ctx: TransitionContext,
  ): PaymentTransition<PaymentAuthorized> {
    const { payment, base } = this.apply('authorize', ctx, { authorizationReference });
    return { payment, event: { ...base, type: 'payment.authorized', authorizationReference } };
  }

  /**
   * Nelyq has decided to capture. This must be persisted before the gateway is called, so
   * that a second capture attempt finds the payment already past AUTHORIZED.
   *
   * The event's ID becomes `captureRequestId`. The payment then stays CAPTURE_PENDING until
   * the gateway's final outcome is known, however long that takes.
   */
  requestCapture(ctx: TransitionContext): PaymentTransition<CaptureRequested> {
    const { payment, base } = this.apply('requestCapture', ctx, {
      captureRequestId: ctx.eventId,
    });
    const { authorizationReference, amount } = payment;
    if (authorizationReference === undefined) {
      throw new DomainError(
        'PAYMENT_INVARIANT_VIOLATED',
        `Payment ${this.id} is authorized but has no authorization reference`,
      );
    }
    return {
      payment,
      event: { ...base, type: 'payment.capture_requested', authorizationReference, amount },
    };
  }

  /** The gateway has confirmed that the funds were captured. */
  confirmCapture(
    captureReference: GatewayReference,
    ctx: TransitionContext,
  ): PaymentTransition<PaymentCaptured> {
    const { payment, base } = this.apply('confirmCapture', ctx, { captureReference });
    return { payment, event: { ...base, type: 'payment.captured', captureReference } };
  }

  /** Abandoned before any funds were authorized. */
  cancel(ctx: TransitionContext): PaymentTransition<PaymentCanceled> {
    const { payment, base } = this.apply('cancel', ctx);
    return { payment, event: { ...base, type: 'payment.canceled' } };
  }

  /** The authorization was released (voided or expired) without a capture. */
  voidAuthorization(ctx: TransitionContext): PaymentTransition<AuthorizationVoided> {
    const { payment, base } = this.apply('voidAuthorization', ctx);
    return { payment, event: { ...base, type: 'payment.authorization_voided' } };
  }

  /**
   * The gateway definitively refused the authorization or capture that was in flight. The
   * outcome is known: that operation moved no money and never will.
   *
   * Never call this for a timeout, a network error, a gateway 5xx, or any other outcome
   * that is merely unknown. Those leave the payment where it is, to be reconciled.
   */
  recordDecline(ctx: TransitionContext): PaymentTransition<PaymentDeclined> {
    const { payment, base } = this.apply('recordDecline', ctx);
    return { payment, event: { ...base, type: 'payment.declined' } };
  }

  private apply(
    transition: PaymentTransitionName,
    ctx: TransitionContext,
    facts: Partial<RecordedFacts> = {},
  ) {
    if (!canTransition(this.state, transition)) {
      throw new IllegalPaymentTransitionError(this.id, this.state, transition);
    }
    const payment = new Payment({
      id: this.id,
      amount: this.amount,
      state: PAYMENT_TRANSITIONS[transition].to,
      version: this.version + 1,
      orderReference: this.orderReference,
      authorizationReference: this.authorizationReference,
      captureRequestId: this.captureRequestId,
      captureReference: this.captureReference,
      ...facts,
    });
    return {
      payment,
      base: {
        eventId: ctx.eventId,
        paymentId: payment.id,
        sequence: payment.version,
        occurredAt: ctx.occurredAt,
        fromState: this.state,
        toState: payment.state,
      },
    };
  }
}
