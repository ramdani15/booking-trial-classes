# Trial Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a trial-class booking slice where overbooking and duplicate bookings are impossible because Postgres refuses them, and where a payment that outlives its seat hold is refunded automatically.

**Architecture:** NestJS over `pg` with no ORM — the correctness argument is made in SQL, and an ORM would hide it. A trigger keeps `trial_classes.occupied_seats` in step with bookings and a CHECK constraint guards it, so competing transactions serialise on that one row instead of racing between a count and an insert. Seats are held on selection with a TTL, released lazily and by a job, and claimed permanently only when payment succeeds.

**Tech Stack:** Node 20, NestJS 11, TypeScript, `pg`, Postgres 16 in Docker, Jest + supertest, vanilla HTML/`fetch` for the screens.

**Spec:** `docs/DESIGN.md`

## Global Constraints

- All paths are relative to the repository root
- Postgres 16 on `localhost:5433`, `postgres://ottodot:ottodot@localhost:5433/ottodot`, overridable with `DATABASE_URL`
- Capacity is 4, set per class as `trial_classes.capacity`; never hardcode 4 in application code
- `HOLD_TTL_SECONDS` env var, default `600`
- Trial price is fixed at `4900` cents
- No ORM, no query builder. SQL is written out, because the correctness argument
  is a partial index, a CHECK constraint, a trigger and `for update skip locked`
   — none of which Prisma's schema language can express and only one of which
  Drizzle's can. An ORM here would sit on top of hand-written migration SQL
  rather than replace it. Supabase's client is PostgREST, not an ORM, and its own
  guidance for this problem is a Postgres function, so SQL-first matches the
  stack Ottodot runs
- Every value reaching SQL is a `$n` parameter. No string interpolation of user
  input anywhere, and no dynamically assembled queries. The only unparameterized
  execution is the test helper running `db/schema.sql` and `db/seed.sql` as whole
  files
- Query results are typed through `src/rows.ts` rather than left as `any`
- The database is never mocked in tests
- Mock payment is deterministic. No randomness anywhere in the codebase
- Error responses are `{ code, message, ... }` where `code` is one of: `class_full`, `already_booked`, `hold_expired`, `payment_declined`, `seat_unavailable`, `booking_not_pending`, `payment_in_progress`, `not_found`
- Every task ends with a commit

---

### Task 1: Database schema, seed, and invariant proof

The database comes first because it is where the correctness lives: `occupied_seats` counts holds as well as confirmations, bookings carry an expiry, and the uniqueness index covers holds.

**Files:**
- Create: `docker-compose.yml`, `scripts/db-reset.sh`
- Create: `db/schema.sql`, `db/seed.sql`
- Create: `scripts/verify-invariants.sql`
- Test: `scripts/verify-invariants.sql` is itself the test

- [ ] **Step 0: Bring up Postgres**

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ottodot
      POSTGRES_PASSWORD: ottodot
      POSTGRES_DB: ottodot
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ottodot"]
      interval: 2s
      timeout: 3s
      retries: 20
```

`scripts/db-reset.sh`, `chmod +x` it. psql runs inside the container, so the host needs only Docker:

```bash
#!/usr/bin/env bash
# Bring the database up and reload it from schema + seed. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait db
for f in db/schema.sql db/seed.sql "$@"; do
  echo "--> $f"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U ottodot -d ottodot -q < "$f"
done
echo "database ready"
```

Run: `docker compose up -d --wait db`
Expected: container healthy

**Interfaces:**
- Consumes: nothing
- Produces: tables `parents`, `students`, `trial_classes`, `bookings`, `payment_attempts`; enums `booking_status`, `payment_status`; constraint names `trial_classes_not_overbooked` and `bookings_one_active_per_child_class` that application code catches by SQLSTATE `23514` and `23505`

- [ ] **Step 1: Write the failing check**

`scripts/verify-invariants.sql`. Proves the database refuses to break its own
rules with no application code present. Runs in a transaction and rolls back, so
the seed survives. Each case asserts on the error class raised, not merely that
an error occurred — a check that passes because the *wrong* constraint fired is
worse than no check.

```sql
begin;

-- 1. The trigger derived the counters from the seeded bookings.
do $$
declare seats int;
begin
  select occupied_seats into seats from trial_classes where id = 1;
  assert seats = 0, format('TC1 expected 0 seats, got %s', seats);
  select occupied_seats into seats from trial_classes where id = 2;
  assert seats = 3, format('TC2 expected 3 seats, got %s', seats);
  select occupied_seats into seats from trial_classes where id = 3;
  assert seats = 1, format('TC3 expected 1 seat, got %s', seats);
  raise notice 'ok: seat counters derived by trigger';
end $$;

-- 2. The 4th confirmed booking fits; the 5th is rejected by the CHECK.
-- Distinct students throughout, so this exercises the capacity CHECK and not
-- the uniqueness index.
do $$
declare seats int; fourth bigint; fifth bigint;
begin
  insert into students (parent_id, name, grade) values (1, 'Fourth', 'P3') returning id into fourth;
  insert into students (parent_id, name, grade) values (1, 'Fifth',  'P3') returning id into fifth;

  insert into bookings (student_id, trial_class_id, status) values (fourth, 2, 'confirmed');
  select occupied_seats into seats from trial_classes where id = 2;
  assert seats = 4, format('TC2 expected 4 seats after fill, got %s', seats);
  raise notice 'ok: last seat taken (4/4)';

  begin
    insert into bookings (student_id, trial_class_id, status) values (fifth, 2, 'confirmed');
    raise exception 'FAIL: overbooking was allowed';
  exception when check_violation then
    raise notice 'ok: 5th confirmed booking rejected (%)', sqlerrm;
  end;
end $$;

-- 3. The same child cannot be confirmed twice into the same class.
do $$
begin
  begin
    insert into bookings (student_id, trial_class_id, status) values (1, 3, 'confirmed');
    raise exception 'FAIL: duplicate confirmed booking was allowed';
  exception when unique_violation then
    raise notice 'ok: duplicate confirmed booking rejected (%)', sqlerrm;
  end;
end $$;

-- 4. Releasing a seat gives it back.
do $$
declare seats int;
begin
  update bookings set status = 'cancelled' where id = 1;
  select occupied_seats into seats from trial_classes where id = 2;
  assert seats = 3, format('TC2 expected 3 seats after cancel, got %s', seats);
  raise notice 'ok: cancelling a booking releases the seat';
end $$;

-- 5. A hold occupies a seat even though it is not on the roster.
do $$
declare seats int; roster int;
begin
  insert into bookings (student_id, trial_class_id, status, expires_at)
  values (1, 1, 'pending_payment', now() + interval '10 minutes');

  select occupied_seats into seats from trial_classes where id = 1;
  select count(*) into roster from bookings where trial_class_id = 1 and status = 'confirmed';

  assert seats = 1, format('TC1 expected 1 occupied seat, got %s', seats);
  assert roster = 0, format('TC1 roster must stay empty, got %s', roster);
  raise notice 'ok: a hold occupies a seat but never reaches the roster';
end $$;

-- 6. The same child cannot hold two seats in one class.
do $$
begin
  begin
    insert into bookings (student_id, trial_class_id, status, expires_at)
    values (1, 1, 'pending_payment', now() + interval '10 minutes');
    raise exception 'FAIL: duplicate hold was allowed';
  exception when unique_violation then
    raise notice 'ok: duplicate active booking rejected (%)', sqlerrm;
  end;
end $$;

rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker compose exec -T db psql -v ON_ERROR_STOP=1 -U ottodot -d ottodot < scripts/verify-invariants.sql`
Expected: FAIL with `relation "trial_classes" does not exist`

- [ ] **Step 3: Rewrite `db/schema.sql`**

```sql
begin;

drop table if exists payment_attempts cascade;
drop table if exists bookings cascade;
drop table if exists trial_classes cascade;
drop table if exists students cascade;
drop table if exists parents cascade;
drop type if exists booking_status cascade;
drop type if exists payment_status cascade;

create type booking_status as enum (
  'pending_payment',   -- holds a seat until expires_at
  'confirmed',         -- holds a seat permanently; the only status on a roster
  'payment_failed',    -- hold lapsed after a declined payment
  'expired',           -- hold lapsed with no payment attempted
  'seat_unavailable',  -- paid, lost the seat, refunded
  'cancelled'          -- released by staff
);

create type payment_status as enum (
  'pending', 'succeeded', 'failed', 'refunded', 'refund_failed'
);

create table parents (
  id         bigserial   primary key,
  name       text        not null,
  email      text        not null unique,
  created_at timestamptz not null default now()
);

create table students (
  id         bigserial   primary key,
  parent_id  bigint      not null references parents(id) on delete cascade,
  name       text        not null,
  grade      text        not null,
  created_at timestamptz not null default now()
);

create index on students (parent_id);

create table trial_classes (
  id             bigserial   primary key,
  subject        text        not null,
  starts_at      timestamptz not null,
  capacity       int         not null default 4 check (capacity > 0),
  -- Denormalised deliberately. This is not a cache of a count, it is the lock
  -- point: every attempt to occupy a seat must UPDATE this row, which
  -- serialises competing transactions on it.
  occupied_seats int         not null default 0,
  created_at     timestamptz not null default now(),
  constraint trial_classes_not_overbooked
    check (occupied_seats between 0 and capacity)
);

create table bookings (
  id             bigserial      primary key,
  student_id     bigint         not null references students(id) on delete cascade,
  trial_class_id bigint         not null references trial_classes(id) on delete cascade,
  status         booking_status not null default 'pending_payment',
  expires_at     timestamptz,
  status_reason  text,
  created_at     timestamptz    not null default now(),
  updated_at     timestamptz    not null default now(),
  -- A hold always has a deadline; nothing else ever carries one.
  constraint bookings_hold_has_expiry
    check ((status = 'pending_payment') = (expires_at is not null))
);

create index on bookings (trial_class_id, status);

-- Covers holds as well as confirmations, so one child cannot hold two seats in
-- the same class. A lapsed or failed booking leaves the covered set, so a
-- parent can always retry.
create unique index bookings_one_active_per_child_class
  on bookings (student_id, trial_class_id)
  where status in ('pending_payment', 'confirmed');

create table payment_attempts (
  id              bigserial      primary key,
  booking_id      bigint         not null references bookings(id) on delete cascade,
  idempotency_key text           not null unique,
  amount_cents    int            not null check (amount_cents > 0),
  status          payment_status not null default 'pending',
  provider_ref    text,
  refund_ref      text,
  failure_reason  text,
  created_at      timestamptz    not null default now()
);

create index on payment_attempts (booking_id);

create or replace function booking_occupies(s booking_status) returns boolean
language sql immutable as $$
  select s in ('pending_payment', 'confirmed')
$$;

create or replace function sync_occupied_seats() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if booking_occupies(new.status) then
      update trial_classes set occupied_seats = occupied_seats + 1
       where id = new.trial_class_id;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if booking_occupies(new.status) and not booking_occupies(old.status) then
      update trial_classes set occupied_seats = occupied_seats + 1
       where id = new.trial_class_id;
    elsif booking_occupies(old.status) and not booking_occupies(new.status) then
      update trial_classes set occupied_seats = occupied_seats - 1
       where id = old.trial_class_id;
    end if;
    return new;
  else
    if booking_occupies(old.status) then
      update trial_classes set occupied_seats = occupied_seats - 1
       where id = old.trial_class_id;
    end if;
    return old;
  end if;
end $$;

create trigger bookings_sync_occupied_seats
  after insert or update or delete on bookings
  for each row execute function sync_occupied_seats();

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger bookings_touch_updated_at
  before update on bookings
  for each row execute function touch_updated_at();

commit;
```

- [ ] **Step 4: Write `db/seed.sql`**

```sql
-- Synthetic data covering the four cases the brief asks to demonstrate.
--
--   TC1 Science Sat 10:00 : 0 / 4  -> plenty of seats
--   TC2 Math    Sat 14:00 : 3 / 4  -> one seat left, the race target
--   TC3 Science Sun 10:00 : 1 / 4  -> Aisyah already in, duplicate target
--   TC3 also carries a booking that failed payment, so a retry can be shown.
--
-- occupied_seats is never written here. The trigger derives it, which doubles
-- as a check that the trigger works: see scripts/verify-invariants.sql.

begin;

insert into parents (id, name, email) values
  (1, 'Dewi Lestari',  'dewi@example.com'),
  (2, 'Andi Wijaya',   'andi@example.com'),
  (3, 'Sri Handayani', 'sri@example.com');

insert into students (id, parent_id, name, grade) values
  (1, 1, 'Aisyah', 'P3'),
  (2, 1, 'Rafi',   'P5'),
  (3, 2, 'Bima',   'P4'),
  (4, 3, 'Citra',  'P3');

insert into trial_classes (id, subject, starts_at, capacity) values
  (1, 'Science', now() + interval '3 days', 4),
  (2, 'Math',    now() + interval '4 days', 4),
  (3, 'Science', now() + interval '5 days', 4);

-- TC2: three confirmed students, one seat left.
insert into bookings (id, student_id, trial_class_id, status) values
  (1, 2, 2, 'confirmed'),
  (2, 3, 2, 'confirmed'),
  (3, 4, 2, 'confirmed');

insert into payment_attempts (booking_id, idempotency_key, amount_cents, status, provider_ref) values
  (1, 'seed-tc2-rafi',  4900, 'succeeded', 'mock_pi_seed_1'),
  (2, 'seed-tc2-bima',  4900, 'succeeded', 'mock_pi_seed_2'),
  (3, 'seed-tc2-citra', 4900, 'succeeded', 'mock_pi_seed_3');

-- TC3: Aisyah is already confirmed. Booking her again must not produce a
-- second confirmed row.
insert into bookings (id, student_id, trial_class_id, status) values
  (4, 1, 3, 'confirmed');

insert into payment_attempts (booking_id, idempotency_key, amount_cents, status, provider_ref) values
  (4, 'seed-tc3-aisyah', 4900, 'succeeded', 'mock_pi_seed_4');

-- TC3: Bima's card was declined and his hold has since lapsed. No seat is
-- taken; he may book again.
insert into bookings (id, student_id, trial_class_id, status, status_reason) values
  (5, 3, 3, 'payment_failed', 'hold_expired');

insert into payment_attempts (booking_id, idempotency_key, amount_cents, status, provider_ref, failure_reason) values
  (5, 'seed-tc3-bima-declined', 4900, 'failed', 'mock_pi_seed_5', 'card_declined');

select setval('parents_id_seq',          (select max(id) from parents));
select setval('students_id_seq',         (select max(id) from students));
select setval('trial_classes_id_seq',    (select max(id) from trial_classes));
select setval('bookings_id_seq',         (select max(id) from bookings));
select setval('payment_attempts_id_seq', (select max(id) from payment_attempts));

commit;
```

- [ ] **Step 5: Run the checks**

Run: `./scripts/db-reset.sh && docker compose exec -T db psql -v ON_ERROR_STOP=1 -U ottodot -d ottodot < scripts/verify-invariants.sql`
Expected: six `ok:` notices, no `FAIL`, no error

- [ ] **Step 6: Commit**

```bash
git add db/ scripts/ docker-compose.yml
git commit -m "feat(db): holds occupy seats, uniqueness covers active bookings"
```

---

### Task 2: Nest app, database service, class listing

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `.env.example`
- Create: `src/main.ts`, `src/app.module.ts`, `src/db.service.ts`, `src/rows.ts`, `src/errors.ts`, `src/classes.controller.ts`
- Create: `test/helpers.ts`, `test/classes.e2e-spec.ts`, `test/jest-e2e.json`

**Interfaces:**
- Consumes: the schema from Task 1
- Produces: `DbService.query<T>(text, params)`, `DbService.withTransaction(fn)`, `pgCode(err): string | undefined`, `BookingError(code, message, extra?)`, the row types in `src/rows.ts`, `GET /classes`

- [ ] **Step 1: Scaffold and install**

```bash
npm init -y
npm i @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs pg
npm i -D typescript @types/node @types/pg jest ts-jest @types/jest supertest @types/supertest @nestjs/testing ts-node
```

`package.json` scripts:

```json
{
  "scripts": {
    "db:reset": "./scripts/db-reset.sh",
    "start": "ts-node src/main.ts",
    "test": "jest --config test/jest-e2e.json --runInBand",
    "expire-holds": "ts-node scripts/expire-holds.ts",
    "demo": "ts-node scripts/demo.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

`test/jest-e2e.json`:

```json
{
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.ts$": "ts-jest" }
}
```

- [ ] **Step 2: Write the failing test**

`test/helpers.ts`:

```ts
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

export async function resetDb(app: INestApplication): Promise<void> {
  const db = app.get(DbService);
  const root = join(__dirname, '..');
  await db.query(readFileSync(join(root, 'db/schema.sql'), 'utf8'));
  await db.query(readFileSync(join(root, 'db/seed.sql'), 'utf8'));
}
```

`test/classes.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';

describe('GET /classes', () => {
  let app: INestApplication;

  beforeAll(async () => { app = await bootstrapTestApp(); });
  beforeEach(async () => { await resetDb(app); });
  afterAll(async () => { await app.close(); });

  it('reports seats left after seeded bookings', async () => {
    const res = await request(app.getHttpServer()).get('/classes').expect(200);
    const byId = Object.fromEntries(res.body.map((c: any) => [c.id, c]));

    expect(byId[1].seats_available).toBe(4);
    expect(byId[2].seats_available).toBe(1);
    expect(byId[3].seats_available).toBe(3);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run db:reset && npm test -- classes`
Expected: FAIL, `Cannot find module '../src/app.module'`

- [ ] **Step 4: Write `src/db.service.ts`**

```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult } from 'pg';

export type Runner = {
  query: <T = any>(text: string, params?: unknown[]) => Promise<QueryResult<T>>;
};

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://ottodot:ottodot@localhost:5433/ottodot',
  });

  // Generic so callers name the shape they expect. Hand-written types in
  // rows.ts rather than generated ones: the point is that a status string that
  // does not exist fails to compile, not full schema reflection.
  query<T = any>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
```

- [ ] **Step 4b: Write `src/rows.ts`**

```ts
// Hand-written because the schema is small and stable. What these buy is that
// a status string which does not exist fails to compile — the mistake raw SQL
// actually invites.

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'expired'
  | 'seat_unavailable'
  | 'cancelled';

export type PaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'refund_failed';

export type BookingRow = {
  id: number;
  student_id: number;
  trial_class_id: number;
  status: BookingStatus;
  expires_at: Date | null;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

export type TrialClassRow = {
  id: number;
  subject: string;
  starts_at: Date;
  capacity: number;
  occupied_seats: number;
};

export type PaymentAttemptRow = {
  id: number;
  booking_id: number;
  idempotency_key: string;
  amount_cents: number;
  status: PaymentStatus;
  provider_ref: string | null;
  refund_ref: string | null;
  failure_reason: string | null;
};

export type StudentRow = {
  id: number;
  parent_id: number;
  name: string;
  grade: string;
};
```

Every `db.query` call in later tasks names one of these: `query<BookingRow>`,
`query<TrialClassRow>`, `query<PaymentAttemptRow>`. Queries returning a shape of
their own — the roster join, the admin counters — declare an inline type at the
call site rather than adding a row type for one use.

- [ ] **Step 5: Write `src/errors.ts`**

```ts
import { HttpException } from '@nestjs/common';

export type BookingErrorCode =
  | 'class_full'
  | 'already_booked'
  | 'hold_expired'
  | 'payment_declined'
  | 'seat_unavailable'
  | 'booking_not_pending'
  | 'payment_in_progress'
  | 'not_found';

const HTTP_STATUS: Record<BookingErrorCode, number> = {
  class_full: 409,
  already_booked: 409,
  hold_expired: 410,
  payment_declined: 402,
  seat_unavailable: 409,
  booking_not_pending: 409,
  payment_in_progress: 409,
  not_found: 404,
};

export class BookingError extends HttpException {
  constructor(
    readonly code: BookingErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ code, message, ...extra }, HTTP_STATUS[code]);
  }
}
```

- [ ] **Step 6: Write `src/classes.controller.ts`**

```ts
import { Controller, Get } from '@nestjs/common';
import { DbService } from './db.service';

@Controller()
export class ClassesController {
  constructor(private readonly db: DbService) {}

  @Get('classes')
  async list() {
    const { rows } = await this.db.query(`
      select id, subject, starts_at, capacity, occupied_seats,
             capacity - occupied_seats as seats_available
        from trial_classes
       order by starts_at
    `);
    return rows.map((r) => ({ ...r, seats_available: Number(r.seats_available) }));
  }

  @Get('students')
  async students() {
    const { rows } = await this.db.query(`
      select s.id, s.name, s.grade, p.id as parent_id, p.name as parent_name
        from students s join parents p on p.id = s.parent_id
       order by s.id
    `);
    return rows;
  }
}
```

- [ ] **Step 7: Write `src/app.module.ts` and `src/main.ts`**

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ClassesController } from './classes.controller';

@Module({
  controllers: [ClassesController],
  providers: [DbService],
  exports: [DbService],
})
export class AppModule {}
```

```ts
// src/main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  console.log('listening on http://localhost:3000');
}
bootstrap();
```

- [ ] **Step 8: Run the test**

Run: `npm test -- classes`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): class listing with seats available"
```

---

### Task 3: Releasing lapsed holds

**Files:**
- Create: `src/expiry.service.ts`, `scripts/expire-holds.ts`
- Modify: `src/app.module.ts`
- Test: `test/expiry.e2e-spec.ts`

**Interfaces:**
- Consumes: `DbService`, `Runner`
- Produces: `ExpiryService.sweep(runner, trialClassId: number | null): Promise<number>`, consumed by Task 4's hold transaction and by `npm run expire-holds`

Comes before the booking service on purpose: a hold that cannot be released is
not finished, and writing the release first means the sweep is born in the
service that owns it rather than inline somewhere and extracted later.

- [ ] **Step 1: Write the failing test**

`test/expiry.e2e-spec.ts`:

```ts
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
  beforeEach(async () => { await resetDb(app); });
  afterAll(async () => { await app.close(); });

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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- expiry`
Expected: FAIL, `Cannot find module '../src/expiry.service'`

- [ ] **Step 3: Write `src/expiry.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Runner } from './db.service';

// A database does nothing at a point in time. `expires_at` passing fires no
// code, so the row keeps occupying a seat until this SQL runs — lazily on the
// next claim for that class, or on a schedule for classes nobody is looking at.
const SWEEP_SQL = `
with stale as (
  select b.id
    from bookings b
   where b.status = 'pending_payment'
     and b.expires_at <= now()
     and ($1::bigint is null or b.trial_class_id = $1)
   order by b.id
     for update skip locked
)
update bookings b
   set status = case
         when exists (
           select 1 from payment_attempts pa
            where pa.booking_id = b.id and pa.status = 'failed')
         then 'payment_failed'::booking_status
         else 'expired'::booking_status
       end,
       status_reason = 'hold_expired',
       expires_at = null
  from stale
 where b.id = stale.id
returning b.id`;

@Injectable()
export class ExpiryService {
  async sweep(runner: Runner, trialClassId: number | null): Promise<number> {
    const { rowCount } = await runner.query(SWEEP_SQL, [trialClassId]);
    return rowCount ?? 0;
  }
}
```

- [ ] **Step 4: Write `scripts/expire-holds.ts`**

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db.service';
import { ExpiryService } from '../src/expiry.service';

// What cron or pg_cron would call in production.
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const released = await app.get(ExpiryService).sweep(app.get(DbService), null);
  console.log(`released ${released} lapsed hold(s)`);
  await app.close();
}
main();
```

- [ ] **Step 5: Register `ExpiryService` in `src/app.module.ts` providers, then run**

Run: `npm test -- expiry`
Expected: PASS, all three

- [ ] **Step 6: Run the job by hand**

Run: `npm run expire-holds`
Expected: `released 0 lapsed hold(s)`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(holds): release lapsed holds lazily and on demand"
```

---

### Task 4: Holding a seat, and the last-seat race

The race test is the centre of this submission. Write it first and watch it fail against a naive implementation before the DB constraint is relied upon.

**Files:**
- Create: `src/booking.service.ts`, `src/booking.controller.ts`
- Modify: `src/app.module.ts`
- Test: `test/hold.e2e-spec.ts`

**Interfaces:**
- Consumes: `DbService`, `BookingError`, `pgCode`, `BookingRow`, `ExpiryService.sweep` from Task 3
- Produces: `BookingService.createHold(studentId, trialClassId): Promise<BookingRow>`, `HOLD_TTL_SECONDS`, `POST /bookings`

- [ ] **Step 1: Write the failing tests**

`test/hold.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';
import { DbService } from '../src/db.service';

describe('POST /bookings', () => {
  let app: INestApplication;
  const hold = (student_id: number, trial_class_id: number) =>
    request(app.getHttpServer()).post('/bookings').send({ student_id, trial_class_id });

  beforeAll(async () => { app = await bootstrapTestApp(); });
  beforeEach(async () => { await resetDb(app); });
  afterAll(async () => { await app.close(); });

  it('holds a seat without putting the child on the roster', async () => {
    const res = await hold(1, 1).expect(201);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.expires_at).toBeTruthy();

    const db = app.get(DbService);
    const { rows } = await db.query(
      `select occupied_seats,
              (select count(*) from bookings
                where trial_class_id = 1 and status = 'confirmed') as confirmed
         from trial_classes where id = 1`,
    );
    expect(rows[0].occupied_seats).toBe(1);
    expect(Number(rows[0].confirmed)).toBe(0);
  });

  it('refuses a second active booking for the same child and class', async () => {
    await hold(1, 1).expect(201);
    const res = await hold(1, 1).expect(409);
    expect(res.body.code).toBe('already_booked');
  });

  it('refuses a child already confirmed in that class', async () => {
    const res = await hold(1, 3).expect(409); // seeded: Aisyah confirmed in class 3
    expect(res.body.code).toBe('already_booked');
  });

  // The required scenario. Class 2 has exactly one seat left in the seed.
  it('gives the last seat to exactly one of ten simultaneous parents', async () => {
    const db = app.get(DbService);
    const { rows: students } = await db.query(
      `insert into students (parent_id, name, grade)
       select 1, 'Racer ' || g, 'P3' from generate_series(1, 10) g
       returning id`,
    );

    const results = await Promise.all(
      students.map((s: { id: number }) => hold(s.id, 2)),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => r.body.code === 'class_full')).toBe(true);

    const { rows } = await db.query(`select occupied_seats, capacity from trial_classes where id = 2`);
    expect(rows[0].occupied_seats).toBe(4);
    expect(rows[0].occupied_seats).toBeLessThanOrEqual(rows[0].capacity);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- hold`
Expected: FAIL, `Cannot find module '../src/booking.service'`

- [ ] **Step 3: Write `src/booking.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { DbService, pgCode } from './db.service';
import { ExpiryService } from './expiry.service';
import { BookingRow } from './rows';
import { BookingError } from './errors';

// The hold window. Applies to pending_payment and nothing else: confirming
// clears expires_at, and the schema's bookings_hold_has_expiry constraint means
// a confirmed booking cannot carry a deadline at all.
export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 600);

@Injectable()
export class BookingService {
  constructor(
    private readonly db: DbService,
    private readonly expiry: ExpiryService,
  ) {}

  async createHold(studentId: number, trialClassId: number): Promise<BookingRow> {
    try {
      return await this.db.withTransaction(async (client) => {
        // Release any lapsed holds on this class first, so an abandoned tab
        // never keeps a seat from the next parent who asks for it.
        await this.expiry.sweep(client, trialClassId);

        const { rows } = await client.query<BookingRow>(
          `insert into bookings (student_id, trial_class_id, status, expires_at)
           values ($1, $2, 'pending_payment', now() + ($3 || ' seconds')::interval)
           returning id, student_id, trial_class_id, status, expires_at`,
          [studentId, trialClassId, HOLD_TTL_SECONDS],
        );
        return rows[0];
      });
    } catch (err) {
      // The database is what prevents overbooking. This only translates its
      // refusal into something a parent can read.
      if (pgCode(err) === '23514') {
        throw new BookingError('class_full', 'This trial class is full.');
      }
      if (pgCode(err) === '23505') {
        throw new BookingError(
          'already_booked',
          'This child already has an active booking for this class.',
        );
      }
      if (pgCode(err) === '23503') {
        throw new BookingError('not_found', 'Unknown student or trial class.');
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Write `src/booking.controller.ts`**

```ts
import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { BookingService } from './booking.service';

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  create(@Body() body: { student_id?: unknown; trial_class_id?: unknown }) {
    const studentId = Number(body.student_id);
    const classId = Number(body.trial_class_id);
    if (!Number.isInteger(studentId) || !Number.isInteger(classId)) {
      throw new BadRequestException('student_id and trial_class_id must be integers');
    }
    return this.bookings.createHold(studentId, classId);
  }
}
```

- [ ] **Step 5: Register in `src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ExpiryService } from './expiry.service';
import { ClassesController } from './classes.controller';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  controllers: [ClassesController, BookingController],
  providers: [DbService, ExpiryService, BookingService],
  exports: [DbService],
})
export class AppModule {}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- hold`
Expected: PASS, all four

- [ ] **Step 7: Prove the constraint is what saves it**

Temporarily comment out the `constraint trial_classes_not_overbooked` line in `db/schema.sql`, run `npm run db:reset && npm test -- hold`, and confirm the race test now fails with more than one seat created. Restore the line, reset, and confirm it passes again. Record the observed failure in `AI_USAGE.md` — this is the evidence that the test tests something.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(bookings): hold a seat, with the last-seat race covered"
```

---

### Task 5: Mock payment provider and idempotent attempts

**Files:**
- Create: `src/payments.service.ts`
- Modify: `src/app.module.ts`
- Test: `test/payments.e2e-spec.ts`

**Interfaces:**
- Consumes: `DbService`
- Produces: `PaymentsService.reserve(bookingId, idempotencyKey)`, `.findByKey(key)`, `.charge(token)`, `.markSucceeded(id, ref)`, `.markFailed(id, reason)`, `.refund(attemptId, providerRef)`, and `TRIAL_PRICE_CENTS`

- [ ] **Step 1: Write the failing test**

`test/payments.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';
import { PaymentsService } from '../src/payments.service';

describe('mock payment provider', () => {
  let app: INestApplication;
  let payments: PaymentsService;

  beforeAll(async () => { app = await bootstrapTestApp(); payments = app.get(PaymentsService); });
  beforeEach(async () => { await resetDb(app); });
  afterAll(async () => { await app.close(); });

  it('is deterministic', async () => {
    expect((await payments.charge('tok_ok')).ok).toBe(true);
    expect((await payments.charge('tok_ok')).ok).toBe(true);
    const declined = await payments.charge('tok_decline');
    expect(declined.ok).toBe(false);
    expect(declined.ok === false && declined.reason).toBe('card_declined');
  });

  it('reserves an idempotency key exactly once', async () => {
    const first = await payments.reserve(1, 'key-1');
    expect(first).not.toBeNull();
    const second = await payments.reserve(1, 'key-1');
    expect(second).toBeNull();
  });

  it('refuses to refund a charge made with tok_refund_fail', async () => {
    const charge = await payments.charge('tok_refund_fail');
    expect(charge.ok).toBe(true);
    if (!charge.ok) return;
    await expect(payments.providerRefund(charge.ref)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- payments`
Expected: FAIL, `Cannot find module '../src/payments.service'`

- [ ] **Step 3: Write `src/payments.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { DbService, Runner, pgCode } from './db.service';

export const TRIAL_PRICE_CENTS = 4900;

export type ChargeResult =
  | { ok: true; ref: string }
  | { ok: false; reason: string };

@Injectable()
export class PaymentsService {
  constructor(private readonly db: DbService) {}

  // Stands in for Stripe. Deterministic by token, because a demo that fails at
  // random is worse than no demo.
  private readonly chargedWith = new Map<string, string>();
  private counter = 0;

  async charge(token: string): Promise<ChargeResult> {
    if (token === 'tok_decline') return { ok: false, reason: 'card_declined' };
    if (token === 'tok_slow') await new Promise((r) => setTimeout(r, 1500));
    const ref = `mock_pi_${++this.counter}`;
    this.chargedWith.set(ref, token);
    return { ok: true, ref };
  }

  async providerRefund(providerRef: string): Promise<string> {
    if (this.chargedWith.get(providerRef) === 'tok_refund_fail') {
      throw new Error(`provider refused to refund ${providerRef}`);
    }
    return `mock_rf_${++this.counter}`;
  }

  // Reserving the key before charging is what makes a retry safe: a concurrent
  // replay loses the insert and is told the first attempt is still running,
  // rather than charging the card a second time.
  async reserve(bookingId: number, idempotencyKey: string): Promise<number | null> {
    try {
      const { rows } = await this.db.query(
        `insert into payment_attempts (booking_id, idempotency_key, amount_cents, status)
         values ($1, $2, $3, 'pending') returning id`,
        [bookingId, idempotencyKey, TRIAL_PRICE_CENTS],
      );
      return rows[0].id;
    } catch (err) {
      if (pgCode(err) === '23505') return null;
      throw err;
    }
  }

  async findByKey(idempotencyKey: string) {
    const { rows } = await this.db.query(
      `select * from payment_attempts where idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async markSucceeded(attemptId: number, ref: string, runner: Runner = this.db) {
    await runner.query(
      `update payment_attempts set status = 'succeeded', provider_ref = $2 where id = $1`,
      [attemptId, ref],
    );
  }

  async markFailed(attemptId: number, reason: string) {
    await this.db.query(
      `update payment_attempts set status = 'failed', failure_reason = $2 where id = $1`,
      [attemptId, reason],
    );
  }

  // The compensating action. No transaction spans Postgres and a payment
  // provider, so a charge that cannot be honoured is answered with its
  // opposite rather than rolled back.
  async refund(attemptId: number, providerRef: string): Promise<string | null> {
    try {
      const refundRef = await this.providerRefund(providerRef);
      await this.db.query(
        `update payment_attempts set status = 'refunded', refund_ref = $2 where id = $1`,
        [attemptId, refundRef],
      );
      return refundRef;
    } catch (err) {
      // Money taken, seat gone, refund refused. The one state this system
      // cannot resolve by itself; it is surfaced on the admin roster.
      await this.db.query(
        `update payment_attempts
            set status = 'refund_failed', failure_reason = $2
          where id = $1`,
        [attemptId, String(err instanceof Error ? err.message : err)],
      );
      return null;
    }
  }
}
```

- [ ] **Step 4: Register `PaymentsService` in `src/app.module.ts` providers, then run**

Run: `npm test -- payments`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(payments): deterministic mock provider with reserved idempotency keys"
```

---

### Task 6: Paying, confirming, and the refund path

**Files:**
- Modify: `src/booking.service.ts`, `src/booking.controller.ts`
- Test: `test/pay.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaymentsService`, `ExpiryService`, `DbService`, `BookingError`
- Produces: `BookingService.pay(bookingId, token, idempotencyKey)`, `POST /bookings/:id/pay`

- [ ] **Step 1: Write the failing tests**

`test/pay.e2e-spec.ts`:

```ts
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

  beforeAll(async () => { app = await bootstrapTestApp(); db = app.get(DbService); });
  beforeEach(async () => { await resetDb(app); });
  afterAll(async () => { await app.close(); });

  it('confirms on a successful payment and puts the child on the roster', async () => {
    const held = await hold(1, 1).expect(201);
    const res = await pay(held.body.id, 'tok_ok').expect(200);

    expect(res.body.status).toBe('confirmed');
    const { rows } = await db.query(
      `select status, expires_at from bookings where id = $1`, [held.body.id]);
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

    const roster = await request(app.getHttpServer())
      .get('/admin/classes/1/roster').expect(200);
    expect(roster.body.students).toHaveLength(0);
  });

  it('refuses to charge once the hold has lapsed', async () => {
    const held = await hold(1, 1).expect(201);
    await db.query(
      `update bookings set expires_at = now() - interval '1 second' where id = $1`,
      [held.body.id]);

    const res = await pay(held.body.id, 'tok_ok').expect(410);
    expect(res.body.code).toBe('hold_expired');

    const attempts = await db.query(
      `select count(*)::int as n from payment_attempts where booking_id = $1`, [held.body.id]);
    expect(attempts.rows[0].n).toBe(0); // no charge was made
  });

  it('refunds a charge that outlives its hold', async () => {
    const held = await hold(1, 2).expect(201); // class 2: this takes the last seat
    // The hold lapses while tok_slow is in flight.
    await db.query(
      `update bookings set expires_at = now() + interval '1 second' where id = $1`,
      [held.body.id]);

    const res = await pay(held.body.id, 'tok_slow').expect(409);
    expect(res.body.code).toBe('seat_unavailable');
    expect(res.body.refund_ref).toMatch(/^mock_rf_/);

    const { rows } = await db.query(
      `select b.status, pa.status as payment_status
         from bookings b join payment_attempts pa on pa.booking_id = b.id
        where b.id = $1`, [held.body.id]);
    expect(rows[0].status).toBe('seat_unavailable');
    expect(rows[0].payment_status).toBe('refunded');
  });

  it('records refund_failed when the provider refuses the refund', async () => {
    const held = await hold(1, 2).expect(201);
    await db.query(
      `update bookings set expires_at = now() + interval '1 second' where id = $1`,
      [held.body.id]);

    const res = await pay(held.body.id, 'tok_refund_fail').expect(409);
    expect(res.body.code).toBe('seat_unavailable');
    expect(res.body.refund_ref).toBeNull();

    const { rows } = await db.query(
      `select status from payment_attempts where booking_id = $1`, [held.body.id]);
    expect(rows[0].status).toBe('refund_failed');
  });

  it('charges once when the same idempotency key is replayed', async () => {
    const held = await hold(1, 1).expect(201);
    const first = await pay(held.body.id, 'tok_ok', 'same-key').expect(200);
    const replay = await pay(held.body.id, 'tok_ok', 'same-key').expect(200);

    expect(replay.body.status).toBe(first.body.status);
    const { rows } = await db.query(
      `select count(*)::int as n from payment_attempts where booking_id = $1`, [held.body.id]);
    expect(rows[0].n).toBe(1);
  });
});
```

Note: `tok_slow` sleeps 1500ms and the hold is set to lapse in 1000ms, which is what drives the refund path. The roster test depends on Task 7; run this suite after that task if it is executed out of order.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- pay`
Expected: FAIL, 404 on `/bookings/:id/pay`

- [ ] **Step 3: Add `pay` to `src/booking.service.ts`**

```ts
async pay(bookingId: number, token: string, idempotencyKey: string) {
  const replay = await this.payments.findByKey(idempotencyKey);
  if (replay) {
    if (replay.status === 'pending') {
      throw new BookingError('payment_in_progress', 'This payment is already being processed.');
    }
    return this.describe(bookingId);
  }

  const booking = await this.load(bookingId);
  if (booking.status !== 'pending_payment') {
    throw new BookingError(
      'booking_not_pending',
      `This booking is ${booking.status}.`,
      { status: booking.status },
    );
  }

  // Check the hold before taking any money, so the ordinary case of a parent
  // returning too late never becomes a refund.
  if (new Date(booking.expires_at).getTime() <= Date.now()) {
    await this.expiry.sweep(this.db, booking.trial_class_id);
    throw new BookingError('hold_expired', 'This seat hold has expired. Please book again.');
  }

  const attemptId = await this.payments.reserve(bookingId, idempotencyKey);
  if (attemptId === null) {
    throw new BookingError('payment_in_progress', 'This payment is already being processed.');
  }

  const charge = await this.payments.charge(token);
  if (!charge.ok) {
    await this.payments.markFailed(attemptId, charge.reason);
    // The hold survives a declined card. Losing a seat to a mistyped number is
    // a bad product, and the hold is what expires, not the booking.
    throw new BookingError('payment_declined', 'The card was declined.', {
      reason: charge.reason,
      hold_expires_at: booking.expires_at,
    });
  }
  await this.payments.markSucceeded(attemptId, charge.ref);

  // Claim the seat. The WHERE clause is the guard: if the hold lapsed while the
  // charge was in flight, no row matches and the money has to go back.
  const claimed = await this.db.query(
    `update bookings set status = 'confirmed', expires_at = null
      where id = $1 and status = 'pending_payment' and expires_at > now()
      returning id`,
    [bookingId],
  );

  if (claimed.rowCount === 1) return this.describe(bookingId);

  const refundRef = await this.payments.refund(attemptId, charge.ref);
  await this.db.query(
    `update bookings
        set status = 'seat_unavailable', expires_at = null, status_reason = $2
      where id = $1 and status <> 'confirmed'`,
    [bookingId, refundRef ? 'seat_taken_refunded' : 'seat_taken_refund_failed'],
  );

  throw new BookingError(
    'seat_unavailable',
    refundRef
      ? 'The seat was taken before your payment completed. It has been refunded.'
      : 'The seat was taken before your payment completed, and the refund failed. Our team will contact you.',
    { refund_ref: refundRef },
  );
}

private async load(bookingId: number) {
  const { rows } = await this.db.query(`select * from bookings where id = $1`, [bookingId]);
  if (!rows[0]) throw new BookingError('not_found', 'No such booking.');
  return rows[0];
}

async describe(bookingId: number) {
  const { rows } = await this.db.query(
    `select b.id, b.status, b.status_reason, b.expires_at,
            s.name as student_name, t.subject, t.starts_at,
            coalesce(
              (select json_agg(json_build_object(
                 'status', pa.status, 'provider_ref', pa.provider_ref,
                 'refund_ref', pa.refund_ref, 'failure_reason', pa.failure_reason)
                 order by pa.id)
                 from payment_attempts pa where pa.booking_id = b.id), '[]'::json
            ) as payment_attempts
       from bookings b
       join students s on s.id = b.student_id
       join trial_classes t on t.id = b.trial_class_id
      where b.id = $1`,
    [bookingId],
  );
  if (!rows[0]) throw new BookingError('not_found', 'No such booking.');
  return rows[0];
}
```

Add `PaymentsService` to the constructor.

- [ ] **Step 4: Add the routes to `src/booking.controller.ts`**

```ts
@Post(':id/pay')
pay(
  @Param('id') id: string,
  @Body() body: { payment_token?: unknown; idempotency_key?: unknown },
) {
  const token = String(body.payment_token ?? '');
  const key = String(body.idempotency_key ?? '');
  if (!token || !key) {
    throw new BadRequestException('payment_token and idempotency_key are required');
  }
  return this.bookings.pay(Number(id), token, key);
}

@Get(':id')
get(@Param('id') id: string) {
  return this.bookings.describe(Number(id));
}
```

Import `Get` and `Param` from `@nestjs/common`.

- [ ] **Step 5: Run the tests**

Run: `npm test -- pay`
Expected: PASS, all seven

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(payments): confirm on success, refund a charge that outlives its hold"
```

---

### Task 7: Roster and admin counters

**Files:**
- Create: `src/admin.controller.ts`
- Modify: `src/app.module.ts`
- Test: `test/roster.e2e-spec.ts`

**Interfaces:**
- Consumes: `DbService`
- Produces: `GET /admin/classes/:id/roster` returning `{ class, students[], holds_live, holds_lapsed, refunds, refunds_failed }`

- [ ] **Step 1: Write the failing test**

`test/roster.e2e-spec.ts`:

```ts
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapTestApp, resetDb } from './helpers';

describe('GET /admin/classes/:id/roster', () => {
  let app: INestApplication;

  beforeAll(async () => { app = await bootstrapTestApp(); });
  beforeEach(async () => { await resetDb(app); });
  afterAll(async () => { await app.close(); });

  it('lists only confirmed students', async () => {
    const res = await request(app.getHttpServer()).get('/admin/classes/2/roster').expect(200);
    expect(res.body.students.map((s: any) => s.name).sort()).toEqual(['Bima', 'Citra', 'Rafi']);
    expect(res.body.class.occupied_seats).toBe(3);
  });

  it('excludes a live hold from the roster but counts it', async () => {
    await request(app.getHttpServer())
      .post('/bookings').send({ student_id: 1, trial_class_id: 2 }).expect(201);

    const res = await request(app.getHttpServer()).get('/admin/classes/2/roster').expect(200);
    expect(res.body.students).toHaveLength(3);
    expect(res.body.holds_live).toBe(1);
    expect(res.body.class.occupied_seats).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- roster`
Expected: FAIL, 404

- [ ] **Step 3: Write `src/admin.controller.ts`**

```ts
import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { DbService } from './db.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly db: DbService) {}

  @Get('classes/:id/roster')
  async roster(@Param('id') id: string) {
    const classId = Number(id);

    const klass = await this.db.query(
      `select id, subject, starts_at, capacity, occupied_seats
         from trial_classes where id = $1`,
      [classId],
    );
    if (!klass.rows[0]) throw new NotFoundException('No such class.');

    const students = await this.db.query(
      `select s.name, s.grade, b.updated_at as confirmed_at, pa.provider_ref
         from bookings b
         join students s on s.id = b.student_id
         left join lateral (
           select provider_ref from payment_attempts
            where booking_id = b.id and status = 'succeeded'
            order by id desc limit 1
         ) pa on true
        where b.trial_class_id = $1 and b.status = 'confirmed'
        order by b.updated_at`,
      [classId],
    );

    // What an operator actually needs: not just who is in, but what the seat
    // machinery has been doing.
    const counts = await this.db.query(
      `select
         (select count(*)::int from bookings
           where trial_class_id = $1 and status = 'pending_payment'
             and expires_at > now())                              as holds_live,
         (select count(*)::int from bookings
           where trial_class_id = $1
             and status in ('expired', 'payment_failed'))          as holds_lapsed,
         (select count(*)::int from payment_attempts pa
            join bookings b on b.id = pa.booking_id
           where b.trial_class_id = $1 and pa.status = 'refunded')  as refunds,
         (select count(*)::int from payment_attempts pa
            join bookings b on b.id = pa.booking_id
           where b.trial_class_id = $1
             and pa.status = 'refund_failed')                      as refunds_failed`,
      [classId],
    );

    return { class: klass.rows[0], students: students.rows, ...counts.rows[0] };
  }
}
```

- [ ] **Step 4: Register in `src/app.module.ts` controllers, then run**

Run: `npm test`
Expected: PASS, every suite

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(admin): roster plus hold and refund counters"
```

---

### Task 8: The four screens

**Files:**
- Create: `public/index.html`
- Modify: `src/main.ts` (serve `public/`)

**Interfaces:**
- Consumes: every endpoint from Tasks 2, 4, 6, 7
- Produces: nothing other code depends on

- [ ] **Step 1: Serve the directory**

In `src/main.ts`, after `NestFactory.create`:

```ts
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useStaticAssets(join(__dirname, '..', 'public'));
```

- [ ] **Step 2: Write `public/index.html`**

One file, no build step, no framework. Four views switched by a `state` variable:

1. **Pick** — `GET /students` and `GET /classes`, radio buttons for the child, a row per class showing `seats_available`, a Book button disabled when `seats_available === 0`.
2. **Pay** — shows the held class and a countdown from `expires_at`, radio buttons for `tok_ok`, `tok_decline`, `tok_slow`, `tok_refund_fail`, and a Pay button that posts a fresh `idempotency_key` (`crypto.randomUUID()`) plus a Retry button reusing the same key.
3. **Result** — renders the response `code`: `confirmed`, `payment_declined` with the countdown still running, `hold_expired`, `seat_unavailable` with `refund_ref`.
4. **Admin** — `?admin=1`, a class selector, the roster table, and the four counters.

Every view renders from the JSON the API already returns; the page holds no state the backend does not.

- [ ] **Step 3: Verify by hand**

Run: `npm run db:reset && npm start`, open `http://localhost:3000`
Expected: book the last seat on Math with `tok_ok`, see confirmed; open `http://localhost:3000/?admin=1`, see 4/4 and the new name

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ui): four-screen parent flow and admin roster"
```

---

### Task 9: Demo script

**Files:**
- Create: `scripts/demo.ts`

**Interfaces:**
- Consumes: the running API
- Produces: `npm run demo`

- [ ] **Step 1: Write `scripts/demo.ts`**

Resets the database, then drives six scenarios against `http://localhost:3000` with `fetch`, printing a numbered line and the decisive field for each:

```
[1/6] seats available     class 1 -> 4 seats
[2/6] hold the last seat  class 2 -> booking 6, expires 10:10:00
[3/6] ten parents race    1 x 201, 9 x 409 class_full, occupied 4/4
[4/6] card declined       402 payment_declined, hold still live
[5/6] payment outlives hold 409 seat_unavailable, refund mock_rf_3
[6/6] roster              4 confirmed, 0 holds, 1 refund
```

Each step asserts its expectation and exits non-zero on mismatch, so the demo is also a smoke test.

- [ ] **Step 2: Run it**

Run: `npm run db:reset && npm start &` then `npm run demo`
Expected: six lines, exit code 0

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(demo): scripted walkthrough of all six scenarios"
```

---

### Task 10: README and AI_USAGE

**Files:**
- Create: `README.md`
- Modify: `AI_USAGE.md` (fill in "How I verified" with real output)

**Interfaces:**
- Consumes: `docs/DESIGN.md`
- Produces: the submission

- [ ] **Step 1: Write `README.md`**

Sections, in the order the brief asks for them: how to run (four commands), what was built, time spent, assumptions, data model, endpoints, booking statuses, how duplicates are prevented, how payment failure is handled, how two parents competing for the last seat are handled, which checks live in the UI / backend / database / background job, what was deliberately cut, what to monitor after release, what comes next. Most of this is the design doc reorganised under their headings.

State plainly that blocking holds make the brief's literal scenario impossible, and that the harder version — the hold lapsing mid-payment — is the one implemented.

Include a short paragraph on why there is no ORM: the invariants are a partial index, a CHECK constraint, a trigger and `for update skip locked`, so an ORM would sit on hand-written migration SQL rather than replace it; Supabase's client is PostgREST and its own guidance for this problem is a Postgres function; every value is parameterized; row types are hand-written in `src/rows.ts`. Name versioned migrations as a cut — drop-and-recreate suits a take-home and nothing else.

- [ ] **Step 2: Write `AI_USAGE.md`**

`AI_USAGE.md` already answers five of their six questions and was kept current as the work happened. Finish the sixth, "How I verified the final implementation", with the output actually observed: the test run, the invariant script, and the constraint-removal check from Task 4.

- [ ] **Step 3: Final verification**

Run in a clean clone:

```bash
npm install
npm run db:reset
npm test
npm start &
npm run demo
docker compose exec -T db psql -U ottodot -d ottodot < scripts/verify-invariants.sql
```

Expected: tests pass, demo exits 0, six `ok:` notices

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: README and AI usage"
```

---

## Time budget

| Task | Estimate |
|---|---|
| 1 Schema, seed, invariants | 35m |
| 2 Nest app, db service, row types, classes | 40m |
| 3 Expiry | 20m |
| 4 Hold and the race | 40m |
| 5 Mock payments | 25m |
| 6 Pay, confirm, refund | 45m |
| 7 Roster | 15m |
| 8 Screens | 30m |
| 9 Demo script | 15m |
| 10 README, AI_USAGE | 30m |
| **Total** | **4h 55m** |

Over budget by 55 minutes. If it has to give, cut Task 8 to the parent flow only and drop the admin screen — the roster endpoint already satisfies the brief, and `?admin=1` is a nicety. That is the first cut, and it gets recorded in the README rather than quietly dropped. The second cut is the demo script, since the tests already cover every scenario it narrates.

## Self-review

Spec coverage: data model, statuses, holds, both race points, layer split, API, mock payment, verification, seed, screens, cuts, monitoring all map to a task. The `refund_failed` path added after the first spec draft is covered by Tasks 5 and 6 and surfaced in Task 7.

Naming: `occupied_seats`, `booking_occupies`, `sync_occupied_seats`, `bookings_one_active_per_child_class`, `trial_classes_not_overbooked`, `SWEEP_SQL`, `BookingService.createHold` / `.pay` / `.describe`, `PaymentsService.reserve` / `.charge` / `.refund` / `.providerRefund`, `ExpiryService.sweep` are used consistently across tasks. The sweep SQL is defined once, in `ExpiryService` (Task 3), and consumed by the hold transaction (Task 4), the payment path (Task 6) and `npm run expire-holds`. Expiry precedes the booking service deliberately: a hold that cannot be released is not finished.

Known ordering dependency: one assertion in Task 6 calls the roster endpoint built in Task 7. Flagged in the task rather than reordered, because the payment tests belong next to the payment code.
