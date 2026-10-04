import type { Currency, Money, Payment, PaymentId, PaymentState } from '@nelyq/domain';

/**
 * A request to capture a payment. Whoever produced it (a person, or eventually an AI
 * evaluation) is not trusted: the proposal is only ever compared against the payment's own
 * recorded facts. Its amount is checked, never used as the amount to capture.
 */
export interface CaptureProposal {
  readonly paymentId: PaymentId;
  readonly amount: Money;
}

export type CaptureRejectionReason =
  | {
      readonly code: 'PAYMENT_MISMATCH';
      readonly proposed: PaymentId;
      readonly evaluated: PaymentId;
    }
  | { readonly code: 'PAYMENT_NOT_AUTHORIZED'; readonly state: PaymentState }
  | { readonly code: 'CAPTURE_ALREADY_REQUESTED' }
  | { readonly code: 'PAYMENT_ALREADY_CAPTURED' }
  | {
      readonly code: 'CURRENCY_MISMATCH';
      readonly proposed: Currency;
      readonly authorized: Currency;
    }
  | { readonly code: 'AMOUNT_MISMATCH'; readonly proposed: Money; readonly authorized: Money };

export type CaptureDecision =
  | { readonly outcome: 'ALLOW' }
  | {
      readonly outcome: 'REJECT';
      readonly reasons: readonly [CaptureRejectionReason, ...CaptureRejectionReason[]];
    };

function stateRejection(state: PaymentState): CaptureRejectionReason | undefined {
  switch (state) {
    case 'AUTHORIZED':
      return undefined;
    case 'CAPTURE_PENDING':
      return { code: 'CAPTURE_ALREADY_REQUESTED' };
    case 'CAPTURED':
      return { code: 'PAYMENT_ALREADY_CAPTURED' };
    default:
      return { code: 'PAYMENT_NOT_AUTHORIZED', state };
  }
}

function amountRejection(proposed: Money, authorized: Money): CaptureRejectionReason | undefined {
  if (proposed.currency !== authorized.currency) {
    return {
      code: 'CURRENCY_MISMATCH',
      proposed: proposed.currency,
      authorized: authorized.currency,
    };
  }
  if (!proposed.equals(authorized)) {
    return { code: 'AMOUNT_MISMATCH', proposed, authorized };
  }
  return undefined;
}

/**
 * Decides whether a capture proposal may proceed. Pure and deterministic: the same proposal
 * and payment always produce the same decision. Every failed check is reported, not just
 * the first.
 */
export function evaluateCaptureProposal(
  proposal: CaptureProposal,
  payment: Payment,
): CaptureDecision {
  if (proposal.paymentId !== payment.id) {
    // Nothing else about the proposal is meaningful against the wrong payment.
    return {
      outcome: 'REJECT',
      reasons: [{ code: 'PAYMENT_MISMATCH', proposed: proposal.paymentId, evaluated: payment.id }],
    };
  }

  const [first, ...rest] = [
    stateRejection(payment.state),
    amountRejection(proposal.amount, payment.amount),
  ].filter((reason) => reason !== undefined);

  return first === undefined
    ? { outcome: 'ALLOW' }
    : { outcome: 'REJECT', reasons: [first, ...rest] };
}
