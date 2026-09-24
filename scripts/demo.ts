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
  console.log('  [1/7] seats available');
  const classes = (await call('GET', '/classes')).body;
  check('class 1 (Science)', classes.find((c: any) => c.id === 1).seats_available, 4);
  check('class 2 (Math, the race target)', classes.find((c: any) => c.id === 2).seats_available, 1);

  // 2
  console.log('\n  [2/7] selecting a class takes no seat and joins no roster');
  const held = await hold(1, 1);
  check('status', held.body.status, 'pending_payment');
  const roster1 = (await call('GET', '/admin/classes/1/roster')).body;
  check('occupied seats', roster1.class.occupied_seats, 0);
  check('students on roster', roster1.students.length, 0);

  // 3
  console.log('\n  [3/7] the same child cannot be booked into a class twice');
  // Seeded: Aisyah is already confirmed in class 3.
  const duplicate = await hold(1, 3);
  check('status', duplicate.status, 409);
  check('code', duplicate.body.code, 'already_booked');
  const stillOne = (await call('GET', '/admin/classes/3/roster')).body;
  check('roster unchanged', stillOne.students.map((s: any) => s.name), ['Aisyah']);

  // A second pending booking for the same child and class is refused too.
  const again = await hold(1, 1);
  check('a second booking for class 1', again.body.code, 'already_booked');

  // 4 — the required scenario
  console.log('\n  [4/7] ten parents select the last seat, then all pay at once');
  const { rows: racers } = await db.query<{ id: number }>(
    `insert into students (parent_id, name, grade)
     select 1, 'Racer ' || g, 'P3' from generate_series(1, 10) g returning id`,
  );
  // Steps 1 and 2 of the brief: everyone selects the same last slot.
  const selected = await Promise.all(racers.map((s) => hold(s.id, 2)));
  check('all ten could select it', selected.filter((r) => r.status === 201).length, 10);

  // Steps 3 and 4: they pay, with no ordering imposed.
  const paid = await Promise.all(selected.map((r) => pay(r.body.id, 'tok_ok')));
  check('confirmed', paid.filter((r) => r.status === 200).length, 1);
  check('refused, seat gone', paid.filter((r) => r.body.code === 'seat_unavailable').length, 9);
  check('all nine refunded', paid.filter((r) => r.body.refund_ref).length, 9);
  const { rows: seats } = await db.query(`select occupied_seats from trial_classes where id = 2`);
  check('class 2 occupied', seats[0].occupied_seats, 4);

  // 5
  console.log('\n  [5/7] a declined card changes nothing, and the retry succeeds');
  const declined = await pay(held.body.id, 'tok_decline');
  check('response', declined.body.code, 'payment_declined');
  const stillHeld = (await call('GET', `/bookings/${held.body.id}`)).body;
  check('booking untouched', stillHeld.status, 'pending_payment');
  const retried = await pay(held.body.id, 'tok_ok');
  check('after retry', retried.body.status, 'confirmed');

  // 6
  console.log('\n  [6/7] a booking left too long can no longer be paid');
  const doomed = await hold(2, 1);
  await db.query(`update bookings set expires_at = now() - interval '1 second' where id = $1`, [
    doomed.body.id,
  ]);
  const lapsed = await pay(doomed.body.id, 'tok_ok');
  check('response', lapsed.body.code, 'booking_expired');
  const { rows: charged } = await db.query(
    `select count(*)::int as n from payment_attempts where booking_id = $1`,
    [doomed.body.id],
  );
  check('payment attempts made', charged[0].n, 0);
  const closed = (await call('GET', `/bookings/${doomed.body.id}`)).body;
  check('booking status', closed.status, 'expired');
  // 7
  console.log('\n  [7/7] the roster carries confirmed students only');
  const roster = (await call('GET', '/admin/classes/1/roster')).body;
  check('confirmed students', roster.students.map((s: any) => s.name), ['Aisyah']);
  check('refunds', roster.refunds, 0);
  check('refunds that failed', roster.refunds_failed, 0);

  console.log(`\n  ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);
  await app.close();
  process.exit(failures === 0 ? 0 : 1);
}

main();
