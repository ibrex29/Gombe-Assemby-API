#!/bin/sh
set -e

echo "==> Starting Electromon API (NODE_ENV=${NODE_ENV})"
cd /app
exec node dist/main.js
