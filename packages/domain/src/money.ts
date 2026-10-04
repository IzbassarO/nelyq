import { minorUnitDigits, parseCurrency, type Currency } from './currency';
import { DomainError } from './errors';

/** The JSON form of {@link Money}. The amount is a string so no JSON parser can make it a float. */
export interface MoneyJSON {
  readonly amountMinor: string;
  readonly currency: Currency;
}

const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;
const NON_NEGATIVE_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * A non-negative amount in a single currency, held as an integer count of minor units
 * (cents for USD, yen for JPY). See docs/adr/0003-money-representation.md.
 */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  static fromMinorUnits(amountMinor: bigint, currency: Currency): Money {
    if (amountMinor < 0n) {
      throw new DomainError('INVALID_MONEY', 'Money cannot be negative');
    }
    return new Money(amountMinor, currency);
  }

  /**
   * Parses a gateway-style decimal string such as "10.00". Never rounds: more fraction
   * digits than the currency has is an error, not a truncation.
   */
  static fromDecimalString(value: string, currency: Currency): Money {
    const digits = minorUnitDigits(currency);
    const [, whole, fraction = ''] = NON_NEGATIVE_DECIMAL.exec(value) ?? [];
    if (whole === undefined || fraction.length > digits) {
      throw new DomainError('INVALID_MONEY', `Not a valid ${currency} decimal amount`);
    }
    return new Money(BigInt(whole + fraction.padEnd(digits, '0')), currency);
  }

  /** Parses the output of {@link Money.toJSON}. The input is treated as untrusted. */
  static fromJSON(value: unknown): Money {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('amountMinor' in value) ||
      !('currency' in value) ||
      typeof value.amountMinor !== 'string' ||
      !NON_NEGATIVE_INTEGER.test(value.amountMinor)
    ) {
      throw new DomainError('INVALID_MONEY', 'Malformed serialized money');
    }
    return new Money(BigInt(value.amountMinor), parseCurrency(value.currency));
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  /** Formats for a payment gateway, e.g. "10.50" for USD and "1050" for JPY. */
  toDecimalString(): string {
    const digits = minorUnitDigits(this.currency);
    const minor = this.amountMinor.toString();
    if (digits === 0) return minor;
    const padded = minor.padStart(digits + 1, '0');
    return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  }

  toJSON(): MoneyJSON {
    return { amountMinor: this.amountMinor.toString(), currency: this.currency };
  }
}
