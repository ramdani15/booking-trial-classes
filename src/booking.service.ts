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

  // Selecting a class reserves nothing. Two parents can both hold a pending
  // booking for the last seat and both reach payment — which is the scenario
  // this has to support. The seat is taken by whichever payment commits first.
  async createHold(studentId: number, trialClassId: number): Promise<BookingRow> {
    try {
      return await this.db.withTransaction(async (client) => {
        await this.expiry.sweep(client, trialClassId);

        // Advisory only, and knowingly racy: it stops a parent starting a
        // payment for a class that is already full, which is a courtesy rather
        // than a guarantee. Nothing downstream trusts it — the seat is decided
        // by the CHECK constraint when the payment claims it.
        const klass = await client.query<{ full: boolean }>(
          `select occupied_seats >= capacity as full from trial_classes where id = $1`,
          [trialClassId],
        );
        if (!klass.rows[0]) {
          throw new BookingError('not_found', 'Unknown trial class.');
        }
        if (klass.rows[0].full) {
          throw new BookingError('class_full', 'This trial class is full.');
        }

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
      if (err instanceof BookingError) throw err;
      switch (pgCode(err)) {
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
      throw new BookingError('booking_expired', 'This seat hold has expired. Please book again.');
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

    // Claim the seat. This is where parents competing for the last one are
    // resolved: the UPDATE fires a trigger that increments the class row, so a
    // competing payment blocks there until the first commits, then re-evaluates
    // the CHECK against the committed count and is refused with 23514.
    //
    // The WHERE clause covers the other way to lose — the booking lapsed while
    // the charge was in flight — which produces no matching row instead.
    try {
      const claimed = await this.db.query(
        `update bookings set status = 'confirmed', expires_at = null
          where id = $1 and status = 'pending_payment' and expires_at > now()
          returning id`,
        [bookingId],
      );
      if (claimed.rowCount === 1) return this.describe(bookingId);
    } catch (err) {
      // 23514 capacity, 23505 this child confirmed by a concurrent request.
      if (pgCode(err) !== '23514' && pgCode(err) !== '23505') throw err;
    }

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
