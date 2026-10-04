import type { PaymentId } from './identifiers';
import type { PaymentState, PaymentTransitionName } from './payment-state';

export type DomainErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_CURRENCY'
  | 'INVALID_MONEY'
  | 'INVALID_PAYMENT_AMOUNT'
  | 'PAYMENT_INVARIANT_VIOLATED'
  | 'ILLEGAL_PAYMENT_TRANSITION';

/** A violated domain rule. Callers branch on `code`; `message` is for humans and logs. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class IllegalPaymentTransitionError extends DomainError {
  constructor(
    readonly paymentId: PaymentId,
    readonly fromState: PaymentState,
    readonly transition: PaymentTransitionName,
  ) {
    super(
      'ILLEGAL_PAYMENT_TRANSITION',
      `Payment ${paymentId} cannot ${transition} from state ${fromState}`,
    );
  }
}
