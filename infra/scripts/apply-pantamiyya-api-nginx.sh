#!/usr/bin/env bash
# Patch Pantamiyya API nginx for Intelligence chat streaming (180s read timeout).
# Run on the droplet (requires sudo password):
#   cd ~/Pantamiyya-API && ./infra/scripts/apply-pantamiyya-api-nginx.sh
set -euo pipefail

CONF="/etc/nginx/conf.d/api.pantamiyya.alphabetandnumbers.com.conf"

if [[ ! -f "$CONF" ]]; then
  echo "ERROR: $CONF not found. Copy the template first:"
  echo "  sudo cp infra/nginx/api.pantamiyya.alphabetandnumbers.com.conf $CONF"
  exit 1
fi

if grep -q 'location /api/v1/ai/assistant/chat' "$CONF"; then
  echo "==> AI chat location already present in $CONF"
else
  echo "==> Inserting /api/v1/ai/assistant/chat location (180s timeout, buffering off)..."
  sudo python3 <<'PY'
from pathlib import Path

path = Path("/etc/nginx/conf.d/api.pantamiyya.alphabetandnumbers.com.conf")
text = path.read_text()
block = """
    # Intelligence chat streams NDJSON for up to ~120s; default nginx 60s causes
    # "network error" in the browser when the proxy aborts mid-answer.
    location /api/v1/ai/assistant/chat {
        proxy_pass http://127.0.0.1:5301;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        proxy_buffering off;
    }
"""
text = text.replace("    location / {", block + "\n    location / {", 1)
path.write_text(text)
PY
fi

if grep -A20 'location / {' "$CONF" | grep -q 'proxy_read_timeout'; then
  echo "==> Main location / already has proxy_read_timeout"
else
  echo "==> Adding proxy_read_timeout to location / ..."
  sudo sed -i '/proxy_cache_bypass \$http_upgrade;/a\
\
        proxy_read_timeout 120s;\
        proxy_send_timeout 120s;' "$CONF"
fi

echo "==> Testing nginx config..."
sudo nginx -t
echo "==> Reloading nginx..."
sudo systemctl reload nginx
echo "==> Done. Intelligence chat should no longer die at 60s."
