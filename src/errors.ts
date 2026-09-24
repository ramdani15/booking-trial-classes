import { HttpException } from '@nestjs/common';

// Stable codes so tests, the UI and the demo assert on something other than
// prose.
export type BookingErrorCode =
  | 'class_full'
  | 'already_booked'
  | 'hold_expired'
  | 'payment_declined'
  | 'seat_unavailable'
  | 'booking_not_pending'
  | 'payment_in_progress'
  | 'not_found';

const HTTP_STATUS: Record<BookingErrorCode, number> = {
  class_full: 409,
  already_booked: 409,
  hold_expired: 410,
  payment_declined: 402,
  seat_unavailable: 409,
  booking_not_pending: 409,
  payment_in_progress: 409,
  not_found: 404,
};

export class BookingError extends HttpException {
  constructor(
    readonly code: BookingErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ code, message, ...extra }, HTTP_STATUS[code]);
  }
}
