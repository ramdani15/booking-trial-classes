import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';
import { DbService } from '../src/db.service';
import { ExpiryService } from '../src/expiry.service';

describe('hold expiry', () => {
  let app: INestApplication;
  let db: DbService;
  let expiry: ExpiryService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    db = app.get(DbService);
    expiry = app.get(ExpiryService);
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('releases a lapsed hold and frees the seat', async () => {
    await db.query(
      `insert into bookings (student_id, trial_class_id, status, expires_at)
       values (1, 1, 'pending_payment', now() - interval '1 second')`,
    );
    const before = await db.query(`select occupied_seats from trial_classes where id = 1`);
    expect(before.rows[0].occupied_seats).toBe(1);

    const released = await expiry.sweep(db, null);
    expect(released).toBe(1);

    const after = await db.query(
      `select t.occupied_seats, b.status, b.expires_at
         from trial_classes t, bookings b
        where t.id = 1 and b.trial_class_id = 1`,
    );
    expect(after.rows[0].occupied_seats).toBe(0);
    expect(after.rows[0].status).toBe('expired');
    expect(after.rows[0].expires_at).toBeNull();
  });

  it('marks a lapsed hold that had a declined payment as payment_failed', async () => {
    const { rows } = await db.query(
      `insert into bookings (student_id, trial_class_id, status, expires_at)
       values (1, 1, 'pending_payment', now() - interval '1 second') returning id`,
    );
    await db.query(
      `insert into payment_attempts (booking_id, idempotency_key, amount_cents, status, failure_reason)
       values ($1, 'k1', 4900, 'failed', 'card_declined')`,
      [rows[0].id],
    );

    await expiry.sweep(db, null);

    const after = await db.query(`select status from bookings where id = $1`, [rows[0].id]);
    expect(after.rows[0].status).toBe('payment_failed');
  });

  it('leaves live holds alone', async () => {
    await db.query(
      `insert into bookings (student_id, trial_class_id, status, expires_at)
       values (1, 1, 'pending_payment', now() + interval '5 minutes')`,
    );
    expect(await expiry.sweep(db, null)).toBe(0);
  });

  it('sweeps only the class it is given', async () => {
    await db.query(
      `insert into bookings (student_id, trial_class_id, status, expires_at) values
         (1, 1, 'pending_payment', now() - interval '1 second'),
         (1, 2, 'pending_payment', now() - interval '1 second')`,
    );

    expect(await expiry.sweep(db, 1)).toBe(1);

    const left = await db.query(
      `select count(*)::int as n from bookings
        where status = 'pending_payment' and expires_at <= now()`,
    );
    expect(left.rows[0].n).toBe(1);
  });
});
