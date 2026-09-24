import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db.service';

export async function bootstrapTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

// Reloads schema and seed. The database is the thing under test, so it is never
// mocked; each suite starts from the same known rows instead.
export async function resetDb(app: INestApplication): Promise<void> {
  const db = app.get(DbService);
  const root = join(__dirname, '..');
  await db.query(readFileSync(join(root, 'db/schema.sql'), 'utf8'));
  await db.query(readFileSync(join(root, 'db/seed.sql'), 'utf8'));
}
