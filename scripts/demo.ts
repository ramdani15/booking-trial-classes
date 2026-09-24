import 'dotenv/config';
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db.service';

// Walks every scenario the brief asks about, against a real database, and
// asserts as it goes — so this is a smoke test that happens to read well, not
// a printout that could quietly be lying.
//
// Boots the application itself on an unused port, so `npm run demo` is one
// command with no server to start first.

let failures = 0;
const PORT = 3100;
const base = `http://127.0.0.1:${PORT}`;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`      ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const hold = (student_id: number, trial_class_id: number) =>
  call('POST', '/bookings', { student_id, trial_class_id });

const pay = (id: number, payment_token: string, idempotency_key = `demo-${Math.random()}`) =>
  call('POST', `/bookings/${id}/pay`, { payment_token, idempotency_key });

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(PORT);
  const db = app.get(DbService);

  const root = join(__dirname, '..');
  await db.query(readFileSync(join(root, 'db/schema.sql'), 'utf8'));
  await db.query(readFileSync(join(root, 'db/seed.sql'), 'utf8'));

  console.log('\n  Trial booking demo — seeded database, real Postgres\n');

  // 1
  console.log('  [1/6] seats available');
  const classes = (await call('GET', '/classes')).body;
  check('class 1 (Science)', classes.find((c: any) => c.id === 1).seats_available, 4);
  check('class 2 (Math, the race target)', classes.find((c: any) => c.id === 2).seats_available, 1);

  // 2
  console.log('\n  [2/6] a hold occupies a seat without joining the roster');
  const held = await hold(1, 1);
  check('status', held.body.status, 'pending_payment');
  const roster1 = (await call('GET', '/admin/classes/1/roster')).body;
  check('occupied seats', roster1.class.occupied_seats, 1);
  check('students on roster', roster1.students.length, 0);

  // 3 — the required scenario
  console.log('\n  [3/6] ten parents reach for the last seat at the same moment');
  const { rows: racers } = await db.query<{ id: number }>(
    `insert into students (parent_id, name, grade)
     select 1, 'Racer ' || g, 'P3' from generate_series(1, 10) g returning id`,
  );
  const results = await Promise.all(racers.map((s) => hold(s.id, 2)));
  check('holds created', results.filter((r) => r.status === 201).length, 1);
  check('refused with class_full', results.filter((r) => r.body.code === 'class_full').length, 9);
  const { rows: seats } = await db.query(`select occupied_seats from trial_classes where id = 2`);
  check('class 2 occupied', seats[0].occupied_seats, 4);

  // 4
  console.log('\n  [4/6] a declined card keeps the hold, and the retry succeeds');
  const declined = await pay(held.body.id, 'tok_decline');
  check('response', declined.body.code, 'payment_declined');
  const stillHeld = (await call('GET', `/bookings/${held.body.id}`)).body;
  check('booking status', stillHeld.status, 'pending_payment');
  const retried = await pay(held.body.id, 'tok_ok');
  check('after retry', retried.body.status, 'confirmed');

  // 5
  console.log('\n  [5/6] a payment that outlives its hold is refunded');
  const doomed = await hold(2, 1);
  await db.query(`update bookings set expires_at = now() + interval '1 second' where id = $1`, [
    doomed.body.id,
  ]);
  const lost = await pay(doomed.body.id, 'tok_slow');
  check('response', lost.body.code, 'seat_unavailable');
  check('refund issued', typeof lost.body.refund_ref === 'string', true);
  const after = (await call('GET', `/bookings/${doomed.body.id}`)).body;
  check('booking status', after.status, 'seat_unavailable');
  check('payment status', after.payment_attempts.at(-1).status, 'refunded');

  // 6
  console.log('\n  [6/6] the roster carries confirmed students only');
  const roster = (await call('GET', '/admin/classes/1/roster')).body;
  check('confirmed students', roster.students.map((s: any) => s.name), ['Aisyah']);
  check('refunds', roster.refunds, 1);
  check('refunds that failed', roster.refunds_failed, 0);

  console.log(`\n  ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);
  await app.close();
  process.exit(failures === 0 ? 0 : 1);
}

main();
