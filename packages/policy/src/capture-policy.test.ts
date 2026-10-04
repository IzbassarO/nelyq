import { Money, parsePaymentId, type PaymentState } from '@nelyq/domain';
import { paymentInState } from '@nelyq/domain/testing';
import { describe, expect, it } from 'vitest';
import { evaluateCaptureProposal } from './capture-policy';

const authorizedAmount = Money.fromMinorUnits(50_000n, 'USD');

function decide(state: PaymentState, proposedAmount: Money = authorizedAmount) {
  const payment = paymentInState(state, authorizedAmount);
  return evaluateCaptureProposal({ paymentId: payment.id, amount: proposedAmount }, payment);
}

describe('evaluateCaptureProposal', () => {
  it('allows capturing exactly the authorized amount of an authorized payment', () => {
    expect(decide('AUTHORIZED')).toEqual({ outcome: 'ALLOW' });
  });

  it.each([
    ['more', 50_001n],
    ['less', 49_999n],
    ['zero', 0n],
  ])('rejects a proposal for %s than the authorized amount', (_label, amountMinor) => {
    const proposed = Money.fromMinorUnits(amountMinor, 'USD');
    expect(decide('AUTHORIZED', proposed)).toEqual({
      outcome: 'REJECT',
      reasons: [{ code: 'AMOUNT_MISMATCH', proposed, authorized: authorizedAmount }],
    });
  });

  it('rejects a proposal in a different currency, even with the same minor-unit amount', () => {
    expect(decide('AUTHORIZED', Money.fromMinorUnits(50_000n, 'EUR'))).toEqual({
      outcome: 'REJECT',
      reasons: [{ code: 'CURRENCY_MISMATCH', proposed: 'EUR', authorized: 'USD' }],
    });
  });

  it.each(['CREATED', 'AWAITING_BUYER_APPROVAL', 'CANCELED', 'VOIDED', 'DECLINED'] as const)(
    'rejects a payment that is %s rather than authorized',
    (state) => {
      expect(decide(state)).toEqual({
        outcome: 'REJECT',
        reasons: [{ code: 'PAYMENT_NOT_AUTHORIZED', state }],
      });
    },
  );

  it('rejects a payment whose capture is already in flight', () => {
    expect(decide('CAPTURE_PENDING')).toEqual({
      outcome: 'REJECT',
      reasons: [{ code: 'CAPTURE_ALREADY_REQUESTED' }],
    });
  });

  it('rejects a payment that has already been captured', () => {
    expect(decide('CAPTURED')).toEqual({
      outcome: 'REJECT',
      reasons: [{ code: 'PAYMENT_ALREADY_CAPTURED' }],
    });
  });

  it('reports every failed check, not just the first', () => {
    const proposed = Money.fromMinorUnits(1n, 'USD');
    expect(decide('CAPTURED', proposed)).toEqual({
      outcome: 'REJECT',
      reasons: [
        { code: 'PAYMENT_ALREADY_CAPTURED' },
        { code: 'AMOUNT_MISMATCH', proposed, authorized: authorizedAmount },
      ],
    });
  });

  it('rejects a proposal evaluated against a different payment', () => {
    const payment = paymentInState('AUTHORIZED', authorizedAmount);
    const other = parsePaymentId('pay-other');
    expect(
      evaluateCaptureProposal({ paymentId: other, amount: authorizedAmount }, payment),
    ).toEqual({
      outcome: 'REJECT',
      reasons: [{ code: 'PAYMENT_MISMATCH', proposed: other, evaluated: payment.id }],
    });
  });
});
