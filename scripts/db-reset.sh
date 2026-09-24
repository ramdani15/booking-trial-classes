#!/usr/bin/env bash
# Bring the database up and reload it from schema + seed. Idempotent.
# psql runs inside the container, so the host needs only Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait db
for f in db/schema.sql db/seed.sql "$@"; do
  echo "--> $f"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U ottodot -d ottodot -q < "$f"
done
echo "database ready"
