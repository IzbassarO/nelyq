import { isTerminal, Money, parsePaymentId, type Payment, type PaymentEvent } from '@nelyq/domain';
import { paymentInState } from '@nelyq/domain/testing';
import { describe, expect, it } from 'vitest';
import { capturePayment, type CapturePaymentDependencies } from './capture-payment';
import {
  ConcurrencyConflictError,
  type CaptureAuthorizationRequest,
  type PaymentGateway,
  type PaymentRepository,
} from './ports';

const amount = Money.fromMinorUnits(50_000n, 'USD');

/** Honors the PaymentRepository contract, including the (paymentId, sequence) conflict rule. */
class InMemoryPaymentRepository implements PaymentRepository {
  readonly events: PaymentEvent[] = [];
  private readonly payments = new Map<string, Payment>();

  constructor(...seed: Payment[]) {
    for (const payment of seed) this.payments.set(payment.id, payment);
  }

  findById(id: string): Promise<Payment | undefined> {
    return Promise.resolve(this.payments.get(id));
  }

  save(payment: Payment, events: readonly PaymentEvent[]): Promise<void> {
    const stored = this.payments.get(payment.id);
    if (events.some((event) => event.sequence <= (stored?.version ?? 0))) {
      return Promise.reject(new ConcurrencyConflictError(payment.id));
    }
    this.payments.set(payment.id, payment);
    this.events.push(...events);
    return Promise.resolve();
  }
}

class RecordingGateway implements PaymentGateway {
  readonly requests: CaptureAuthorizationRequest[] = [];
  failWith: Error | undefined;

  captureAuthorization(request: CaptureAuthorizationRequest): Promise<void> {
    this.requests.push(request);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve();
  }
}

function setUp(...seed: Payment[]) {
  const payments = new InMemoryPaymentRepository(...seed);
  const gateway = new RecordingGateway();
  let nextId = 0;
  const deps: CapturePaymentDependencies = {
    payments,
    gateway,
    clock: { now: () => new Date('2026-06-01T12:00:00Z') },
    ids: { generate: () => `capture-evt-${(nextId += 1).toString()}` },
  };
  return { deps, payments, gateway };
}

describe('capturePayment', () => {
  it('records the capture request, then asks the gateway to capture the authorized amount', async () => {
    const authorized = paymentInState('AUTHORIZED', amount);
    const { deps, payments, gateway } = setUp(authorized);

    const result = await capturePayment(deps, { paymentId: authorized.id, amount });

    expect(result).toMatchObject({ outcome: 'CAPTURE_REQUESTED' });
    expect((await payments.findById(authorized.id))?.state).toBe('CAPTURE_PENDING');
    expect(payments.events).toMatchObject([
      {
        type: 'payment.capture_requested',
        eventId: 'capture-evt-1',
        occurredAt: new Date('2026-06-01T12:00:00Z'),
      },
    ]);
    expect(gateway.requests).toEqual([
      {
        paymentId: authorized.id,
        authorizationReference: authorized.authorizationReference,
        amount,
        idempotencyKey: 'capture-evt-1',
      },
    ]);
    expect((await payments.findById(authorized.id))?.captureRequestId).toBe('capture-evt-1');
  });

  it('persists CAPTURE_PENDING before the gateway is called', async () => {
    const authorized = paymentInState('AUTHORIZED', amount);
    const { deps, payments, gateway } = setUp(authorized);
    let stateSeenByGateway: string | undefined;
    gateway.captureAuthorization = async ({ paymentId }) => {
      stateSeenByGateway = (await payments.findById(paymentId))?.state;
    };

    await capturePayment(deps, { paymentId: authorized.id, amount });

    expect(stateSeenByGateway).toBe('CAPTURE_PENDING');
  });

  it('does not touch the gateway or the ledger when policy rejects the proposal', async () => {
    const authorized = paymentInState('AUTHORIZED', amount);
    const { deps, payments, gateway } = setUp(authorized);
    const inflated = Money.fromMinorUnits(5_000_000n, 'USD');

    const result = await capturePayment(deps, { paymentId: authorized.id, amount: inflated });

    expect(result).toEqual({
      outcome: 'REJECTED',
      reasons: [{ code: 'AMOUNT_MISMATCH', proposed: inflated, authorized: amount }],
    });
    expect(gateway.requests).toEqual([]);
    expect(payments.events).toEqual([]);
    expect((await payments.findById(authorized.id))?.state).toBe('AUTHORIZED');
  });

  it('reports an unknown payment without calling the gateway', async () => {
    const { deps, gateway } = setUp();

    const result = await capturePayment(deps, { paymentId: parsePaymentId('missing'), amount });

    expect(result).toEqual({ outcome: 'PAYMENT_NOT_FOUND' });
    expect(gateway.requests).toEqual([]);
  });

  it('captures at most once when the same proposal is submitted again', async () => {
    const authorized = paymentInState('AUTHORIZED', amount);
    const { deps, gateway } = setUp(authorized);
    const proposal = { paymentId: authorized.id, amount };

    await capturePayment(deps, proposal);
    const second = await capturePayment(deps, proposal);

    expect(second).toEqual({
      outcome: 'REJECTED',
      reasons: [{ code: 'CAPTURE_ALREADY_REQUESTED' }],
    });
    expect(gateway.requests).toHaveLength(1);
  });

  it('captures at most once when two requests race', async () => {
    const authorized = paymentInState('AUTHORIZED', amount);
    const { deps, gateway } = setUp(authorized);
    const proposal = { paymentId: authorized.id, amount };

    const results = await Promise.allSettled([
      capturePayment(deps, proposal),
      capturePayment(deps, proposal),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: expect.any(ConcurrencyConflictError) as unknown });
    expect(gateway.requests).toHaveLength(1);
  });

  describe('when the gateway call fails without a known outcome', () => {
    const ambiguousFailures = [
      { kind: 'a timeout', error: new Error('capture timed out') },
      { kind: 'a network error', error: new TypeError('fetch failed') },
      {
        kind: 'a gateway 5xx',
        error: Object.assign(new Error('Service Unavailable'), { status: 503 }),
      },
    ];

    it.each(ambiguousFailures)(
      'leaves the payment CAPTURE_PENDING after $kind',
      async ({ error }) => {
        const authorized = paymentInState('AUTHORIZED', amount);
        const { deps, payments, gateway } = setUp(authorized);
        gateway.failWith = error;

        await expect(capturePayment(deps, { paymentId: authorized.id, amount })).rejects.toBe(
          error,
        );

        const stored = await payments.findById(authorized.id);
        expect(stored?.state).toBe('CAPTURE_PENDING');
        expect(stored?.version).toBe(authorized.version + 1);
      },
    );

    it.each(ambiguousFailures)('records no terminal transition after $kind', async ({ error }) => {
      const authorized = paymentInState('AUTHORIZED', amount);
      const { deps, payments, gateway } = setUp(authorized);
      gateway.failWith = error;

      await expect(capturePayment(deps, { paymentId: authorized.id, amount })).rejects.toBe(error);

      expect(payments.events.map((event) => event.type)).toEqual(['payment.capture_requested']);
      expect(payments.events.map((event) => event.toState).some(isTerminal)).toBe(false);
    });

    it('keeps the capture request ID that was sent, so reconciliation can reuse it', async () => {
      const authorized = paymentInState('AUTHORIZED', amount);
      const { deps, payments, gateway } = setUp(authorized);
      gateway.failWith = new Error('capture timed out');

      await expect(capturePayment(deps, { paymentId: authorized.id, amount })).rejects.toThrow();

      const stored = await payments.findById(authorized.id);
      expect(stored?.captureRequestId).toBe('capture-evt-1');
      expect(gateway.requests.map((request) => request.idempotencyKey)).toEqual(['capture-evt-1']);
    });

    it('does not start a second capture when the proposal is submitted again', async () => {
      const authorized = paymentInState('AUTHORIZED', amount);
      const { deps, payments, gateway } = setUp(authorized);
      const proposal = { paymentId: authorized.id, amount };
      gateway.failWith = new Error('capture timed out');
      await expect(capturePayment(deps, proposal)).rejects.toThrow();
      gateway.failWith = undefined;

      expect(await capturePayment(deps, proposal)).toEqual({
        outcome: 'REJECTED',
        reasons: [{ code: 'CAPTURE_ALREADY_REQUESTED' }],
      });
      expect(gateway.requests).toHaveLength(1);
      expect(payments.events).toHaveLength(1);
      expect((await payments.findById(authorized.id))?.captureRequestId).toBe('capture-evt-1');
    });
  });
});
