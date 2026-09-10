#!/usr/bin/env bash
# Install Assembly nginx vhosts. Requires sudo on the droplet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_SRC="$ROOT/infra/nginx/assemblyapi.pantamiyyaa.alphabetandnumbers.com.conf"
WEB_SRC="${PANTAMIYYA_ASSEMBLY_WEB_NGINX:-$HOME/Pantamiyya-Assembly-Web/infra/nginx/assembly.pantamiyyaa.alphabetandnumbers.com.conf}"

if [[ ! -f "$API_SRC" ]]; then
  echo "ERROR: missing $API_SRC"
  exit 1
fi

sudo cp "$API_SRC" /etc/nginx/conf.d/assemblyapi.pantamiyyaa.alphabetandnumbers.com.conf
if [[ -f "$WEB_SRC" ]]; then
  sudo cp "$WEB_SRC" /etc/nginx/conf.d/assembly.pantamiyyaa.alphabetandnumbers.com.conf
else
  echo "WARNING: web nginx conf not found at $WEB_SRC — API vhost only"
fi

sudo nginx -t
sudo systemctl reload nginx
echo "==> nginx reloaded for assembly.pantamiyyaa / assemblyapi.pantamiyyaa"
echo "    Next: sudo certbot --nginx -d assemblyapi.pantamiyyaa.alphabetandnumbers.com -d assembly.pantamiyyaa.alphabetandnumbers.com"
