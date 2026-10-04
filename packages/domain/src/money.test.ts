import { describe, expect, it } from 'vitest';
import { parseCurrency } from './currency';
import { Money } from './money';

const domainError = (code: string) => expect.objectContaining({ code }) as Error;

describe('Money construction', () => {
  it('holds an integer count of minor units and an explicit currency', () => {
    const money = Money.fromMinorUnits(1050n, 'USD');
    expect(money.amountMinor).toBe(1050n);
    expect(money.currency).toBe('USD');
  });

  it('allows zero', () => {
    expect(Money.fromMinorUnits(0n, 'EUR').isZero()).toBe(true);
  });

  it('rejects negative amounts', () => {
    expect(() => Money.fromMinorUnits(-1n, 'USD')).toThrow(domainError('INVALID_MONEY'));
  });

  it('is immutable', () => {
    const money = Money.fromMinorUnits(100n, 'USD');
    expect(() => {
      Object.assign(money, { amountMinor: 999n });
    }).toThrow(TypeError);
    expect(money.amountMinor).toBe(100n);
  });
});

describe('Money equality', () => {
  it('is equal when amount and currency both match', () => {
    expect(Money.fromMinorUnits(500n, 'USD').equals(Money.fromMinorUnits(500n, 'USD'))).toBe(true);
  });

  it('differs when the amount differs', () => {
    expect(Money.fromMinorUnits(500n, 'USD').equals(Money.fromMinorUnits(501n, 'USD'))).toBe(false);
  });

  it('differs when only the currency differs', () => {
    expect(Money.fromMinorUnits(500n, 'USD').equals(Money.fromMinorUnits(500n, 'EUR'))).toBe(false);
  });
});

describe('Money decimal strings (gateway boundary)', () => {
  it.each([
    ['10.00', 'USD', 1000n],
    ['10.5', 'USD', 1050n],
    ['10', 'USD', 1000n],
    ['0.05', 'EUR', 5n],
    ['0', 'GBP', 0n],
    ['1000', 'JPY', 1000n],
  ] as const)('parses %s %s as %d minor units', (text, currency, expected) => {
    expect(Money.fromDecimalString(text, currency).amountMinor).toBe(expected);
  });

  it.each([
    { text: '10.005', currency: 'USD', why: 'more precision than the currency has' },
    { text: '1.5', currency: 'JPY', why: 'fraction in a zero-decimal currency' },
    { text: '-1.00', currency: 'USD', why: 'negative' },
    { text: '1e3', currency: 'USD', why: 'exponent notation' },
    { text: '1,000.00', currency: 'USD', why: 'thousands separator' },
    { text: '01.00', currency: 'USD', why: 'leading zero' },
    { text: '.50', currency: 'USD', why: 'missing whole part' },
    { text: '10.', currency: 'USD', why: 'dangling decimal point' },
    { text: ' 10.00', currency: 'USD', why: 'whitespace' },
    { text: '', currency: 'USD', why: 'empty' },
    { text: 'NaN', currency: 'USD', why: 'not a number' },
  ] as const)('rejects "$text" $currency ($why)', ({ text, currency }) => {
    expect(() => Money.fromDecimalString(text, currency)).toThrow(domainError('INVALID_MONEY'));
  });

  it.each([
    [1050n, 'USD', '10.50'],
    [5n, 'USD', '0.05'],
    [0n, 'USD', '0.00'],
    [1000n, 'JPY', '1000'],
  ] as const)('formats %d %s minor units as %s', (amountMinor, currency, expected) => {
    expect(Money.fromMinorUnits(amountMinor, currency).toDecimalString()).toBe(expected);
  });

  it('round-trips amounts beyond the range a float can represent exactly', () => {
    const beyondFloat = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const money = Money.fromMinorUnits(beyondFloat, 'USD');
    expect(Money.fromDecimalString(money.toDecimalString(), 'USD').amountMinor).toBe(beyondFloat);
  });
});

describe('Money JSON (persistence boundary)', () => {
  it('serializes the amount as a string, never a JSON number', () => {
    expect(JSON.stringify(Money.fromMinorUnits(1050n, 'USD'))).toBe(
      '{"amountMinor":"1050","currency":"USD"}',
    );
  });

  it('round-trips through JSON', () => {
    const money = Money.fromMinorUnits(123_456_789n, 'GBP');
    expect(Money.fromJSON(JSON.parse(JSON.stringify(money))).equals(money)).toBe(true);
  });

  it.each([
    { why: 'numeric amount', value: { amountMinor: 1050, currency: 'USD' } },
    { why: 'decimal amount', value: { amountMinor: '10.50', currency: 'USD' } },
    { why: 'negative amount', value: { amountMinor: '-5', currency: 'USD' } },
    { why: 'empty amount', value: { amountMinor: '', currency: 'USD' } },
    { why: 'missing currency', value: { amountMinor: '1050' } },
    { why: 'missing amount', value: { currency: 'USD' } },
    { why: 'null', value: null },
    { why: 'a string', value: '1050 USD' },
  ])('rejects $why', ({ value }) => {
    expect(() => Money.fromJSON(value)).toThrow(domainError('INVALID_MONEY'));
  });

  it('rejects an unsupported currency', () => {
    expect(() => Money.fromJSON({ amountMinor: '100', currency: 'XXX' })).toThrow(
      domainError('UNSUPPORTED_CURRENCY'),
    );
  });
});

describe('parseCurrency', () => {
  it('accepts a supported currency code', () => {
    expect(parseCurrency('EUR')).toBe('EUR');
  });

  it.each(['usd', 'XXX', '', 'constructor', 840, null])('rejects %j', (value) => {
    expect(() => parseCurrency(value)).toThrow(domainError('UNSUPPORTED_CURRENCY'));
  });
});
