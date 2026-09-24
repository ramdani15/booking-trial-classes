// Tests must not inherit a local .env. Set before anything imports config, so
// dotenv (which never overwrites an existing value) leaves these alone.
process.env.SLOW_CHARGE_MS = '1500';
process.env.HOLD_TTL_SECONDS = '600';
