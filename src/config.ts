import 'dotenv/config';

// Defaults match the bundled Postgres in docker-compose.yml, so the project
// runs with no .env at all. See .env.example for the overrides.
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://ottodot:ottodot@localhost:5433/ottodot';

export const PORT = Number(process.env.PORT ?? 3000);

// How long a seat stays held before the sweep releases it. Applies to
// pending_payment and nothing else.
export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 600);

export const TRIAL_PRICE_CENTS = 4900;

// How long the mock provider takes over a tok_slow / tok_refund_fail charge.
// It has to outlive a short hold for the refund path to be reachable at all.
// Raise it to demonstrate that path by hand — the window is otherwise too
// narrow to click through, which is the point of the design but awkward to show.
export const SLOW_CHARGE_MS = Number(process.env.SLOW_CHARGE_MS ?? 1500);

// Host and database only — never the password, which would otherwise end up in
// logs and screen recordings.
export function describeTarget(): string {
  try {
    const url = new URL(DATABASE_URL);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'configured database';
  }
}
