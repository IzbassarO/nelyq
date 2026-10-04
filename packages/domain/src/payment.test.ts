import { describe, expect, it } from 'vitest';
import { IllegalPaymentTransitionError } from './errors';
import { parseEventId, parseGatewayReference, parsePaymentId } from './identifiers';
import { Money } from './money';
import { Payment, type PaymentTransition, type TransitionContext } from './payment';
import {
  canTransition,
  isTerminal,
  PAYMENT_STATES,
  type PaymentState,
  type PaymentTransitionName,
} from './payment-state';
import { paymentInState, transitionContexts } from './testing';

const reference = parseGatewayReference('REF-1');
const usd = (amountMinor: bigint) => Money.fromMinorUnits(amountMinor, 'USD');

/**
 * The expected state machine, written out independently of the implementation's table so
 * that an accidental change to either one fails the suite.
 */
const ALLOWED: Record<PaymentState, Partial<Record<PaymentTransitionName, PaymentState>>> = {
  CREATED: { requestBuyerApproval: 'AWAITING_BUYER_APPROVAL', cancel: 'CANCELED' },
  AWAITING_BUYER_APPROVAL: {
    authorize: 'AUTHORIZED',
    cancel: 'CANCELED',
    recordDecline: 'DECLINED',
  },
  AUTHORIZED: { requestCapture: 'CAPTURE_PENDING', voidAuthorization: 'VOIDED' },
  CAPTURE_PENDING: { confirmCapture: 'CAPTURED', recordDecline: 'DECLINED' },
  CAPTURED: {},
  CANCELED: {},
  VOIDED: {},
  DECLINED: {},
};

const ATTEMPT: Record<
  PaymentTransitionName,
  (payment: Payment, ctx: TransitionContext) => PaymentTransition
> = {
  requestBuyerApproval: (payment, ctx) => payment.requestBuyerApproval(reference, ctx),
  authorize: (payment, ctx) => payment.authorize(reference, ctx),
  requestCapture: (payment, ctx) => payment.requestCapture(ctx),
  confirmCapture: (payment, ctx) => payment.confirmCapture(reference, ctx),
  cancel: (payment, ctx) => payment.cancel(ctx),
  voidAuthorization: (payment, ctx) => payment.voidAuthorization(ctx),
  recordDecline: (payment, ctx) => payment.recordDecline(ctx),
};

const TRANSITION_NAMES = Object.keys(ATTEMPT) as PaymentTransitionName[];

describe('Payment.create', () => {
  it('starts in CREATED and records a creation event', () => {
    const ctx = transitionContexts()();
    const id = parsePaymentId('pay-42');
    const { payment, event } = Payment.create({ id, amount: usd(50_000n) }, ctx);

    expect(payment.state).toBe('CREATED');
    expect(payment.version).toBe(1);
    expect(event).toEqual({
      eventId: ctx.eventId,
      type: 'payment.created',
      paymentId: id,
      sequence: 1,
      occurredAt: ctx.occurredAt,
      fromState: null,
      toState: 'CREATED',
      amount: usd(50_000n),
    });
  });

  it('rejects a zero amount', () => {
    expect(() =>
      Payment.create({ id: parsePaymentId('pay-42'), amount: usd(0n) }, transitionContexts()()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PAYMENT_AMOUNT' }) as Error);
  });
});

describe('Payment lifecycle', () => {
  it('walks the full path to CAPTURED, recording one ordered event per transition', () => {
    const ctx = transitionContexts();
    const order = parseGatewayReference('ORDER-9');
    const authorization = parseGatewayReference('AUTH-9');
    const capture = parseGatewayReference('CAPTURE-9');

    const created = Payment.create({ id: parsePaymentId('pay-9'), amount: usd(50_000n) }, ctx());
    const awaiting = created.payment.requestBuyerApproval(order, ctx());
    const authorized = awaiting.payment.authorize(authorization, ctx());
    const pending = authorized.payment.requestCapture(ctx());
    const captured = pending.payment.confirmCapture(capture, ctx());

    const events = [created, awaiting, authorized, pending, captured].map(({ event }) => event);
    expect(
      events.map((event) => [event.sequence, event.type, event.fromState, event.toState]),
    ).toEqual([
      [1, 'payment.created', null, 'CREATED'],
      [2, 'payment.buyer_approval_requested', 'CREATED', 'AWAITING_BUYER_APPROVAL'],
      [3, 'payment.authorized', 'AWAITING_BUYER_APPROVAL', 'AUTHORIZED'],
      [4, 'payment.capture_requested', 'AUTHORIZED', 'CAPTURE_PENDING'],
      [5, 'payment.captured', 'CAPTURE_PENDING', 'CAPTURED'],
    ]);

    expect(captured.payment).toMatchObject({
      state: 'CAPTURED',
      version: 5,
      orderReference: order,
      authorizationReference: authorization,
      captureRequestId: pending.event.eventId,
      captureReference: capture,
    });
    expect(pending.event).toMatchObject({
      authorizationReference: authorization,
      amount: usd(50_000n),
    });
  });

  it('never changes the amount', () => {
    const amount = usd(50_000n);
    expect(paymentInState('CAPTURED', amount).amount.equals(amount)).toBe(true);
  });

  it('leaves the original payment untouched', () => {
    const authorized = paymentInState('AUTHORIZED');
    authorized.requestCapture(transitionContexts()());
    expect(authorized.state).toBe('AUTHORIZED');
    expect(authorized.version).toBe(3);
  });
});

describe('Payment transition matrix', () => {
  const cases = PAYMENT_STATES.flatMap((state) =>
    TRANSITION_NAMES.map((transition) => ({ state, transition, to: ALLOWED[state][transition] })),
  );

  it.each(cases.filter(({ to }) => to !== undefined))(
    '$state --$transition--> $to',
    ({ state, transition, to }) => {
      const before = paymentInState(state);
      const { payment, event } = ATTEMPT[transition](before, transitionContexts()());

      expect(payment.state).toBe(to);
      expect(payment.version).toBe(before.version + 1);
      expect(event).toMatchObject({ fromState: state, toState: to, sequence: payment.version });
    },
  );

  it.each(cases.filter(({ to }) => to === undefined))(
    '$state cannot $transition',
    ({ state, transition }) => {
      const payment = paymentInState(state);
      expect(() => ATTEMPT[transition](payment, transitionContexts()())).toThrow(
        IllegalPaymentTransitionError,
      );
    },
  );

  it('reports what was attempted in a structured error', () => {
    const payment = paymentInState('CREATED');
    expect(() => payment.confirmCapture(reference, transitionContexts()())).toThrow(
      expect.objectContaining({
        code: 'ILLEGAL_PAYMENT_TRANSITION',
        paymentId: payment.id,
        fromState: 'CREATED',
        transition: 'confirmCapture',
      }) as Error,
    );
  });
});

describe('Payment safety properties', () => {
  it('cannot be captured without having been authorized', () => {
    const created = paymentInState('CREATED');
    const ctx = transitionContexts();
    expect(() => created.requestCapture(ctx())).toThrow(IllegalPaymentTransitionError);
    expect(() => created.confirmCapture(reference, ctx())).toThrow(IllegalPaymentTransitionError);
  });

  it('cannot return to AUTHORIZED once captured', () => {
    expect(() => paymentInState('CAPTURED').authorize(reference, transitionContexts()())).toThrow(
      IllegalPaymentTransitionError,
    );
  });

  it('treats CAPTURED, CANCELED, VOIDED and DECLINED as terminal', () => {
    expect(PAYMENT_STATES.filter(isTerminal)).toEqual([
      'CAPTURED',
      'CANCELED',
      'VOIDED',
      'DECLINED',
    ]);
  });

  it('rejects a repeated capture request rather than recording a second one', () => {
    const pending = paymentInState('AUTHORIZED').requestCapture(transitionContexts()()).payment;
    expect(() => pending.requestCapture(transitionContexts()())).toThrow(
      IllegalPaymentTransitionError,
    );
  });

  it('rejects a repeated capture confirmation', () => {
    expect(() =>
      paymentInState('CAPTURED').confirmCapture(reference, transitionContexts()()),
    ).toThrow(IllegalPaymentTransitionError);
  });
});

describe('Capture outcome', () => {
  it('keeps CAPTURE_PENDING open until the external outcome is known', () => {
    expect(isTerminal('CAPTURE_PENDING')).toBe(false);
    expect(canTransition('CAPTURE_PENDING', 'confirmCapture')).toBe(true);
    expect(canTransition('CAPTURE_PENDING', 'recordDecline')).toBe(true);
  });

  it('has no way to start a second capture or go back while the outcome is unknown', () => {
    const pending = paymentInState('CAPTURE_PENDING');
    const ctx = transitionContexts();
    expect(() => pending.requestCapture(ctx())).toThrow(IllegalPaymentTransitionError);
    expect(() => pending.authorize(reference, ctx())).toThrow(IllegalPaymentTransitionError);
    expect(() => pending.voidAuthorization(ctx())).toThrow(IllegalPaymentTransitionError);
    expect(() => pending.cancel(ctx())).toThrow(IllegalPaymentTransitionError);
  });

  it('records a definitive decline of a capture as a terminal, structured event', () => {
    const pending = paymentInState('CAPTURE_PENDING');
    const ctx = transitionContexts()();

    const { payment, event } = pending.recordDecline(ctx);

    expect(isTerminal(payment.state)).toBe(true);
    expect(event).toEqual({
      eventId: ctx.eventId,
      type: 'payment.declined',
      paymentId: pending.id,
      sequence: pending.version + 1,
      occurredAt: ctx.occurredAt,
      fromState: 'CAPTURE_PENDING',
      toState: 'DECLINED',
    });
  });

  it.each(['CREATED', 'AUTHORIZED'] as const)(
    'cannot record a decline while %s, when no authorization or capture is in flight',
    (state) => {
      expect(() => paymentInState(state).recordDecline(transitionContexts()())).toThrow(
        IllegalPaymentTransitionError,
      );
    },
  );
});

describe('Capture request ID', () => {
  it.each(['CREATED', 'AWAITING_BUYER_APPROVAL', 'AUTHORIZED'] as const)(
    'does not exist while %s',
    (state) => {
      expect(paymentInState(state).captureRequestId).toBeUndefined();
    },
  );

  it('is the ID of the capture-requested event', () => {
    const eventId = parseEventId('capture-request-7');
    const { payment, event } = paymentInState('AUTHORIZED').requestCapture({
      eventId,
      occurredAt: new Date(0),
    });

    expect(event.eventId).toBe(eventId);
    expect(payment.captureRequestId).toBe(eventId);
  });

  it('stays the same whichever way the capture is resolved', () => {
    const pending = paymentInState('CAPTURE_PENDING');
    const ctx = transitionContexts();

    expect(pending.captureRequestId).toBeDefined();
    expect(pending.confirmCapture(reference, ctx()).payment.captureRequestId).toBe(
      pending.captureRequestId,
    );
    expect(pending.recordDecline(ctx()).payment.captureRequestId).toBe(pending.captureRequestId);
  });
});
