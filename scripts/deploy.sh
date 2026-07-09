#!/usr/bin/env bash
# One-command deploy/redeploy on the server. Run from the repo root: scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "▶ pulling latest code…"
git pull --ff-only

echo "▶ building + starting…"
$COMPOSE up -d --build

echo "▶ applying database migrations…"
$COMPOSE run --rm api pnpm --filter @paedavic/database run deploy

echo "▶ recent api logs:"
$COMPOSE logs --tail=30 api
echo "✅ done. Watch live: $COMPOSE logs -f api"
