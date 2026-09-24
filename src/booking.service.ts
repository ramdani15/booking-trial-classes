import { Injectable } from '@nestjs/common';
import { DbService, pgCode } from './db.service';
import { ExpiryService } from './expiry.service';
import { BookingRow } from './rows';
import { BookingError } from './errors';

// The hold window. Applies to pending_payment and nothing else: confirming
// clears expires_at, and the bookings_hold_has_expiry constraint means a
// confirmed booking cannot carry a deadline at all.
export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 600);

@Injectable()
export class BookingService {
  constructor(
    private readonly db: DbService,
    private readonly expiry: ExpiryService,
  ) {}

  async createHold(studentId: number, trialClassId: number): Promise<BookingRow> {
    try {
      return await this.db.withTransaction(async (client) => {
        // Release any lapsed holds on this class first, so an abandoned tab
        // never keeps a seat from the next parent who asks for it.
        await this.expiry.sweep(client, trialClassId);

        // No capacity check here on purpose. Counting first and inserting
        // second is the bug: two parents both read three, both write, and the
        // class holds five. The INSERT fires a trigger that UPDATEs the class
        // row, so the second transaction blocks on that row until the first
        // commits, then re-evaluates the CHECK against the committed count.
        const { rows } = await client.query<BookingRow>(
          `insert into bookings (student_id, trial_class_id, status, expires_at)
           values ($1, $2, 'pending_payment', now() + ($3 || ' seconds')::interval)
           returning id, student_id, trial_class_id, status, expires_at, created_at, updated_at, status_reason`,
          [studentId, trialClassId, HOLD_TTL_SECONDS],
        );
        return rows[0];
      });
    } catch (err) {
      // The database is what prevents overbooking. This only translates its
      // refusal into something a parent can read.
      switch (pgCode(err)) {
        case '23514':
          throw new BookingError('class_full', 'This trial class is full.');
        case '23505':
          throw new BookingError(
            'already_booked',
            'This child already has an active booking for this class.',
          );
        case '23503':
          throw new BookingError('not_found', 'Unknown student or trial class.');
        default:
          throw err;
      }
    }
  }
}
