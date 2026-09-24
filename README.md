# Trial Class Booking

A trial-class booking slice where overbooking and duplicate bookings are
impossible because Postgres refuses them, and a parent who loses the last seat
at the moment of payment is refunded automatically.

## How to run it

Needs Docker and Node 20.

```bash
npm install
npm run db:reset     # starts Postgres, loads schema + seed
npm test             # 33 tests against the real database
npm run demo         # walks all six scenarios and asserts as it goes
npm start            # http://localhost:3000   (admin: /?admin=1)
```

The database invariants can also be checked with no application code present.
It asserts against the seeded rows, so reset first if the demo or the app has
been run since:

```bash
npm run db:reset && npm run verify:db
```

To point at a Postgres you already run instead of the bundled one, copy
`.env.example` to `.env`, set `DATABASE_URL`, and set `USE_BUNDLED_DB=0`. Nothing
else changes — `db:reset`, the tests, the demo and the app all read the same
value. Verified against Postgres 14 and 16.

## What was built

Trial booking only, as specified — no regular enrollment.

A parent picks a child and a class, which creates a booking that is an intent to
pay — it reserves nothing. Several parents can be paying for the last seat at
once. The seat goes to whichever payment commits first; the others are charged
and immediately refunded. A declined card changes nothing, so the parent can
retry until the payment window closes. Staff get a roster of confirmed students
plus the counts that say whether the seat machinery is behaving.

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
- A child may have one active booking per class, but several children may be
  paying for the same last seat at once. That is the point.
- Ten minutes is a reasonable window to complete a payment. It is
  `HOLD_TTL_SECONDS` and nothing depends on the value.
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

`occupied_seats` counts confirmed bookings and nothing else. It is denormalised
deliberately: it is not a cache of a count, it is the lock point. Every attempt
to take a seat must `UPDATE` that one row, which is what serialises parents
competing for the same one — and because only a confirmation occupies a seat,
that contention lands on the payment.

## Booking statuses

| Status | Occupies a seat | On roster | Set by |
|---|---|---|---|
| `pending_payment` | **no** | no | booking created; payable until `expires_at` |
| `confirmed` | yes, permanently | **yes** | payment succeeded and seat claimed |
| `payment_failed` | no | no | sweep: window closed after a declined card |
| `expired` | no | no | sweep: window closed, payment never attempted |
| `seat_unavailable` | no | no | paid, lost the seat, refunded |
| `cancelled` | no | no | staff |

The roster is `where status = 'confirmed'`, so a failed payment cannot reach it:
there is no transition from a failed payment to `confirmed`.

## Endpoints

| Method | Path | |
|---|---|---|
| `GET` | `/classes` | classes with `seats_available` |
| `GET` | `/students` | seeded families (stands in for auth) |
| `POST` | `/bookings` | `{student_id, trial_class_id}` → an intent to pay; reserves nothing |
| `POST` | `/bookings/:id/pay` | `{payment_token, idempotency_key}` |
| `GET` | `/bookings/:id` | status and full payment history |
| `GET` | `/admin/classes/:id/roster` | confirmed students, plus pending and refund counts |
| — | `npm run expire-holds` | the background job |

Errors carry a stable `code`: `class_full`, `already_booked`, `booking_expired`,
`payment_declined`, `seat_unavailable`, `booking_not_pending`,
`payment_in_progress`, `not_found`.

## How duplicate bookings are prevented

```sql
create unique index bookings_one_active_per_child_class
  on bookings (student_id, trial_class_id)
  where status in ('pending_payment', 'confirmed');
```

Partial, so it covers pending bookings as well as confirmations — one child
cannot queue twice for the same class, while different children compete freely. A lapsed or failed booking leaves the covered set, so a
parent can always retry. The application catches SQLSTATE `23505` and answers
`409 already_booked`; it does not decide anything.

## How payment failure is handled

A declined card changes nothing about the booking, because the booking never
held a seat. The parent retries inside the remaining window. The attempt is
recorded as `failed` with its reason, and if the window then closes the sweep
marks the booking `payment_failed` rather than plain `expired`, so the
difference survives.

A failed payment never reaches `confirmed`, and the roster reads `confirmed`
only, so the child cannot appear on it.

## How two parents competing for the last seat are handled

This is the brief's required scenario, and it runs exactly as written:

```
1. User A selects the last available slot and moves to payment.
2. User B selects the same slot.
3. User B completes payment first and confirms the booking.
4. User A then tries to complete payment.
```

Selecting reserves nothing. Both bookings are `pending_payment`, neither
occupies a seat, and both parents can sit on a payment page believing the seat
is available — which is true, because it is, until someone pays for it.

**The seat is decided by the payment, not the selection.** There is no capacity
check in the application; counting first and inserting second is the bug:

```
parent A: SELECT count(*) -> 3      parent B: SELECT count(*) -> 3
parent A: UPDATE -> confirmed       parent B: UPDATE -> confirmed
                                    the class now holds 5
```

Instead the claim is simply attempted:

```sql
update bookings set status = 'confirmed', expires_at = null
 where id = $1 and status = 'pending_payment' and expires_at > now()
```

That `UPDATE` fires a trigger which increments `trial_classes.occupied_seats`,
so a competing payment **blocks on that row** until the first commits, then
re-evaluates `occupied_seats <= capacity` against the committed count and is
refused with SQLSTATE `23514`. No explicit `FOR UPDATE`, no advisory lock, no
queue.

Ten parents selecting the same seat and paying simultaneously produce **one
confirmation and nine refunds**. To prove that test tests something, the
constraint was weakened and it was re-run: every one of them was confirmed into
a class that seats four. The application code is identical in both runs.

### The loser has already been charged

That is the cost of matching this scenario, and it is the interesting part. The
charge succeeded; the seat did not. It cannot be rolled back — no transaction
spans Postgres and a payment provider, and a database can `ROLLBACK` while a
charge cannot be un-made. So the opposite action is performed instead: the
payment is refunded, the booking becomes `seat_unavailable`, and the parent is
told, with the refund reference, on the screen that broke the news.

Where the provider itself refuses the refund, the attempt is recorded as
`refund_failed` and surfaced on the admin roster. That is the only state this
system cannot resolve by itself, and it should always be zero.

### The trade-off accepted

The alternative is to reserve the seat when a parent selects it, so nobody pays
for a seat they cannot get. That is a better experience and a worse answer here:
it makes the brief's step 2 impossible — User B would be refused at selection —
and it moves the contended write off the payment path, which is exactly where
the interesting failure lives. Reserving also has to be undone by a timer, so a
parent who abandons the tab holds a seat nobody can buy until it expires.

Charging and refunding the loser is the honest trade: the money always ends up
in the right place, and the seat is never double-sold.

### The other way to lose

A booking left past `expires_at` can no longer be paid. The window is checked
**before** the card is touched, so this costs nothing — `410`, and a test
asserts `payment_attempts` is empty. It exists so a booking cannot sit payable
for ever, not to protect the seat.

## Which checks live where

| Layer | Owns |
|---|---|
| **UI** | Hiding full classes and classes the child is already in, showing the countdown. Convenience only; it trusts nothing, and a stale tab proves it — the backend refuses regardless |
| **Backend** | Transaction boundaries, mapping SQLSTATE to HTTP, payment orchestration, idempotency, the refund compensation |
| **Database** | Capacity, uniqueness, seat accounting. The only layer whose "no" is authoritative |
| **Background job** | Closing bookings whose payment window has passed |

The job exists because expiry is time-based and **a database does nothing at a
point in time**: `expires_at` passing fires no code, so a booking stays payable
until some SQL closes it. The same statement runs two ways — lazily inside every
booking transaction, so busy classes tidy themselves, and on a schedule via
`npm run expire-holds` for the quiet ones, where nobody arrives to trigger the
lazy sweep and stale bookings would otherwise linger all day.

It is housekeeping, not enforcement. Nothing about capacity depends on it, which
is deliberate: a background job that the correctness of the system rested on
would be a background job that could take the system down by not running.

## Verification

- `npm test` — 33 tests, 6 suites, against a real Postgres. The database is the
  thing under test, so mocking it would mock the answer.
- `npm run verify:db` — runs `scripts/verify-invariants.sql`, proving the
  database refuses violations with no application code present. It reads the
  seeded rows, so it wants a freshly reset database. Each case asserts on the
  error class raised
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
the seat it was paying for. Raising it widens the window in which another parent
can take the seat mid-charge, which is how to walk that path by hand.

## What was deliberately cut

| Cut | What I would do instead |
|---|---|
| Authentication | Session on the parent, every query scoped to their children |
| Real payment provider | The mock sits behind one interface; swapping it is a file, not a redesign. Webhook reconciliation for charges whose response was lost |
| Versioned migrations | `db/schema.sql` drops and recreates. Fine here, wrong for anything holding data |
| An ORM | The invariants are a partial index, a CHECK and a trigger. Prisma expresses none of them, Drizzle one, so an ORM would sit on hand-written migration SQL rather than replace it. Every value is parameterised; row types are hand-written in `src/rows.ts` |
| Waitlist | The obvious next feature, and the answer if refunds get common: queue for the seat instead of racing for it |
| Notifications | Losing the seat and being refunded is silent beyond the response. It should be an email |
| Timezones | Everything UTC. Class times belong in the centre's zone, rendered in the parent's |
| Rate limiting | A parent can open bookings across many classes. Cap open bookings per parent |
| Regular enrollment | Out of scope per the brief |

## What I would monitor after release

- **`refund_failed` — must be zero.** Every one is a parent charged for a class
  they are not in. Alert, not a dashboard.
- **Refunds from `seat_unavailable`** — the normal cost of this design, but the
  rate matters. A popular class producing many of them means parents are being
  charged and refunded routinely, which is the signal to add a waitlist or to
  reserve the seat at selection after all.
- **Bookings lapsing unpaid, as a share of bookings created** — the funnel leak,
  and what sets the right window.
- **Constraint violations per hour** — the application pre-checks nothing for
  capacity, so a steady rate is genuine contention on a popular class. A sudden
  change is worth knowing about either way.
- **`occupied_seats` against a recomputed count**, on a schedule. A mismatch
  means the trigger has a hole.
- **Decline rate by reason.**

## What I would do next

A waitlist, which is the real answer to a class where parents are routinely
charged and refunded. A real provider behind the mock's interface, with webhook
reconciliation for the charge whose response never arrived. Per-parent limits on
open bookings. An admin action to release a seat and notify. And a load test on
the payment path for a popular class, to find where that row lock starts to bite
— it serialises every claim for one class, which is correct and, at some arrival
rate, will be the first thing to slow down.

## Design and plan

[`docs/DESIGN.md`](docs/DESIGN.md) is the design this was built from.
[`docs/PLAN.md`](docs/PLAN.md) is the task-by-task implementation plan.
