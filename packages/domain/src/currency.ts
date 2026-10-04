import { DomainError } from './errors';

/**
 * Supported currencies and the number of decimal digits in their minor unit (ISO 4217).
 * Supporting a new currency is a deliberate one-line change here, never a runtime default.
 */
const MINOR_UNIT_DIGITS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
} as const;

export type Currency = keyof typeof MINOR_UNIT_DIGITS;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(MINOR_UNIT_DIGITS, value);
}

export function parseCurrency(value: unknown): Currency {
  if (!isCurrency(value)) {
    throw new DomainError('UNSUPPORTED_CURRENCY', 'Unsupported currency');
  }
  return value;
}

export function minorUnitDigits(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency];
}
