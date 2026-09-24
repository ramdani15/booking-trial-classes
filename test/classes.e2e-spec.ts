import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';

describe('GET /classes', () => {
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

  it('reports seats left after seeded bookings', async () => {
    const res = await request(app.getHttpServer()).get('/classes').expect(200);
    const byId = Object.fromEntries(res.body.map((c: any) => [c.id, c]));

    expect(byId[1].seats_available).toBe(4);
    expect(byId[2].seats_available).toBe(1);
    expect(byId[3].seats_available).toBe(3);
  });

  it('lists the seeded children with their parent', async () => {
    const res = await request(app.getHttpServer()).get('/students').expect(200);
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toMatchObject({ name: 'Aisyah', grade: 'P3', parent_name: 'Dewi Lestari' });
  });
});
