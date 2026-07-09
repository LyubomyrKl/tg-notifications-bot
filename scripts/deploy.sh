#!/usr/bin/env bash
# One-command deploy/redeploy on the server. Run from the repo root: scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

# Update source: pull if this is a git checkout with an upstream; otherwise assume
# the code was copied here (rsync) and just use what's on disk.
git config --global --add safe.directory "$PWD" 2>/dev/null || true
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "▶ pulling latest code…"
  git pull --ff-only
else
  echo "▶ no git upstream — using files on disk (rsync mode)"
fi

echo "▶ building + starting…"
$COMPOSE up -d --build

echo "▶ applying database migrations…"
$COMPOSE run --rm api pnpm --filter @paedavic/database run deploy

echo "▶ recent api logs:"
$COMPOSE logs --tail=30 api
echo "✅ done. Watch live: $COMPOSE logs -f api"
