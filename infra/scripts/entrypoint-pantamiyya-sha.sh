#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

echo "==> Applying Gombe SHA constituency roster..."
cd /app/db
./node_modules/.bin/tsx prisma/scripts/sha-apply.ts --allow-partial
echo "==> SHA roster apply complete."
