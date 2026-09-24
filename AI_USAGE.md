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
immediately, ending the booking. I rejected it. Losing a trial slot to a
mistyped card number is a bad product, so a decline leaves the booking alone and
the parent retries inside the window it already has.

**Schema that had drifted from the design.** Mid-way through, the written design
and the schema had stopped agreeing in three places: the seat counter, a
uniqueness index that covered confirmed rows only, and a missing expiry column.
None of it would have failed to compile and the tests would have passed. The
index was the one that mattered — as written it would have let one child queue
twice for the same class, quietly. Worth recording because a spec and a schema
drifting apart is invisible to a test suite that was written from the code.

**A design that made the requirement unreachable.** This is the one worth
reading. The first build reserved the seat when a parent selected a class, so
the class showed full the moment someone started paying. It is a better product
— nobody is charged for a seat they cannot get — and I accepted the suggestion.
What neither of us did was check it against the brief's numbered scenario, whose
step 2 is "User B selects the same slot". Under a reservation, User B is refused
at step 2 and never reaches step 4, which is the step the whole exercise is
about. Worse, the README I had it write explained at length why that scenario
"cannot occur", which is a confident way of answering a different question.

I caught it by walking the scenario in the UI rather than reading the code, and
rebuilt it: selecting reserves nothing, the seat is claimed by whichever payment
commits first, and the losers are refunded. One line of SQL changed —
`booking_occupies` went from `status in ('pending_payment','confirmed')` to
`status = 'confirmed'` — and the enforcement stayed exactly where it was, a
trigger and a CHECK, simply firing on the payment instead of on the selection.
The lesson I would keep: an explanation of why a requirement does not apply is
the point to stop and re-read the requirement.

**Where it warned me and I did not listen.** It said early that reserving the
seat on selection would make the brief's literal scenario impossible, and I
treated that as a thing to document rather than a thing to fix — so the first
README argued the point at length instead of changing the design. The warning
was correct and a paragraph of explanation was the wrong response to it. That is
the same failure as the one above, caught a second time from the other side.

## What I would change next time

Check the design against the requirement before writing the schema, not after
the tests are green. The seat model was picked from options in a conversation
and only measured against the brief once the whole thing was built. It cost a
rebuild — cheap here, because the rule lived in one SQL function and the tests
described behaviour rather than implementation. In a codebase where that
assumption had spread through migrations, fixtures and callers, it would not
have been.

Second: ask for the check that would fail before asking for the code that passes
it. Getting the test first is what caught the capacity bug above — and writing
the acceptance test straight from the brief's numbered steps would have caught
the seat model on day one.

## How I verified the final implementation

- **`npm test` — 33 tests, 6 suites, against a real Postgres.** The database is
  the thing under test; mocking it would mock the answer.
- **`scripts/verify-invariants.sql`** proves the database refuses violations with
  no application code present. Seven cases, each asserting on the error class
  raised rather than on "an error happened".
- **`npm run demo`** walks all six scenarios end to end and asserts as it goes,
  exiting non-zero on any mismatch, so the printout cannot quietly be lying. Step
  3 is the brief's scenario run literally: ten parents select the same last seat,
  all pay at once, one is confirmed and nine are refunded.
- **The concurrency test was made to fail.** Weakening
  `trial_classes_not_overbooked` and re-running it gave all ten parents a seat in
  a class that seats four. Restoring it returns the run to one `201` and nine
  `409 class_full`, with the application code identical in both runs. A test that
  has never failed is not evidence.

Two tests failed for the right reason during the build and both were worth more
than the code they guarded. One found that Nest answers every `POST` with 201,
where paying settles an existing booking and should be a 200. The other found
that `tok_refund_fail` charged instantly, so the hold had not lapsed by the time
the seat was claimed and the booking simply confirmed — the refund path it exists
to exercise was never reached. The mock was wrong, not the test.
