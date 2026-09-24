// Hand-written because the schema is small and stable. What these buy is that
// a status string which does not exist fails to compile — the mistake raw SQL
// actually invites.

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'expired'
  | 'seat_unavailable'
  | 'cancelled';

export type PaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'refund_failed';

export type BookingRow = {
  id: number;
  student_id: number;
  trial_class_id: number;
  status: BookingStatus;
  expires_at: Date | null;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

export type TrialClassRow = {
  id: number;
  subject: string;
  starts_at: Date;
  capacity: number;
  occupied_seats: number;
};

export type PaymentAttemptRow = {
  id: number;
  booking_id: number;
  idempotency_key: string;
  amount_cents: number;
  status: PaymentStatus;
  provider_ref: string | null;
  refund_ref: string | null;
  failure_reason: string | null;
};

export type StudentRow = {
  id: number;
  parent_id: number;
  name: string;
  grade: string;
};
