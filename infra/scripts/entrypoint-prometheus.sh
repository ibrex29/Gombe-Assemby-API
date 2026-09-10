#!/bin/sh
set -e

TOKEN_FILE="${METRICS_TOKEN_FILE:-/etc/prometheus/metrics_token}"
mkdir -p "$(dirname "$TOKEN_FILE")"

if [ -n "$METRICS_TOKEN" ]; then
  printf '%s' "$METRICS_TOKEN" > "$TOKEN_FILE"
else
  # Prometheus requires a non-empty credentials file; API ignores Bearer when METRICS_TOKEN is unset.
  printf '%s' "local-dev-unused" > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true

exec /bin/prometheus "$@"
