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

# Order matters: build the new image, bring up ONLY the datastores, run
# migrations, and only THEN (re)start the app. This guarantees new app code never
# runs against the old schema — and if a migration fails, `set -e` aborts here,
# BEFORE the new api starts, so the old (working) container keeps serving instead
# of a new one 500ing on missing columns. Our migrations are additive, so the
# still-running old code tolerates the schema during this window.
echo "▶ building image…"
$COMPOSE build

echo "▶ starting database + redis (waiting for healthy)…"
$COMPOSE up -d --wait postgres redis

echo "▶ applying database migrations (before any new app code runs)…"
# --no-deps: datastores are already up. --user root: migrate writes prisma cache
# (the app otherwise runs as the unprivileged 'node' user).
$COMPOSE run --rm --no-deps --user root api pnpm --filter @paedavic/database run deploy

echo "▶ starting app…"
$COMPOSE up -d

echo "▶ recent api logs:"
$COMPOSE logs --tail=30 api
echo "✅ done. Watch live: $COMPOSE logs -f api"
