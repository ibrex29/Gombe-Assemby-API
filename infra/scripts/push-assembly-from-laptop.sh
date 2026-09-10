#!/usr/bin/env bash
# Rsync Assembly API + web to the SLUK droplet and run the droplet deploy scripts.
# Does not touch ~/Pantamiyya-API or ~/Pantamiyya-Web.
set -euo pipefail

LAPTOP_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HOST="${PANTAMIYYA_ASSEMBLY_SSH_HOST:-sluk-droplet}"
API_SRC="$LAPTOP_ROOT/electromon-api-assembly"
WEB_SRC="$LAPTOP_ROOT/electromon-web-assembly"
API_DEST="${PANTAMIYYA_ASSEMBLY_API_PATH:-Pantamiyya-Assembly-API}"
WEB_DEST="${PANTAMIYYA_ASSEMBLY_WEB_PATH:-Pantamiyya-Assembly-Web}"

RSYNC_EXCLUDES=(
  --exclude node_modules
  --exclude .next
  --exclude dist
  --exclude .git
  --exclude .env
  --exclude '.env.*'
  --exclude coverage
  --exclude /uploads
  --exclude '*.log'
  --exclude .DS_Store
  --exclude .turbo
  --exclude .pnpm-store
)

echo "==> Rsync API → ${HOST}:~/${API_DEST}"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "$API_SRC/" "${HOST}:~/${API_DEST}/"

echo "==> Rsync web → ${HOST}:~/${WEB_DEST}"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "$WEB_SRC/" "${HOST}:~/${WEB_DEST}/"

echo "==> Ensure droplet .env files"
ssh "$HOST" bash -s -- "$API_DEST" "$WEB_DEST" <<'REMOTE'
set -euo pipefail
API_DEST="$1"
WEB_DEST="$2"
if [[ ! -f "$HOME/$API_DEST/.env" ]]; then
  if [[ ! -f "$HOME/Pantamiyya-API/.env" ]]; then
    echo "ERROR: ~/Pantamiyya-API/.env missing; cannot bootstrap Assembly .env"
    exit 1
  fi
  cp "$HOME/Pantamiyya-API/.env" "$HOME/$API_DEST/.env"
  echo "Copied ~/Pantamiyya-API/.env → ~/$API_DEST/.env"
fi
chmod +x "$HOME/$API_DEST/infra/scripts/"*.sh "$HOME/$WEB_DEST/infra/scripts/"*.sh
REMOTE

if [[ -f "$WEB_SRC/.env" ]]; then
  MAPBOX_LINE="$(grep -E '^NEXT_PUBLIC_MAPBOX_TOKEN=' "$WEB_SRC/.env" || true)"
  {
    echo "PANTAMIYYA_ASSEMBLY_API_PUBLIC_URL=https://assemblyapi.pantamiyyaa.alphabetandnumbers.com"
    echo "PANTAMIYYA_ASSEMBLY_WEB_PORT=5304"
    echo "NEXT_PUBLIC_SISTER_APP_URL=https://pantamiyya.alphabetandnumbers.com"
    echo "NEXT_PUBLIC_SISTER_APP_LABEL=Governorship"
    if [[ -n "$MAPBOX_LINE" ]]; then
      echo "$MAPBOX_LINE"
    fi
  } | ssh "$HOST" "cat > ~/${WEB_DEST}/.env"
fi

echo "==> Deploy Assembly API"
ssh "$HOST" "cd ~/${API_DEST} && ./infra/scripts/deploy-pantamiyya-assembly-droplet.sh"

echo "==> Deploy Assembly web"
ssh "$HOST" "cd ~/${WEB_DEST} && ./infra/scripts/deploy-pantamiyya-assembly-droplet.sh"

echo "==> Done. Public hostnames still need nginx + certbot on the droplet."
