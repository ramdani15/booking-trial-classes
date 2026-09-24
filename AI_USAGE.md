# AI Usage

## Tools

Claude Code (Opus 5) in the terminal, as the only AI tool. No autocomplete
assistant, no separate chat window.

## What I used it for

- Drafting the schema, the seat-counter trigger and the SQL invariant checks.
- Arguing the design out loud: the seat model, what a declined card should do,
  where the refund belongs. I made the calls; it produced the options and the
  objections.
- Writing the tests, including the concurrency one, and running them against a
  real Postgres container.
- Writing the implementation plan the code was then built from.

## Where it moved me faster

The `sync_occupied_seats` trigger and the `occupied_seats <= capacity` CHECK.
By hand that is twenty minutes of fiddly plpgsql — the insert, update and delete
paths, and the transitions where a booking moves between statuses that both
occupy a seat and so must not double-count. I got it in one pass and spent the
time I saved on proving it holds under concurrency, which is the part that
actually matters.

## Where I corrected or rejected its output

**A test that passed for the wrong reason.** The first invariant check filled
the class using students the seed had already booked, so the case asserting
"the 5th confirmed booking must be rejected" tripped the *duplicate* unique
index rather than the capacity CHECK. Green, and meaningless — a broken capacity
rule would have sailed through it. I rewrote it to create throwaway students so
each invariant is exercised in isolation, and made every case assert on the
error class raised (`check_violation` versus `unique_violation`) instead of
merely that an error occurred.

**A declined card releasing the seat.** The first design moved a booking to a
terminal `payment_failed` the moment the provider said no, which freed the seat
immediately. I rejected it. Losing a trial slot to a mistyped card number is a
bad product. The hold is what expires, not the booking: a decline keeps the seat
until the window runs out, and the parent can retry inside it.

**Schema that had drifted from the design.** Once the hold model was settled I
read the schema back against it and found three things that no longer matched: a
counter named for confirmations when holds also occupy a seat, a uniqueness
index covering only confirmed rows, and no expiry column at all. None of it
would have failed to compile and the tests would have passed. It would simply
have let one child hold two seats in the same class, quietly.

**Where its pushback was right.** It pointed out that blocking holds make the
brief's literal race scenario impossible — User B cannot select a slot User A is
holding. Rather than quietly answer an easier question, the README says so and
answers the harder one: the hold lapsing while the payment is in flight.

## What I would change next time

Settle the seat model before letting it write a line of schema. I let it draft
tables while the hold-versus-claim-on-payment question was still open, and the
first schema quietly assumed claim-on-payment. Rewriting it was cheap here;
on a real codebase that assumption spreads into migrations, fixtures and
callers before anyone notices.

Second: ask for the check that would fail before asking for the code that passes
it. Getting the test first is what caught the capacity bug above.

## How I verified the final implementation

What this has to clear, written down before the code exists so the bar is not
set afterwards to match whatever passed:

- `npm test` — every suite against a real Postgres, never a mock. The database
  is the thing under test; mocking it would mock the answer.
- `scripts/verify-invariants.sql` — proves the database refuses violations with
  no application code present at all.
- Deliberately removed the `trial_classes_not_overbooked` constraint and re-ran
  the concurrency test to confirm it then creates more seats than the class has.
  A test that has never failed is not evidence.
- `npm run demo` — the six scenarios end to end, asserting as it goes.
