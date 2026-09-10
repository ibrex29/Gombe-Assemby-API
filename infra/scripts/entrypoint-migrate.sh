#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

# Extract host from DATABASE_URL (supports postgres:// and postgresql://)
# Formats: scheme://user:pass@host:port/db?params  |  scheme://user@host/db
db_host=$(printf '%s' "$DATABASE_URL" | sed -E 's|^[a-zA-Z0-9+.-]+://([^/@]+@)?([^/:?]+).*|\2|')
db_port=$(printf '%s' "$DATABASE_URL" | sed -nE 's|^[a-zA-Z0-9+.-]+://([^/@]+@)?[^/:?]+:([0-9]+).*|\2|p')
db_port="${db_port:-5432}"

if [ -z "$db_host" ] || [ "$db_host" = "$DATABASE_URL" ]; then
  echo "ERROR: Could not parse host from DATABASE_URL"
  exit 1
fi

echo "==> Waiting for database at ${db_host}:${db_port}..."
attempt=0
until nc -z "$db_host" "$db_port" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "ERROR: Database not reachable at ${db_host}:${db_port} after 60s"
    exit 1
  fi
  sleep 2
done

echo "==> Running database migrations..."
cd /app
npx prisma migrate deploy

if [ "$RUN_SEED" = "true" ]; then
  echo "==> Seeding database (demo seed)..."
  npx tsx prisma/seed.ts
fi

echo "==> Migrations complete."
