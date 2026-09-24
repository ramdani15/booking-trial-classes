import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';

describe('GET /admin/classes/:id/roster', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('lists only confirmed students', async () => {
    const res = await request(app.getHttpServer()).get('/admin/classes/2/roster').expect(200);

    expect(res.body.students.map((s: any) => s.name).sort()).toEqual(['Bima', 'Citra', 'Rafi']);
    expect(res.body.class.occupied_seats).toBe(3);
  });

  it('excludes a live hold from the roster but counts it', async () => {
    await request(app.getHttpServer())
      .post('/bookings')
      .send({ student_id: 1, trial_class_id: 2 })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/admin/classes/2/roster').expect(200);

    expect(res.body.students).toHaveLength(3);
    expect(res.body.holds_live).toBe(1);
    expect(res.body.class.occupied_seats).toBe(4);
  });

  it('counts holds that lapsed', async () => {
    // Seeded: Bima's booking in class 3 failed payment and the hold lapsed.
    const res = await request(app.getHttpServer()).get('/admin/classes/3/roster').expect(200);

    expect(res.body.students.map((s: any) => s.name)).toEqual(['Aisyah']);
    expect(res.body.holds_lapsed).toBe(1);
    expect(res.body.refunds).toBe(0);
    expect(res.body.refunds_failed).toBe(0);
  });

  it('404s on a class that does not exist', async () => {
    await request(app.getHttpServer()).get('/admin/classes/999/roster').expect(404);
  });
});
