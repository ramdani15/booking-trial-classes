import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db.service';
import { ExpiryService } from '../src/expiry.service';

// What cron or pg_cron would call in production. The hold path sweeps lazily
// for the class being booked, which covers busy classes; this covers the quiet
// ones, where nobody arrives to trigger the lazy sweep and the seat counts
// would otherwise stay wrong all day.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const released = await app.get(ExpiryService).sweep(app.get(DbService), null);
  console.log(`released ${released} lapsed hold(s)`);
  await app.close();
}

main();
