import { Injectable } from '@nestjs/common';
import { DbService, pgCode } from './db.service';
import { ExpiryService } from './expiry.service';
import { PaymentsService } from './payments.service';
import { BookingRow } from './rows';
import { BookingError } from './errors';
import { HOLD_TTL_SECONDS } from './config';

@Injectable()
export class BookingService {
  constructor(
    private readonly db: DbService,
    private readonly expiry: ExpiryService,
    private readonly payments: PaymentsService,
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
           returning id, student_id, trial_class_id, status, expires_at,
                     status_reason, created_at, updated_at`,
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

  async pay(bookingId: number, token: string, idempotencyKey: string) {
    const previous = await this.payments.findByKey(idempotencyKey);
    if (previous) return this.replay(previous, bookingId);

    const booking = await this.load(bookingId);

    if (booking.status !== 'pending_payment') {
      throw new BookingError('booking_not_pending', `This booking is ${booking.status}.`, {
        booking_status: booking.status,
      });
    }

    // Check the hold before taking any money, so the ordinary case of a parent
    // returning too late never becomes a refund.
    if (!booking.expires_at || booking.expires_at.getTime() <= Date.now()) {
      await this.expiry.sweep(this.db, booking.trial_class_id);
      throw new BookingError('hold_expired', 'This seat hold has expired. Please book again.');
    }

    // Reserve the key before charging: a concurrent replay loses this insert
    // and is turned away rather than charged a second time.
    const attemptId = await this.payments.reserve(bookingId, idempotencyKey);
    if (attemptId === null) {
      throw new BookingError('payment_in_progress', 'This payment is already being processed.');
    }

    const charge = await this.payments.charge(token);
    if (!charge.ok) {
      await this.payments.markFailed(attemptId, charge.reason);
      // The hold survives a declined card. Losing a seat to a mistyped number
      // is a bad product; the hold is what expires, not the booking.
      throw new BookingError('payment_declined', 'The card was declined.', {
        reason: charge.reason,
        hold_expires_at: booking.expires_at,
      });
    }
    await this.payments.markSucceeded(attemptId, charge.ref);

    // Claim the seat. The WHERE clause is the guard: if the hold lapsed while
    // the charge was in flight, no row matches and the money has to go back.
    const claimed = await this.db.query(
      `update bookings set status = 'confirmed', expires_at = null
        where id = $1 and status = 'pending_payment' and expires_at > now()
        returning id`,
      [bookingId],
    );
    if (claimed.rowCount === 1) return this.describe(bookingId);

    return this.releaseAndRefund(bookingId, attemptId, charge.ref);
  }

  // Money taken, seat gone. No transaction spans Postgres and a payment
  // provider, so this is a compensating action rather than a rollback.
  private async releaseAndRefund(bookingId: number, attemptId: number, providerRef: string) {
    const refundRef = await this.payments.refund(attemptId, providerRef);

    await this.db.query(
      `update bookings
          set status = 'seat_unavailable', expires_at = null, status_reason = $2
        where id = $1 and status <> 'confirmed'`,
      [bookingId, refundRef ? 'seat_taken_refunded' : 'seat_taken_refund_failed'],
    );

    throw new BookingError(
      'seat_unavailable',
      refundRef
        ? 'The seat was taken before your payment completed, so it has been refunded.'
        : 'The seat was taken before your payment completed and the refund did not go through. Our team will be in touch.',
      { refund_ref: refundRef },
    );
  }

  // A replayed key returns the outcome the first attempt had, rather than a
  // fresh one. Replaying a decline as a success would be worse than charging
  // twice, because nobody would notice.
  private async replay(previous: { status: string; refund_ref: string | null }, bookingId: number) {
    switch (previous.status) {
      case 'pending':
        throw new BookingError('payment_in_progress', 'This payment is already being processed.');
      case 'failed':
        throw new BookingError('payment_declined', 'The card was declined.');
      case 'refunded':
      case 'refund_failed':
        throw new BookingError(
          'seat_unavailable',
          'The seat was taken before your payment completed.',
          { refund_ref: previous.refund_ref },
        );
      default:
        return this.describe(bookingId);
    }
  }

  private async load(bookingId: number): Promise<BookingRow> {
    const { rows } = await this.db.query<BookingRow>(`select * from bookings where id = $1`, [
      bookingId,
    ]);
    if (!rows[0]) throw new BookingError('not_found', 'No such booking.');
    return rows[0];
  }

  async describe(bookingId: number) {
    const { rows } = await this.db.query(
      `select b.id, b.status, b.status_reason, b.expires_at,
              s.name as student_name, t.id as trial_class_id, t.subject, t.starts_at,
              coalesce(
                (select json_agg(json_build_object(
                          'status', pa.status,
                          'provider_ref', pa.provider_ref,
                          'refund_ref', pa.refund_ref,
                          'failure_reason', pa.failure_reason)
                        order by pa.id)
                   from payment_attempts pa where pa.booking_id = b.id),
                '[]'::json) as payment_attempts
         from bookings b
         join students s on s.id = b.student_id
         join trial_classes t on t.id = b.trial_class_id
        where b.id = $1`,
      [bookingId],
    );
    if (!rows[0]) throw new BookingError('not_found', 'No such booking.');
    return rows[0];
  }
}
