import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';
import { DbService } from '../src/db.service';

describe('POST /bookings', () => {
  let app: INestApplication;
  let db: DbService;

  const hold = (student_id: number, trial_class_id: number) =>
    request(app.getHttpServer()).post('/bookings').send({ student_id, trial_class_id });

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

  it('records an intent to pay without taking a seat', async () => {
    const res = await hold(1, 1).expect(201);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.expires_at).toBeTruthy();

    // Selecting reserves nothing. The seat is still free for anyone else.
    const { rows } = await db.query(
      `select occupied_seats,
              (select count(*)::int from bookings
                where trial_class_id = 1 and status = 'confirmed') as confirmed
         from trial_classes where id = 1`,
    );
    expect(rows[0].occupied_seats).toBe(0);
    expect(rows[0].confirmed).toBe(0);
  });

  // The brief's step 2: User B selects the same last slot User A is on.
  it('lets several parents queue for the same last seat', async () => {
    const { rows: students } = await db.query<{ id: number }>(
      `insert into students (parent_id, name, grade)
       select 1, 'Queuer ' || g, 'P3' from generate_series(1, 3) g returning id`,
    );

    for (const s of students) await hold(s.id, 2).expect(201); // class 2 has one seat

    const { rows } = await db.query(
      `select occupied_seats,
              (select count(*)::int from bookings
                where trial_class_id = 2 and status = 'pending_payment') as pending
         from trial_classes where id = 2`,
    );
    expect(rows[0].pending).toBe(3);
    expect(rows[0].occupied_seats).toBe(3); // the three seeded confirmations, unchanged
  });

  it('refuses a second active booking for the same child and class', async () => {
    await hold(1, 1).expect(201);
    const res = await hold(1, 1).expect(409);
    expect(res.body.code).toBe('already_booked');
  });

  it('refuses a child already confirmed in that class', async () => {
    // Seeded: Aisyah is confirmed in class 3.
    const res = await hold(1, 3).expect(409);
    expect(res.body.code).toBe('already_booked');
  });

  // Courtesy, not a guarantee: no point starting a payment for a class that is
  // already full. The seat itself is decided when a payment claims it.
  it('refuses a class that is already full', async () => {
    const { rows } = await db.query(
      `insert into students (parent_id, name, grade) values (1, 'Latecomer', 'P3') returning id`,
    );
    await db.query(
      `insert into bookings (student_id, trial_class_id, status)
       values ($1, 2, 'confirmed')`,
      [rows[0].id],
    ); // class 2 is now 4/4 confirmed

    const { rows: more } = await db.query(
      `insert into students (parent_id, name, grade) values (1, 'Too late', 'P3') returning id`,
    );
    const res = await hold(more[0].id, 2).expect(409);
    expect(res.body.code).toBe('class_full');
  });

  it('sweeps lapsed bookings when the next parent asks', async () => {
    const { rows } = await db.query(
      `insert into students (parent_id, name, grade)
       select 1, 'Abandoner ' || g, 'P3' from generate_series(1, 2) g returning id`,
    );
    const abandoned = await hold(rows[0].id, 2).expect(201);
    await db.query(`update bookings set expires_at = now() - interval '1 second' where id = $1`, [
      abandoned.body.id,
    ]);

    // No sweep is run by hand: the next booking's transaction does it.
    await hold(rows[1].id, 2).expect(201);

    const after = await db.query(`select status from bookings where id = $1`, [abandoned.body.id]);
    expect(after.rows[0].status).toBe('expired');
  });

  it('rejects unknown students and classes', async () => {
    const res = await hold(999, 1).expect(404);
    expect(res.body.code).toBe('not_found');
  });

});
