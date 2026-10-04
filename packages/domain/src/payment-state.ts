/**
 * Nelyq's view of a payment. These are not PayPal statuses: the reasons for each state are
 * in docs/architecture/overview.md and docs/adr/0004-unknown-gateway-outcomes.md.
 *
 * Three meanings that are easy to get wrong:
 *
 * - AUTHORIZED means the gateway confirmed a hold on the funds at some point. It is not a
 *   promise that the hold is still valid: authorizations expire.
 * - CAPTURE_PENDING means a capture has been durably requested and its final external
 *   outcome may still need confirmation or reconciliation. A timeout, network error or
 *   gateway 5xx leaves the payment here.
 * - DECLINED means the gateway gave a definitive refusal, so the outcome is known. It is
 *   never used for an outcome that is merely unknown.
 */
export const PAYMENT_STATES = [
  'CREATED',
  'AWAITING_BUYER_APPROVAL',
  'AUTHORIZED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'CANCELED',
  'VOIDED',
  'DECLINED',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

interface TransitionRule {
  readonly from: readonly PaymentState[];
  readonly to: PaymentState;
}

/** The complete set of permitted transitions. Anything not listed here is illegal. */
export const PAYMENT_TRANSITIONS = {
  requestBuyerApproval: { from: ['CREATED'], to: 'AWAITING_BUYER_APPROVAL' },
  authorize: { from: ['AWAITING_BUYER_APPROVAL'], to: 'AUTHORIZED' },
  requestCapture: { from: ['AUTHORIZED'], to: 'CAPTURE_PENDING' },
  confirmCapture: { from: ['CAPTURE_PENDING'], to: 'CAPTURED' },
  cancel: { from: ['CREATED', 'AWAITING_BUYER_APPROVAL'], to: 'CANCELED' },
  voidAuthorization: { from: ['AUTHORIZED'], to: 'VOIDED' },
  recordDecline: { from: ['AWAITING_BUYER_APPROVAL', 'CAPTURE_PENDING'], to: 'DECLINED' },
} as const satisfies Record<string, TransitionRule>;

export type PaymentTransitionName = keyof typeof PAYMENT_TRANSITIONS;

const RULES: readonly TransitionRule[] = Object.values(PAYMENT_TRANSITIONS);

export function canTransition(state: PaymentState, transition: PaymentTransitionName): boolean {
  const rule: TransitionRule = PAYMENT_TRANSITIONS[transition];
  return rule.from.includes(state);
}

/** A terminal state has no outgoing transitions. */
export function isTerminal(state: PaymentState): boolean {
  return !RULES.some((rule) => rule.from.includes(state));
}
