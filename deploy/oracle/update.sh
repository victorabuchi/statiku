#!/bin/bash
# Brings the server up to date with GitHub: when main has a new commit, or Statiku isn't running (a build that
# failed), Statiku is built again and restarted. Run by statiku-update.timer every five minutes, one run at a time;
# with --force it builds regardless.
set -euo pipefail
exec 9>/run/statiku-update.lock
flock 9
cd /opt/statiku
compose() { docker compose -f deploy/oracle/compose.yaml --env-file deploy/oracle/.env "$@"; }
git fetch -q origin main
running=$(compose ps --status running -q statiku 2>/dev/null || true)
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || [ -z "$running" ] || [ "${1:-}" = "--force" ]; then
  git reset -q --hard origin/main
  export GIT_COMMIT=$(git rev-parse HEAD)
  compose up -d --build --remove-orphans
  docker image prune -f >/dev/null
  echo "Statiku is at $(git log -1 --format='%h %s')"
fi
