import { Injectable } from '@nestjs/common';
import { DbService, Runner, pgCode } from './db.service';
import { PaymentAttemptRow } from './rows';
import { SLOW_CHARGE_MS, TRIAL_PRICE_CENTS } from './config';

export { TRIAL_PRICE_CENTS };

export type ChargeResult = { ok: true; ref: string } | { ok: false; reason: string };

@Injectable()
export class PaymentsService {
  constructor(private readonly db: DbService) {}

  // Stands in for a real provider. Deterministic by token, never random: a
  // demo that fails at random is worse than no demo, and a test that passes
  // four times in five is not a test.
  //
  //   tok_ok           succeeds
  //   tok_decline      declined at the card
  //   tok_slow         succeeds, but slowly enough to outlive a short hold
  //   tok_refund_fail  as tok_slow, and then refuses to be refunded
  //
  // tok_refund_fail is deliberately slow as well: the refund path is only
  // reachable when the charge outlives the hold, so an instant one would
  // simply confirm the booking and never exercise the compensation.
  private readonly chargedWith = new Map<string, string>();
  private counter = 0;

  async charge(token: string): Promise<ChargeResult> {
    if (token === 'tok_decline') return { ok: false, reason: 'card_declined' };
    if (token === 'tok_slow' || token === 'tok_refund_fail') {
      await new Promise((r) => setTimeout(r, SLOW_CHARGE_MS));
    }

    const ref = `mock_pi_${++this.counter}`;
    this.chargedWith.set(ref, token);
    return { ok: true, ref };
  }

  async providerRefund(providerRef: string): Promise<string> {
    if (this.chargedWith.get(providerRef) === 'tok_refund_fail') {
      throw new Error(`provider refused to refund ${providerRef}`);
    }
    return `mock_rf_${++this.counter}`;
  }

  // Reserving the key before charging is what makes a retry safe. A concurrent
  // replay loses the insert and is told the first attempt is still running,
  // rather than putting a second charge on the card.
  async reserve(bookingId: number, idempotencyKey: string): Promise<number | null> {
    try {
      const { rows } = await this.db.query<{ id: number }>(
        `insert into payment_attempts (booking_id, idempotency_key, amount_cents, status)
         values ($1, $2, $3, 'pending')
         returning id`,
        [bookingId, idempotencyKey, TRIAL_PRICE_CENTS],
      );
      return rows[0].id;
    } catch (err) {
      if (pgCode(err) === '23505') return null;
      throw err;
    }
  }

  async findByKey(idempotencyKey: string): Promise<PaymentAttemptRow | null> {
    const { rows } = await this.db.query<PaymentAttemptRow>(
      `select * from payment_attempts where idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async markSucceeded(attemptId: number, ref: string, runner: Runner = this.db): Promise<void> {
    await runner.query(
      `update payment_attempts set status = 'succeeded', provider_ref = $2 where id = $1`,
      [attemptId, ref],
    );
  }

  async markFailed(attemptId: number, reason: string): Promise<void> {
    await this.db.query(
      `update payment_attempts set status = 'failed', failure_reason = $2 where id = $1`,
      [attemptId, reason],
    );
  }

  // The compensating action. No transaction spans Postgres and a payment
  // provider: a database can ROLLBACK and the writes cease to exist, but a
  // charge cannot be un-made, so the opposite action is performed instead.
  //
  // Returns the refund reference, or null when the provider refused — money
  // taken, seat gone, refund impossible. That is the one state this system
  // cannot resolve by itself, so it is recorded rather than swallowed and
  // surfaced on the admin roster.
  async refund(attemptId: number, providerRef: string): Promise<string | null> {
    try {
      const refundRef = await this.providerRefund(providerRef);
      await this.db.query(
        `update payment_attempts set status = 'refunded', refund_ref = $2 where id = $1`,
        [attemptId, refundRef],
      );
      return refundRef;
    } catch (err) {
      await this.db.query(
        `update payment_attempts set status = 'refund_failed', failure_reason = $2 where id = $1`,
        [attemptId, err instanceof Error ? err.message : String(err)],
      );
      return null;
    }
  }
}
