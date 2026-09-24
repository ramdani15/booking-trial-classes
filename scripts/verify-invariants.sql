-- Proves the database refuses to break its own rules with no application code
-- present. Runs inside a transaction and rolls back, so the seed survives.
--
-- Each case asserts on the error class raised, not merely that an error
-- occurred: a check that passes because the wrong constraint fired is worse
-- than no check at all.
--
--   docker compose exec -T db psql -U ottodot -d ottodot < scripts/verify-invariants.sql

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
