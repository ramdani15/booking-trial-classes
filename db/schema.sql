-- Two invariants are enforced here rather than in application code:
--
--   1. A trial class never exceeds its capacity.
--   2. A child is never active in the same class twice.
--
-- Application code checks both first, to produce a friendly error. Correctness
-- does not depend on those checks. The application never computes "is there
-- room" and then acts on its own answer — that gap between reading and writing
-- is the bug. It attempts the write and lets the database rule.

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

-- Keeps occupied_seats in step with bookings.status and, as a side effect,
-- serialises concurrent claims on one class: the second transaction blocks on
-- this UPDATE until the first commits, then re-evaluates the CHECK against the
-- committed row.
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
