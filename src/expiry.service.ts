import { Injectable } from '@nestjs/common';
import { Runner } from './db.service';

// A database does nothing at a point in time. `expires_at` passing fires no
// code, so an abandoned hold keeps occupying a seat until this SQL runs —
// lazily on the next claim for that class, or on a schedule for the classes
// nobody is currently looking at.
//
// `for update skip locked` means two sweeps running at once step over each
// other's rows instead of deadlocking on them.
//
// The terminal status records why the hold ended: payment_failed where the
// parent tried and was declined, expired where they never tried at all.
// expires_at is cleared because bookings_hold_has_expiry allows a deadline on
// a hold and on nothing else.
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
       status_reason = 'booking_expired',
       expires_at = null
  from stale
 where b.id = stale.id
returning b.id`;

@Injectable()
export class ExpiryService {
  // Takes a Runner so it can join the caller's transaction — the hold path
  // sweeps and claims atomically — or run standalone from the job.
  async sweep(runner: Runner, trialClassId: number | null): Promise<number> {
    const { rowCount } = await runner.query<{ id: number }>(SWEEP_SQL, [trialClassId]);
    return rowCount ?? 0;
  }
}
