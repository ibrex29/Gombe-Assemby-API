#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

if [ -z "$SEED_ADMIN_PASSWORD" ]; then
  echo "ERROR: PANTAMIYYA_SEED_ADMIN_PASSWORD / SEED_ADMIN_PASSWORD is required"
  exit 1
fi

export SEED_DETAIL_STATES="${SEED_DETAIL_STATES:-GO}"

echo "==> Pantamiyya bootstrap seed (Gombe, SEED_DETAIL_STATES=${SEED_DETAIL_STATES})..."
cd /app/db
./node_modules/.bin/tsx prisma/seed-production-pantamiyya.ts
echo "==> Applying Gombe SHA constituency roster..."
./node_modules/.bin/tsx prisma/scripts/sha-apply.ts --allow-partial
echo "==> Pantamiyya seed complete."
