#!/usr/bin/env bash
# Bring the database up if it is the bundled one, then load schema + seed.
set -euo pipefail
cd "$(dirname "$0")/.."

# .env is read here too, so USE_BUNDLED_DB can live alongside DATABASE_URL.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Set USE_BUNDLED_DB=0 when DATABASE_URL points at a Postgres you already run.
if [ "${USE_BUNDLED_DB:-1}" = "1" ]; then
  docker compose up -d --wait db
fi

exec npx ts-node scripts/db-reset.ts
