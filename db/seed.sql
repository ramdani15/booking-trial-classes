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
