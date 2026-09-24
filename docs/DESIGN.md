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

In: choosing a child and class, an intent to pay, a mock payment, booking status,
a roster for staff, and the four edge cases.

Out: authentication, a real payment provider, regular enrollment, waitlists,
notifications, timezone handling, rate limiting.

## Core idea

A seat is occupied by a confirmed booking and by nothing else. Selecting a class
records an intent to pay and reserves nothing, so several parents can be paying
for the last seat at once — which is the scenario the brief requires. The seat
goes to whichever payment commits first; the rest are refunded.

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
  expires_at timestamptz,          -- payment window; cleared on confirm
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

`occupied_seats` counts confirmed bookings only. It is maintained by an `after insert or
update or delete` trigger on `bookings` and guarded by the CHECK constraint.

It is denormalised deliberately. It is not a cache of a count; it is the lock
point. Every attempt to occupy a seat must `UPDATE` that one row, which
serialises competing transactions on it.

The uniqueness index covers pending bookings as well as confirmations, so a
child cannot queue twice for the same class. Different children compete freely —
that is the race. A booking that lapses or fails payment leaves the covered set,
so a parent can always retry.

## Statuses

| Status | Occupies a seat | On roster | Set by |
|---|---|---|---|
| `pending_payment` | no | no | booking created; payable until `expires_at` |
| `confirmed` | yes, permanently | **yes** | payment succeeded and seat claimed |
| `payment_failed` | no | no | sweep: window closed, last attempt declined |
| `expired` | no | no | sweep: window closed, never paid |
| `seat_unavailable` | no | no | paid, claim lost, refunded |
| `cancelled` | no | no | staff |

The roster is `where status = 'confirmed'`. A failed payment cannot reach it,
because there is no transition from a failed payment to `confirmed`.

A declined card changes nothing about the booking, which held no seat to begin
with. The parent retries within the remaining window.

## The payment window

A booking is payable until `expires_at`, `HOLD_TTL_SECONDS` after it is made
(default 600). It reserves no seat; the window exists so a booking cannot sit
payable for ever.

Expiry is time-based, and a database does nothing at a point in time:
`expires_at` passing at 10:10 fires no code. So closing lapsed bookings is
driven, by one of two triggers running identical SQL — lazily, as the first
statement of every booking transaction for that class, and on a schedule via
`npm run expire-holds`, which is what cron or pg_cron would call.

This is housekeeping, not enforcement. Capacity does not depend on it, which is
deliberate: a background job the correctness of the system rested on would be a
background job that could take the system down by not running.

The sweep takes its rows with `for update skip locked`, so two sweeps running at
once step over each other rather than deadlocking, and assigns the terminal
status: `payment_failed` where the last attempt was declined, `expired` where
payment was never attempted.

## The race, and where it is decided

The brief's scenario, run as written:

```
1. User A selects the last available slot and moves to payment.
2. User B selects the same slot.
3. User B completes payment first and confirms the booking.
4. User A then tries to complete payment.
```

Steps 1 and 2 both succeed, because selecting reserves nothing. Step 3 takes the
seat. Step 4 is where it is decided:

```
POST /bookings/:id/pay
  not pending_payment  -> 409, no charge
  expires_at <= now()  -> 410 booking_expired, no charge
  charge (mock provider)
    declined  -> 402, booking untouched, retry allowed
    succeeded ->
      UPDATE bookings SET status='confirmed', expires_at=null
       WHERE id=$1 AND status='pending_payment' AND expires_at > now()
        -> trigger: UPDATE trial_classes SET occupied_seats = occupied_seats + 1
           -> row lock: a competing payment blocks here until the first commits
           -> CHECK occupied_seats <= capacity
              -> 23514 when the seat has gone
        committed -> 200 confirmed
        23514     -> refund -> 409 seat_unavailable
```

The contended write is on the payment path, which is where the money is and
therefore where the interesting failure lives. No explicit `FOR UPDATE`, no
advisory lock, no queue.

### The loser has already been charged

That is the cost of this shape. No transaction spans Postgres and a payment
provider: a database can `ROLLBACK` and the writes cease to exist, but a charge
cannot be un-made. So the opposite action is performed instead — the payment is
refunded, the booking becomes `seat_unavailable`, and the parent is told with the
refund reference.

Where the provider refuses the refund, the attempt is recorded as `refund_failed`
and surfaced on the admin roster. It is the only state the system cannot resolve
by itself, and it should always be zero.

### The alternative, and why not

Reserving the seat when a parent selects it means nobody is charged for a seat
they cannot get. It is a better experience. It was built that way first and then
changed, because it makes the brief's step 2 impossible — User B is refused at
selection — and it moves the contended write off the payment path. It also has
to be undone by a timer, so an abandoned tab holds a seat nobody can buy.

Charging and refunding the loser is the honest trade here: the money always ends
up in the right place, and the seat is never double-sold. If refunds became
common on a popular class, the answer is a waitlist rather than a reservation.

## Layer responsibilities

| Layer | Owns |
|---|---|
| UI | Hiding full classes and classes the child is already in, showing the countdown. Convenience only; trusts nothing, and a stale tab proves it. |
| Backend | Transaction boundaries, mapping Postgres error codes to HTTP, payment orchestration, idempotency, the refund compensation |
| Database | Capacity, uniqueness, seat accounting. The only layer whose "no" is authoritative |
| Background job | Closing bookings whose payment window has passed. Housekeeping, not enforcement |

## API

| Method | Path | Returns |
|---|---|---|
| GET | `/classes` | classes with `seats_available` |
| GET | `/students` | seeded parents and children (no auth in scope) |
| POST | `/bookings` | `{student_id, trial_class_id}` → 201 with `expires_at`; reserves nothing |
| POST | `/bookings/:id/pay` | `{payment_token, idempotency_key}` → 200 / 402 / 409 / 410 |
| GET | `/bookings/:id` | status, reason, payment attempts |
| GET | `/admin/classes/:id/roster` | confirmed students, plus bookings awaiting payment, lapsed count, refund count |

Errors carry a stable `code` (`class_full`, `already_booked`, `booking_expired`,
`payment_declined`, `seat_unavailable`) so the tests and the UI assert on
something other than prose.

## Mock payment

Deterministic, never random — a flaky demo is worse than no demo.

- `tok_ok` succeeds.
- `tok_decline` fails with `card_declined`.
- `tok_slow` succeeds after a delay, used to force the lapse-mid-payment case.
- `tok_refund_fail` behaves as `tok_slow` and then refuses to refund, used to
  force the one state a human has to resolve. It has to be slow too: the refund
  path is only reachable when another parent can take the seat mid-charge.

`idempotency_key` is unique in the table. A replay returns the stored result
instead of charging again.

## Verification

Jest against a real Postgres. The database is not mocked; mocking it would mock
the thing under test.

| Test | Asserts |
|---|---|
| 10 parallel payments for a 1-seat class | exactly 1 × 200 confirmed, 9 × 409 `seat_unavailable`, 9 refunded; `occupied_seats` = capacity |
| duplicate active booking | 409 `already_booked`; roster unchanged |
| declined card | 402, booking survives, retry with `tok_ok` confirms |
| losing the seat mid-payment | 409 `seat_unavailable`, payment attempt `refunded`, child absent from roster |
| refund itself fails | attempt `refund_failed`, surfaced on the admin roster, child still absent |
| idempotency replay | one row in `payment_attempts`, same response |
| sweep | lapsed bookings stop being payable; `payment_failed` vs `expired` set correctly |
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
2. Payment, with the window counting down and a choice of mock card.
3. Result: confirmed, declined with the window still open, booking expired, or
   the seat taken by someone else with a refund reference.
4. Admin roster: confirmed students, bookings awaiting payment, lapsed today,
   refunds issued.

The admin counters are the monitoring story made visible.

## Deliberate cuts

| Cut | Instead / next |
|---|---|
| Authentication | Parent chosen from seeded data. Real version: session on the parent, all queries scoped to their children |
| Real payment provider | Deterministic mock behind one interface. Swapping it is a file, not a redesign |
| Regular enrollment | Explicitly out of scope per the brief |
| Waitlist | The natural next feature, and the answer if refunds get common: queue for the seat instead of racing for it |
| Notifications | Losing the seat is silent beyond the response. Real version: email the refund |
| Timezones | All times UTC. Real version: class times in the centre's zone, rendered in the parent's |
| Rate limiting | A parent can open bookings across many classes. Real version: cap open bookings per parent |
| Versioned migrations | `db/schema.sql` drops and recreates. Fine for a take-home, wrong for anything with data in it. Real version: numbered, forward-only migrations |
| An ORM | The invariants are a partial index, a CHECK constraint, a trigger and `for update skip locked`. Prisma cannot express any of them and Drizzle only one, so an ORM would sit on hand-written migration SQL rather than replace it. Values are parameterized; row types are hand-written in `src/rows.ts` |

## What to monitor after release

- Refunds arising from `seat_unavailable`. The normal cost of this design, but
  the rate matters: a class producing many means parents are routinely charged
  and refunded, which is the signal to add a waitlist.
- `refund_failed` attempts. Must be zero. Every one is a parent charged for a
  class they are not in, and the only condition in the system that needs a human.
  Alert, not a dashboard.
- Bookings that lapse unpaid, as a share of bookings created. This is the funnel
  leak and it sets the right window.
- Constraint violations per hour. The application pre-checks, so a non-zero rate
  is either genuine contention on a popular class or application logic that has
  drifted from the database. Both worth knowing.
- `occupied_seats` against a recomputed count, on a schedule. A mismatch means
  the trigger has a hole.
- Payment decline rate, split by reason.

## With more time

A waitlist, which is the real answer to a class where parents are routinely
charged and refunded; a real provider behind the mock's interface, with webhook
reconciliation for charges whose response was lost; per-parent limits on open
bookings; an admin action to release a seat and notify; load testing the payment
path on a popular class to see where the row lock starts to bite.
