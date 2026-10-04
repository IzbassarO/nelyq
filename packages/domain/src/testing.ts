/**
 * Test fixtures, exported as `@nelyq/domain/testing`. Not for production code.
 *
 * Payments are built by walking real transitions, so a fixture can never be in a state the
 * state machine would not allow.
 */
import { parseEventId, parseGatewayReference, parsePaymentId } from './identifiers';
import { Money } from './money';
import { Payment, type TransitionContext } from './payment';
import type { PaymentState } from './payment-state';

export function transitionContexts(): () => TransitionContext {
  let count = 0;
  return () => {
    count += 1;
    return {
      eventId: parseEventId(`evt-${count.toString()}`),
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count)),
    };
  };
}

export function paymentInState(
  state: PaymentState,
  amount: Money = Money.fromMinorUnits(50_000n, 'USD'),
): Payment {
  const ctx = transitionContexts();
  const created = Payment.create({ id: parsePaymentId('pay-1'), amount }, ctx()).payment;
  if (state === 'CREATED') return created;
  if (state === 'CANCELED') return created.cancel(ctx()).payment;

  const awaiting = created.requestBuyerApproval(parseGatewayReference('ORDER-1'), ctx()).payment;
  if (state === 'AWAITING_BUYER_APPROVAL') return awaiting;
  if (state === 'DECLINED') return awaiting.recordDecline(ctx()).payment;

  const authorized = awaiting.authorize(parseGatewayReference('AUTH-1'), ctx()).payment;
  if (state === 'AUTHORIZED') return authorized;
  if (state === 'VOIDED') return authorized.voidAuthorization(ctx()).payment;

  const pending = authorized.requestCapture(ctx()).payment;
  if (state === 'CAPTURE_PENDING') return pending;

  return pending.confirmCapture(parseGatewayReference('CAPTURE-1'), ctx()).payment;
}
