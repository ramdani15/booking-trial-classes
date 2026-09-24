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

  it('holds a seat without putting the child on the roster', async () => {
    const res = await hold(1, 1).expect(201);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.expires_at).toBeTruthy();

    const { rows } = await db.query(
      `select occupied_seats,
              (select count(*)::int from bookings
                where trial_class_id = 1 and status = 'confirmed') as confirmed
         from trial_classes where id = 1`,
    );
    expect(rows[0].occupied_seats).toBe(1);
    expect(rows[0].confirmed).toBe(0);
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

  it('refuses a full class', async () => {
    const { rows } = await db.query(
      `insert into students (parent_id, name, grade)
       select 1, 'Filler ' || g, 'P3' from generate_series(1, 2) g returning id`,
    );
    await hold(rows[0].id, 2).expect(201); // class 2 has one seat in the seed
    const res = await hold(rows[1].id, 2).expect(409);
    expect(res.body.code).toBe('class_full');
  });

  it('releases a lapsed hold to the next parent who asks', async () => {
    const { rows } = await db.query(
      `insert into students (parent_id, name, grade)
       select 1, 'Latecomer ' || g, 'P3' from generate_series(1, 2) g returning id`,
    );
    const abandoned = await hold(rows[0].id, 2).expect(201);
    await db.query(`update bookings set expires_at = now() - interval '1 second' where id = $1`, [
      abandoned.body.id,
    ]);

    // No sweep is run by hand: the claim transaction does it.
    await hold(rows[1].id, 2).expect(201);

    const after = await db.query(`select occupied_seats from trial_classes where id = 2`);
    expect(after.rows[0].occupied_seats).toBe(4);
  });

  it('rejects unknown students and classes', async () => {
    const res = await hold(999, 1).expect(404);
    expect(res.body.code).toBe('not_found');
  });

  // The required scenario. Class 2 has exactly one seat left in the seed, and
  // ten parents reach for it at the same moment. This test is the reason the
  // capacity rule lives in the database: an `if (count < 4)` in application
  // code passes every single-threaded test and fails here.
  it('gives the last seat to exactly one of ten simultaneous parents', async () => {
    const { rows: students } = await db.query<{ id: number }>(
      `insert into students (parent_id, name, grade)
       select 1, 'Racer ' || g, 'P3' from generate_series(1, 10) g
       returning id`,
    );

    const results = await Promise.all(students.map((s) => hold(s.id, 2)));

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => r.body.code === 'class_full')).toBe(true);

    const { rows } = await db.query(
      `select occupied_seats, capacity from trial_classes where id = 2`,
    );
    expect(rows[0].occupied_seats).toBe(4);
    expect(rows[0].occupied_seats).toBeLessThanOrEqual(rows[0].capacity);
  });
});
