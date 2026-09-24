# Trial Booking — Design

Ottodot Senior Full-Stack Engineer take-home.

## Problem

Parents book a trial class for a child and pay for it. Trial classes seat 4.
Staff need a roster that is true at class time. The system must hold under four
conditions the brief names: duplicate bookings, overbooking, payment failure,
and two parents competing for the last seat.

## Constraints

- 4 hours of effort, self-reported.
- Backend correctness and explanation are scored; frontend polish is not.
- No stack is mandated. The brief accepts "a CLI, script, API endpoint, server
  action, or minimal app" and "a working full-stack or backend-led flow".

## Stack

NestJS + Postgres 16 in Docker, Jest against a real database, four static HTML
screens served by Nest.

Postgres rather than SQLite or in-memory because the correctness argument rests
on row locks and deferred constraint evaluation. NestJS rather than Next.js
because the 4 hours should buy correctness, not stack ramp-up. The invariants
live in SQL, so they move to Supabase unchanged — same engine.

## Scope

In: choosing a child and class, holding a seat, a mock payment, booking status,
a roster for staff, and the four edge cases.

Out: authentication, a real payment provider, regular enrollment, waitlists,
notifications, timezone handling, rate limiting.

## Core idea

Two invariants are enforced by the database, not by application code:

1. A class never exceeds capacity.
2. A child is never active in the same class twice.

Application code checks both first, to produce a friendly error. Correctness
does not depend on those checks. The application never computes "is there room"
and then acts on its own answer — that gap between reading and writing is the
bug. It attempts the write and lets the database rule.

## Data model

```sql
parents(id, name, email unique, created_at)

students(id, parent_id -> parents, name, grade, created_at)

trial_classes(
  id, subject, starts_at,
  capacity        int not null default 4 check (capacity > 0),
  occupied_seats  int not null default 0,
  constraint trial_classes_not_overbooked
    check (occupied_seats between 0 and capacity)
)

bookings(
  id, student_id -> students, trial_class_id -> trial_classes,
  status booking_status not null default 'pending_payment',
  expires_at timestamptz,          -- set while holding, cleared on confirm
  status_reason text,
  created_at, updated_at
)

create unique index bookings_one_active_per_child_class
  on bookings (student_id, trial_class_id)
  where status in ('pending_payment', 'confirmed');

payment_attempts(
  id, booking_id -> bookings,
  idempotency_key text not null unique,
  amount_cents int not null check (amount_cents > 0),
  status payment_status not null,   -- pending | succeeded | failed
                                    -- | refunded | refund_failed
  provider_ref text,
  refund_ref text,
  failure_reason text,
  created_at
)
```

`occupied_seats` counts rows whose status is `pending_payment` or `confirmed` —
live holds plus confirmed students. It is maintained by an `after insert or
update or delete` trigger on `bookings` and guarded by the CHECK constraint.

It is denormalised deliberately. It is not a cache of a count; it is the lock
point. Every attempt to occupy a seat must `UPDATE` that one row, which
serialises competing transactions on it.

The uniqueness index covers holds as well as confirmations, so a child cannot
hold two seats in the same class. A booking that lapses or fails payment leaves
the covered set, so a parent can always retry.

## Statuses

| Status | Occupies a seat | On roster | Set by |
|---|---|---|---|
| `pending_payment` | yes, until `expires_at` | no | booking created |
| `confirmed` | yes, permanently | **yes** | payment succeeded and seat claimed |
| `payment_failed` | no | no | sweep: hold lapsed, last attempt declined |
| `expired` | no | no | sweep: hold lapsed, never paid |
| `seat_unavailable` | no | no | paid, claim lost, refunded |
| `cancelled` | no | no | staff |

The roster is `where status = 'confirmed'`. A failed payment cannot reach it,
because there is no transition from a failed payment to `confirmed`.

A declined card keeps the hold. The parent retries within the remaining window
rather than losing the seat to a typo. The hold, not the booking, is what
expires.

## Holds

Selecting a class reserves the seat for `HOLD_TTL_SECONDS` (default 600). Tests
override it to force the lapse cases.

A parent who holds the last seat and closes the tab must not keep it. Expiry is
time-based, and a database does nothing at a point in time: `expires_at` passing
at 10:10 fires no code, and the row keeps counting toward `occupied_seats` until
some SQL runs. So the release has to be driven, by one of two triggers running
identical SQL:

- **Lazily**, as the first statement of every claim transaction for that class.
  Busy classes therefore self-heal — the next parent to try releases the ghosts.
  This also makes tests deterministic and means the demo never waits on a
  scheduler.
- **On a schedule**, via `npm run expire-holds`, which is what cron or pg_cron
  would call. It covers the quiet classes: without it, a class that filled with
  abandoned holds at 09:00 still reads "no seats" at 17:00 and the admin view
  lies.

The sweep takes its rows with `for update skip locked`, so two sweeps running at
once step over each other's rows instead of deadlocking on them.

The sweep also assigns the terminal status: `payment_failed` where the last
attempt was declined, `expired` where payment was never attempted.

## The two race points

Blocking holds change the scenario the brief describes. Under these rules, User
B cannot select a slot User A is holding — B is refused at selection. The race
does not disappear; it splits in two, and both halves need an answer.

### Point 1 — two parents claim the last hold

```
BEGIN
  release lapsed holds for this class
  INSERT booking (pending_payment, expires_at = now() + ttl)
    -> trigger: UPDATE trial_classes SET occupied_seats = occupied_seats + 1
       -> row lock: the second transaction blocks here until the first commits
       -> CHECK occupied_seats <= capacity
          -> 23514 check_violation when the class is full
COMMIT
```

The second transaction does not read a stale count, because it cannot proceed
until the first commits and it then re-evaluates against the committed row. The
loser receives `409 class_full`. No explicit `FOR UPDATE`, no advisory lock, no
queue.

`23505` from the uniqueness index means the same child is already active in the
class, answered as `409 already_booked`.

### Point 2 — the hold lapses mid-payment

The only way money and seats can disagree. Handled by checking the hold before
charging, so the common case never takes money it cannot honour:

```
POST /bookings/:id/pay
  status not pending_payment  -> 409, no charge
  expires_at <= now()         -> 410 hold_expired, no charge
  charge (mock provider)
    declined -> 402, hold kept, parent may retry
    succeeded ->
      BEGIN
        UPDATE bookings SET status='confirmed', expires_at=null
         WHERE id=$1 AND status='pending_payment' AND expires_at > now()
      COMMIT
        1 row -> 200 confirmed
        0 rows -> refund the attempt
               -> status seat_unavailable
               -> 409 with refund reference
```

The refund path is narrow by construction: it needs the hold to lapse between
the pre-charge check and the UPDATE, meaning the payment call outlived the
remaining hold. It is still reachable, so it is implemented and tested, with the
TTL driven to a second and latency injected into the mock provider.

No transaction spans Postgres and a payment provider, so the refund is a
compensating action in application code, not a rollback. A database transaction
can `ROLLBACK` and the writes cease to exist; a charge cannot be un-made, so the
system performs the opposite action instead. That boundary is the one genuinely
distributed part of this system.

The refund runs automatically inside the same request. No queue, no staff
involvement. The parent sees the outcome and the refund reference on the screen
that told them the seat was gone.

### When the refund itself fails

Provider unreachable, money taken, no seat. This is the one state the system
cannot resolve by itself: the attempt is recorded as `refund_failed`, the
booking is still `seat_unavailable`, and the count surfaces on the admin roster.
It is the only place a human is needed, and it should be zero. A production
version would retry with backoff from the same job that releases holds, and page
someone if the count stays non-zero.

## Layer responsibilities

| Layer | Owns |
|---|---|
| UI | Hiding full classes, showing the countdown. Convenience only; trusts nothing. |
| Backend | Transaction boundaries, mapping Postgres error codes to HTTP, payment orchestration, idempotency, the refund compensation |
| Database | Capacity, uniqueness, seat accounting. The only layer whose "no" is authoritative |
| Background job | Releasing lapsed holds |

## API

| Method | Path | Returns |
|---|---|---|
| GET | `/classes` | classes with `seats_available` |
| GET | `/students` | seeded parents and children (no auth in scope) |
| POST | `/bookings` | `{student_id, trial_class_id}` → 201 hold with `expires_at`, or 409 |
| POST | `/bookings/:id/pay` | `{payment_token, idempotency_key}` → 200 / 402 / 409 / 410 |
| GET | `/bookings/:id` | status, reason, payment attempts |
| GET | `/admin/classes/:id/roster` | confirmed students, plus live holds, lapsed count, refund count |

Errors carry a stable `code` (`class_full`, `already_booked`, `hold_expired`,
`payment_declined`, `seat_unavailable`) so the tests and the UI assert on
something other than prose.

## Mock payment

Deterministic, never random — a flaky demo is worse than no demo.

- `tok_ok` succeeds.
- `tok_decline` fails with `card_declined`.
- `tok_slow` succeeds after a delay, used to force the lapse-mid-payment case.
- `tok_refund_fail` behaves as `tok_slow` and then refuses to refund, used to
  force the one state a human has to resolve. It has to be slow too: the refund
  path is only reachable when the charge outlives the hold.

`idempotency_key` is unique in the table. A replay returns the stored result
instead of charging again.

## Verification

Jest against a real Postgres. The database is not mocked; mocking it would mock
the thing under test.

| Test | Asserts |
|---|---|
| 10 parallel holds on a 1-seat class | exactly 1 × 201, 9 × 409 `class_full`; `occupied_seats` = capacity |
| duplicate active booking | 409 `already_booked`; roster unchanged |
| declined card | 402, hold survives, retry with `tok_ok` confirms |
| lapse mid-payment | 409 `seat_unavailable`, payment attempt `refunded`, child absent from roster |
| refund itself fails | attempt `refund_failed`, surfaced on the admin roster, child still absent |
| idempotency replay | one row in `payment_attempts`, same response |
| sweep | lapsed holds release seats; `payment_failed` vs `expired` set correctly |
| roster | confirmed only; never a pending or failed booking |

Two things run without the application at all:

- `scripts/verify-invariants.sql` — proves the database refuses violations on
  its own. Asserts on the error class raised (`check_violation` versus
  `unique_violation`), not merely that an error occurred.
- `npm run demo` — a scripted narration of all six scenarios end to end.

## Seed data

Covers the four cases the brief asks to demonstrate.

| Class | State | Demonstrates |
|---|---|---|
| Science, Sat 10:00 | 0/4 | seats available |
| Math, Sat 14:00 | 3/4 | the last seat, the race target |
| Science, Sun 10:00 | 1/4 | a child already confirmed (duplicate), and a declined payment |

Seat counters are never written by the seed. The trigger derives them, which
doubles as a check that the trigger works.

## Screens

Four, vanilla HTML and `fetch`, served by Nest. No build step, no bundler, no
CSS framework. Every screen is a call that can equally be made with `curl`.

1. Pick a child, pick a class. Full classes and classes the child is already in
   are visibly unavailable.
2. Payment, with the hold countdown and a choice of mock card.
3. Result: confirmed, declined with the hold still ticking, hold expired, or
   seat taken with a refund reference.
4. Admin roster: confirmed students, live holds, holds lapsed today, refunds
   issued.

The admin counters are the monitoring story made visible.

## Deliberate cuts

| Cut | Instead / next |
|---|---|
| Authentication | Parent chosen from seeded data. Real version: session on the parent, all queries scoped to their children |
| Real payment provider | Deterministic mock behind one interface. Swapping it is a file, not a redesign |
| Regular enrollment | Explicitly out of scope per the brief |
| Waitlist | The natural next feature: a lapsed hold notifies the first waiter |
| Notifications | Hold expiry is silent. Real version: email at 2 minutes remaining |
| Timezones | All times UTC. Real version: class times in the centre's zone, rendered in the parent's |
| Rate limiting | A parent can spam holds across classes. Real version: cap live holds per parent |
| Versioned migrations | `db/schema.sql` drops and recreates. Fine for a take-home, wrong for anything with data in it. Real version: numbered, forward-only migrations |
| An ORM | The invariants are a partial index, a CHECK constraint, a trigger and `for update skip locked`. Prisma cannot express any of them and Drizzle only one, so an ORM would sit on hand-written migration SQL rather than replace it. Values are parameterized; row types are hand-written in `src/rows.ts` |

## What to monitor after release

- Refunds arising from `seat_unavailable`. Should be near zero. A rise means the
  payment call is outliving the hold, so either the TTL or the provider is wrong.
- `refund_failed` attempts. Must be zero. Every one is a parent charged for a
  class they are not in, and the only condition in the system that needs a human.
  Alert, not a dashboard.
- Holds that lapse unpaid, as a share of holds created. This is the funnel leak
  and it sets the right TTL.
- Constraint violations per hour. The application pre-checks, so a non-zero rate
  is either genuine contention on a popular class or application logic that has
  drifted from the database. Both worth knowing.
- `occupied_seats` against a recomputed count, on a schedule. A mismatch means
  the trigger has a hole.
- Payment decline rate, split by reason.

## With more time

Waitlist on lapsed holds; a real provider behind the mock's interface, with
webhook reconciliation for charges whose response was lost; per-parent hold
limits; an admin action to release a seat and notify; load testing the hold path
on a popular class to see where the row lock starts to bite.
