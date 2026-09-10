#!/usr/bin/env bash
# One-time: clone Pantamiyya branch on the droplet (replaces rsync copy).
#
# Usage (on droplet):
#   curl -fsSL .../bootstrap-pantamiyya-droplet-git.sh | bash
#   # or from an existing rsync tree:
#   cd ~/Pantamiyya-API && ./infra/scripts/bootstrap-pantamiyya-droplet-git.sh
#
# Preserves ~/Pantamiyya-API/.env and Docker volumes (DB/Redis/Rabbit/MinIO).
set -euo pipefail

REPO_URL="${PANTAMIYYA_REPO_URL:-git@github.com:ibrex29/Asiwaju4Arewa-API.git}"
BRANCH="${PANTAMIYYA_GIT_BRANCH:-Pantamiyya}"
TARGET="${PANTAMIYYA_API_PATH:-$HOME/Pantamiyya-API}"
BACKUP_SUFFIX=".rsync-backup-$(date +%Y%m%d%H%M%S)"

if [[ -d "$TARGET/.git" ]]; then
  echo "==> Already a git repo at ${TARGET}"
  cd "$TARGET"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
  echo "==> Updated to $(git log -1 --oneline)"
  exit 0
fi

ENV_BACKUP=""
if [[ -f "$TARGET/.env" ]]; then
  ENV_BACKUP="$(mktemp)"
  cp "$TARGET/.env" "$ENV_BACKUP"
  echo "==> Backed up .env from ${TARGET}"
fi

if [[ -d "$TARGET" ]]; then
  echo "==> Moving ${TARGET} → ${TARGET}${BACKUP_SUFFIX}"
  mv "$TARGET" "${TARGET}${BACKUP_SUFFIX}"
fi

echo "==> Cloning ${REPO_URL} (branch ${BRANCH}) → ${TARGET}"
git clone -b "$BRANCH" "$REPO_URL" "$TARGET"

if [[ -n "$ENV_BACKUP" ]]; then
  cp "$ENV_BACKUP" "$TARGET/.env"
  rm -f "$ENV_BACKUP"
  echo "==> Restored .env"
elif [[ -f "$HOME/Asiwaju4Arewa-API/.env" ]]; then
  cp "$HOME/Asiwaju4Arewa-API/.env" "$TARGET/.env"
  echo "==> Copied .env from national API (edit Pantamiyya secrets before deploy)"
fi

chmod +x "$TARGET/infra/scripts/"*.sh
echo "==> Done. Deploy with:"
echo "    cd ${TARGET} && ./infra/scripts/deploy-pantamiyya-droplet.sh"
