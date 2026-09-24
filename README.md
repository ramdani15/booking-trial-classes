# Trial Class Booking

A trial-class booking slice where overbooking and duplicate bookings are
impossible because Postgres refuses them, and a payment that outlives its seat
hold is refunded automatically.

## How to run it

Needs Docker and Node 20.

```bash
npm install
npm run db:reset     # starts Postgres, loads schema + seed
npm test             # 33 tests against the real database
npm run demo         # walks all six scenarios and asserts as it goes
npm start            # http://localhost:3000   (admin: /?admin=1)
```

The database invariants can also be checked with no application code present:

```bash
npm run verify:db
```

To point at a Postgres you already run instead of the bundled one, copy
`.env.example` to `.env`, set `DATABASE_URL`, and set `USE_BUNDLED_DB=0`. Nothing
else changes — `db:reset`, the tests, the demo and the app all read the same
value. Verified against Postgres 14 and 16.

## What was built

Trial booking only, as specified — no regular enrollment.

A parent picks a child and a class, which **holds** a seat for ten minutes. The
hold occupies the seat but puts nobody on the roster. Paying converts the hold
into a confirmed booking; a declined card leaves the hold intact so the parent
can retry; an abandoned hold is released back to the class. Staff get a roster
of confirmed students plus the counts that tell them whether the seat machinery
is behaving.

Four screens of plain HTML and `fetch`, no build step. Every screen is a call
that could equally be made with `curl`.

## Time spent

Around four hours, most of it design and verification rather than typing. The
commit history is compressed because the design and the task-by-task plan were
written first and committed before any code — the implementation then followed
them in one sitting, AI-assisted throughout. See [AI_USAGE.md](AI_USAGE.md).

The verification is where the time went, and it is the part worth having: the
concurrency test is only worth anything because it was made to fail first.

## Assumptions

- One price for all trial classes, SGD 49.00, fixed in code.
- Capacity is per class (`trial_classes.capacity`) and happens to be 4 everywhere
  in the seed. Nothing hardcodes 4.
- A parent may hold seats in several classes at once, but only one active
  booking per child per class.
- Ten minutes is a reasonable hold. It is `HOLD_TTL_SECONDS` and nothing
  depends on the value.
- No authentication in scope, so the caller names a `student_id` from the seed.
- All times UTC.

## Data model

```
parents ──< students ──< bookings >── trial_classes
                             │
                             └──< payment_attempts
```

| Table | Carries |
|---|---|
| `parents`, `students` | who is booking, and for whom |
| `trial_classes` | `capacity`, and `occupied_seats` as the seat counter |
| `bookings` | `status`, and `expires_at` while a seat is held |
| `payment_attempts` | one row per attempt, with `idempotency_key` unique |

`occupied_seats` counts live holds **plus** confirmed students. It is
denormalised deliberately: it is not a cache of a count, it is the lock point.
Every attempt to occupy a seat must `UPDATE` that one row, which is what
serialises parents competing for the same seat.

## Booking statuses

| Status | Occupies a seat | On roster | Set by |
|---|---|---|---|
| `pending_payment` | yes, until `expires_at` | no | booking created |
| `confirmed` | yes, permanently | **yes** | payment succeeded and seat claimed |
| `payment_failed` | no | no | sweep: hold lapsed after a declined card |
| `expired` | no | no | sweep: hold lapsed, payment never attempted |
| `seat_unavailable` | no | no | paid, lost the seat, refunded |
| `cancelled` | no | no | staff |

The roster is `where status = 'confirmed'`, so a failed payment cannot reach it:
there is no transition from a failed payment to `confirmed`.

## Endpoints

| Method | Path | |
|---|---|---|
| `GET` | `/classes` | classes with `seats_available` |
| `GET` | `/students` | seeded families (stands in for auth) |
| `POST` | `/bookings` | `{student_id, trial_class_id}` → holds a seat |
| `POST` | `/bookings/:id/pay` | `{payment_token, idempotency_key}` |
| `GET` | `/bookings/:id` | status and full payment history |
| `GET` | `/admin/classes/:id/roster` | confirmed students, plus hold and refund counts |
| — | `npm run expire-holds` | the background job |

Errors carry a stable `code`: `class_full`, `already_booked`, `hold_expired`,
`payment_declined`, `seat_unavailable`, `booking_not_pending`,
`payment_in_progress`, `not_found`.

## How duplicate bookings are prevented

```sql
create unique index bookings_one_active_per_child_class
  on bookings (student_id, trial_class_id)
  where status in ('pending_payment', 'confirmed');
```

Partial, so it covers holds as well as confirmations — one child cannot hold two
seats in the same class. A lapsed or failed booking leaves the covered set, so a
parent can always retry. The application catches SQLSTATE `23505` and answers
`409 already_booked`; it does not decide anything.

## How payment failure is handled

A declined card **keeps the hold**. Losing a trial slot to a mistyped card number
is a bad product, so the parent retries inside the remaining window. The hold is
what expires, not the booking. The attempt is recorded as `failed` with its
reason, and if the hold then lapses the sweep marks the booking `payment_failed`
rather than plain `expired`, so the difference survives.

A failed payment never reaches `confirmed`, and the roster reads `confirmed`
only, so the child cannot appear on it.

## How two parents competing for the last seat are handled

Holds block, so User B cannot select the slot User A is holding. The brief's
literal scenario — both selecting the same last slot — cannot occur here. The
race does not disappear; it splits into two, and both halves are handled.

### Point 1 — two parents claim the last hold

There is **no capacity check in the application**. Counting first and inserting
second is the bug:

```
parent A: SELECT count(*) -> 3      parent B: SELECT count(*) -> 3
parent A: INSERT                    parent B: INSERT
                                    the class now holds 5
```

Instead the insert is simply attempted. It fires a trigger that `UPDATE`s
`trial_classes.occupied_seats`, so a competing transaction **blocks on that row**
until the first commits, then re-evaluates the CHECK against the committed
count. No explicit `FOR UPDATE`, no advisory lock, no queue.

Ten parents reaching for one seat simultaneously produce one `201` and nine
`409 class_full`. To prove that test tests something, the constraint was
weakened and it was re-run: **all ten were then given a seat in a class that
seats four.** The application code is identical in both runs.

### Point 2 — the hold lapses while the payment is in flight

The only way money and seats can disagree.

```
POST /bookings/:id/pay
  not pending_payment  -> 409, no charge
  expires_at <= now()  -> 410 hold_expired, no charge      <- the common case
  charge
    declined  -> 402, hold kept, retry allowed
    succeeded -> UPDATE ... WHERE status='pending_payment' AND expires_at > now()
                   1 row  -> 200 confirmed
                   0 rows -> refund -> 409 seat_unavailable
```

The hold is checked **before** the card is touched, so a parent who simply came
back too late gets a `410` and no money moves — a test asserts `payment_attempts`
is empty in that case. Only a charge that outlived its own hold reaches the
refund.

That refund is a **compensating action, not a rollback**. No transaction spans
Postgres and a payment provider: a database can `ROLLBACK` and the writes cease
to exist, but a charge cannot be un-made, so the opposite action is performed
instead. Where the provider refuses the refund, the attempt is recorded as
`refund_failed` and surfaced on the admin roster. That is the only state this
system cannot resolve by itself.

## Which checks live where

| Layer | Owns |
|---|---|
| **UI** | Hiding full classes, showing the countdown. Convenience only; it trusts nothing and the backend refuses independently |
| **Backend** | Transaction boundaries, mapping SQLSTATE to HTTP, payment orchestration, idempotency, the refund compensation |
| **Database** | Capacity, uniqueness, seat accounting. The only layer whose "no" is authoritative |
| **Background job** | Releasing lapsed holds |

The job exists because expiry is time-based and **a database does nothing at a
point in time**: `expires_at` passing fires no code, so the row keeps occupying a
seat until some SQL runs. The same statement runs two ways — lazily inside every
claim transaction, so busy classes self-heal, and on a schedule via
`npm run expire-holds` for the quiet ones, where nobody arrives to trigger the
lazy sweep and the counts would otherwise stay wrong all day.

## Verification

- `npm test` — 33 tests, 6 suites, against a real Postgres. The database is the
  thing under test, so mocking it would mock the answer.
- `scripts/verify-invariants.sql` — proves the database refuses violations with
  no application code present. Each case asserts on the error class raised
  (`check_violation` versus `unique_violation`), not merely that an error
  occurred, so a check cannot pass because the wrong constraint fired.
- `npm run demo` — all six scenarios end to end, asserting as it goes, exit code
  1 on any mismatch.

The mock payment provider is deterministic, never random. `POST /bookings/:id/pay`
takes a `payment_token`:

| Token | Behaviour |
|---|---|
| `tok_ok` | succeeds |
| `tok_decline` | declined at the card |
| `tok_slow` | succeeds after `SLOW_CHARGE_MS`, long enough to outlive a short hold |
| `tok_refund_fail` | as `tok_slow`, then refuses to be refunded |

A demo that fails at random is worse than no demo. The screens offer these as
plain choices rather than raw token names, because a parent would never pick
one — they stand in for a card form so every outcome is reachable on demand.

`SLOW_CHARGE_MS` defaults to 1500. The refund path needs a charge that outlives
its hold, and that window is deliberately narrow, so raising it is the way to
walk that path by hand rather than through the tests.

## What was deliberately cut

| Cut | What I would do instead |
|---|---|
| Authentication | Session on the parent, every query scoped to their children |
| Real payment provider | The mock sits behind one interface; swapping it is a file, not a redesign. Webhook reconciliation for charges whose response was lost |
| Versioned migrations | `db/schema.sql` drops and recreates. Fine here, wrong for anything holding data |
| An ORM | The invariants are a partial index, a CHECK and a trigger. Prisma expresses none of them, Drizzle one, so an ORM would sit on hand-written migration SQL rather than replace it. Every value is parameterised; row types are hand-written in `src/rows.ts` |
| Waitlist | The obvious next feature: a lapsed hold notifies the first waiter |
| Notifications | Hold expiry is silent. Really it should email at two minutes remaining |
| Timezones | Everything UTC. Class times belong in the centre's zone, rendered in the parent's |
| Rate limiting | A parent can hold seats across many classes. Cap live holds per parent |
| Regular enrollment | Out of scope per the brief |

## What I would monitor after release

- **`refund_failed` — must be zero.** Every one is a parent charged for a class
  they are not in. Alert, not a dashboard.
- **Refunds from `seat_unavailable`** — should be near zero. A rise means the
  payment call is outliving the hold, so either the TTL or the provider is wrong.
- **Holds lapsing unpaid, as a share of holds created** — the funnel leak, and
  what sets the right TTL.
- **Constraint violations per hour** — the application pre-checks nothing for
  capacity, so a steady rate is genuine contention on a popular class. A sudden
  change is worth knowing about either way.
- **`occupied_seats` against a recomputed count**, on a schedule. A mismatch
  means the trigger has a hole.
- **Decline rate by reason.**

## What I would do next

Waitlist on lapsed holds. A real provider behind the mock's interface, with
webhook reconciliation for the charge whose response never arrived. Per-parent
hold limits. An admin action to release a seat and notify. And a load test on
the hold path for a popular class, to find where that row lock starts to bite —
it serialises every claim for one class, which is correct and, at some arrival
rate, will be the first thing to slow down.

## Design and plan

[`docs/DESIGN.md`](docs/DESIGN.md) is the design this was built from.
[`docs/PLAN.md`](docs/PLAN.md) is the task-by-task implementation plan.
