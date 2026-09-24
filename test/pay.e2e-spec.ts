import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';
import { DbService } from '../src/db.service';

describe('POST /bookings/:id/pay', () => {
  let app: INestApplication;
  let db: DbService;
  let keyCounter = 0;

  const hold = (student_id: number, trial_class_id: number) =>
    request(app.getHttpServer()).post('/bookings').send({ student_id, trial_class_id });

  const pay = (id: number, payment_token: string, key = `k-${++keyCounter}`) =>
    request(app.getHttpServer())
      .post(`/bookings/${id}/pay`)
      .send({ payment_token, idempotency_key: key });

  const expireIn = (id: number, interval: string) =>
    db.query(`update bookings set expires_at = now() + $2::interval where id = $1`, [id, interval]);

  beforeAll(async () => {
    app = await bootstrapTestApp();
    db = app.get(DbService);
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('confirms on a successful payment and clears the hold deadline', async () => {
    const held = await hold(1, 1).expect(201);
    const res = await pay(held.body.id, 'tok_ok').expect(200);

    expect(res.body.status).toBe('confirmed');

    const { rows } = await db.query(`select status, expires_at from bookings where id = $1`, [
      held.body.id,
    ]);
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].expires_at).toBeNull();
  });

  it('keeps the hold when the card is declined, and lets the parent retry', async () => {
    const held = await hold(1, 1).expect(201);

    const declined = await pay(held.body.id, 'tok_decline').expect(402);
    expect(declined.body.code).toBe('payment_declined');

    const still = await db.query(`select status from bookings where id = $1`, [held.body.id]);
    expect(still.rows[0].status).toBe('pending_payment');

    await pay(held.body.id, 'tok_ok').expect(200);
  });

  it('never puts a failed payment on the roster', async () => {
    const held = await hold(1, 1).expect(201);
    await pay(held.body.id, 'tok_decline').expect(402);

    const roster = await request(app.getHttpServer()).get('/admin/classes/1/roster').expect(200);
    expect(roster.body.students).toHaveLength(0);
  });

  it('refuses to charge once the hold has lapsed', async () => {
    const held = await hold(1, 1).expect(201);
    await expireIn(held.body.id, '-1 second');

    const res = await pay(held.body.id, 'tok_ok').expect(410);
    expect(res.body.code).toBe('hold_expired');

    // The point of checking before charging: no money moved.
    const attempts = await db.query(
      `select count(*)::int as n from payment_attempts where booking_id = $1`,
      [held.body.id],
    );
    expect(attempts.rows[0].n).toBe(0);
  });

  // The second race point. tok_slow outlives the remaining hold, so the charge
  // succeeds and the seat is gone by the time the claim runs.
  it('refunds a charge that outlives its hold', async () => {
    const held = await hold(1, 2).expect(201);
    await expireIn(held.body.id, '1 second');

    const res = await pay(held.body.id, 'tok_slow').expect(409);
    expect(res.body.code).toBe('seat_unavailable');
    expect(res.body.refund_ref).toMatch(/^mock_rf_/);

    const { rows } = await db.query(
      `select b.status, pa.status as payment_status
         from bookings b join payment_attempts pa on pa.booking_id = b.id
        where b.id = $1`,
      [held.body.id],
    );
    expect(rows[0].status).toBe('seat_unavailable');
    expect(rows[0].payment_status).toBe('refunded');

    const roster = await request(app.getHttpServer()).get('/admin/classes/2/roster').expect(200);
    expect(roster.body.students.map((s: any) => s.name)).not.toContain('Aisyah');
  });

  it('records refund_failed when the provider refuses the refund', async () => {
    const held = await hold(1, 2).expect(201);
    await expireIn(held.body.id, '1 second');

    const res = await pay(held.body.id, 'tok_refund_fail').expect(409);
    expect(res.body.code).toBe('seat_unavailable');
    expect(res.body.refund_ref).toBeNull();

    const { rows } = await db.query(`select status from payment_attempts where booking_id = $1`, [
      held.body.id,
    ]);
    expect(rows[0].status).toBe('refund_failed');

    const roster = await request(app.getHttpServer()).get('/admin/classes/2/roster').expect(200);
    expect(roster.body.refunds_failed).toBe(1);
  });

  it('charges once when the same idempotency key is replayed', async () => {
    const held = await hold(1, 1).expect(201);
    const first = await pay(held.body.id, 'tok_ok', 'same-key').expect(200);
    const replay = await pay(held.body.id, 'tok_ok', 'same-key').expect(200);

    expect(replay.body.status).toBe(first.body.status);

    const { rows } = await db.query(
      `select count(*)::int as n from payment_attempts where booking_id = $1`,
      [held.body.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('replays a decline as a decline, not as a success', async () => {
    const held = await hold(1, 1).expect(201);
    await pay(held.body.id, 'tok_decline', 'declined-key').expect(402);
    const replay = await pay(held.body.id, 'tok_decline', 'declined-key').expect(402);
    expect(replay.body.code).toBe('payment_declined');
  });

  it('refuses to pay for a booking that is not holding a seat', async () => {
    const held = await hold(1, 1).expect(201);
    await pay(held.body.id, 'tok_ok').expect(200);

    const res = await pay(held.body.id, 'tok_ok').expect(409);
    expect(res.body.code).toBe('booking_not_pending');
  });

  it('reports a booking with its payment history', async () => {
    const held = await hold(1, 1).expect(201);
    await pay(held.body.id, 'tok_decline').expect(402);
    await pay(held.body.id, 'tok_ok').expect(200);

    const res = await request(app.getHttpServer()).get(`/bookings/${held.body.id}`).expect(200);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.student_name).toBe('Aisyah');
    expect(res.body.payment_attempts).toHaveLength(2);
    expect(res.body.payment_attempts.map((a: any) => a.status)).toEqual(['failed', 'succeeded']);
  });
});
