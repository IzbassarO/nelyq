import { parseEventId, type Payment } from '@nelyq/domain';
import {
  evaluateCaptureProposal,
  type CaptureProposal,
  type CaptureRejectionReason,
} from '@nelyq/policy';
import type { Clock, IdGenerator, PaymentGateway, PaymentRepository } from './ports';

export interface CapturePaymentDependencies {
  readonly payments: PaymentRepository;
  readonly gateway: PaymentGateway;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type CapturePaymentResult =
  | { readonly outcome: 'CAPTURE_REQUESTED'; readonly payment: Payment }
  | { readonly outcome: 'REJECTED'; readonly reasons: readonly CaptureRejectionReason[] }
  | { readonly outcome: 'PAYMENT_NOT_FOUND' };

/**
 * Requests capture of an authorized payment.
 *
 * Order matters:
 *   1. Policy evaluates the proposal against the stored payment.
 *   2. CAPTURE_PENDING is persisted. A concurrent duplicate loses here, before any money moves.
 *   3. Only then is the gateway called, with the stored amount (never the proposed one) and
 *      an idempotency key tied to the recorded capture request.
 *
 * If the gateway call throws, the error propagates and the payment stays CAPTURE_PENDING.
 * A thrown error means the outcome is unknown: the funds may have been captured. So no
 * terminal transition is recorded and no new capture is started. Reconciliation re-sends
 * the same capture with the same idempotency key (`captureRequestId`).
 *
 * This does not yet check who is asking. Authentication and the human-approval gate must
 * sit in front of this use case before it is exposed (see docs/security/threat-model.md).
 */
export async function capturePayment(
  deps: CapturePaymentDependencies,
  proposal: CaptureProposal,
): Promise<CapturePaymentResult> {
  const payment = await deps.payments.findById(proposal.paymentId);
  if (payment === undefined) {
    return { outcome: 'PAYMENT_NOT_FOUND' };
  }

  const decision = evaluateCaptureProposal(proposal, payment);
  if (decision.outcome === 'REJECT') {
    return { outcome: 'REJECTED', reasons: decision.reasons };
  }

  const { payment: pending, event } = payment.requestCapture({
    eventId: parseEventId(deps.ids.generate()),
    occurredAt: deps.clock.now(),
  });
  await deps.payments.save(pending, [event]);

  await deps.gateway.captureAuthorization({
    paymentId: pending.id,
    authorizationReference: event.authorizationReference,
    amount: event.amount,
    idempotencyKey: event.eventId,
  });

  return { outcome: 'CAPTURE_REQUESTED', payment: pending };
}
