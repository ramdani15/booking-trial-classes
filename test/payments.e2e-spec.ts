import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';
import { DbService } from '../src/db.service';
import { PaymentsService } from '../src/payments.service';

describe('mock payment provider', () => {
  let app: INestApplication;
  let db: DbService;
  let payments: PaymentsService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    db = app.get(DbService);
    payments = app.get(PaymentsService);
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('is deterministic', async () => {
    expect((await payments.charge('tok_ok')).ok).toBe(true);
    expect((await payments.charge('tok_ok')).ok).toBe(true);

    const declined = await payments.charge('tok_decline');
    expect(declined.ok).toBe(false);
    expect(declined.ok === false && declined.reason).toBe('card_declined');
  });

  it('reserves an idempotency key exactly once', async () => {
    const first = await payments.reserve(1, 'key-1');
    expect(first).not.toBeNull();

    const second = await payments.reserve(1, 'key-1');
    expect(second).toBeNull();

    const { rows } = await db.query(
      `select count(*)::int as n from payment_attempts where idempotency_key = 'key-1'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('reserves before charging, so a concurrent replay cannot double charge', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => payments.reserve(1, 'same-key')),
    );
    expect(attempts.filter((a) => a !== null)).toHaveLength(1);
    expect(attempts.filter((a) => a === null)).toHaveLength(4);
  });

  it('records a refund against the attempt', async () => {
    const attemptId = await payments.reserve(1, 'key-refund');
    const charge = await payments.charge('tok_ok');
    if (!charge.ok || attemptId === null) throw new Error('setup failed');
    await payments.markSucceeded(attemptId, charge.ref);

    const refundRef = await payments.refund(attemptId, charge.ref);
    expect(refundRef).toMatch(/^mock_rf_/);

    const { rows } = await db.query(
      `select status, refund_ref from payment_attempts where id = $1`,
      [attemptId],
    );
    expect(rows[0].status).toBe('refunded');
    expect(rows[0].refund_ref).toBe(refundRef);
  });

  // Money taken, seat gone, refund refused: the one state the system cannot
  // resolve by itself. It has to be recorded, not swallowed.
  it('records refund_failed when the provider refuses the refund', async () => {
    const attemptId = await payments.reserve(1, 'key-refund-fail');
    const charge = await payments.charge('tok_refund_fail');
    if (!charge.ok || attemptId === null) throw new Error('setup failed');
    await payments.markSucceeded(attemptId, charge.ref);

    await expect(payments.providerRefund(charge.ref)).rejects.toThrow();

    const refundRef = await payments.refund(attemptId, charge.ref);
    expect(refundRef).toBeNull();

    const { rows } = await db.query(
      `select status, refund_ref from payment_attempts where id = $1`,
      [attemptId],
    );
    expect(rows[0].status).toBe('refund_failed');
    expect(rows[0].refund_ref).toBeNull();
  });

  it('records a declined charge with its reason', async () => {
    const attemptId = await payments.reserve(1, 'key-declined');
    if (attemptId === null) throw new Error('setup failed');
    await payments.markFailed(attemptId, 'card_declined');

    const { rows } = await db.query(
      `select status, failure_reason from payment_attempts where id = $1`,
      [attemptId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].failure_reason).toBe('card_declined');
  });
});
