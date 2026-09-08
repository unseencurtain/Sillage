#!/usr/bin/env bash
# The development loop, on the dev box. Run from ~/sillage-dev.
#
#   ./scripts/dev.sh up          bring the stack up (engine hot-reload + Vite HMR)
#   ./scripts/dev.sh down        stop it, keep the database
#   ./scripts/dev.sh logs [svc]  follow logs (default: engine + dashboard)
#   ./scripts/dev.sh restart     restart the engine only
#   ./scripts/dev.sh test        run the engine test suite in the container
#   ./scripts/dev.sh check       typecheck
#   ./scripts/dev.sh sync        one offline sync from .feedscratch fixtures
#   ./scripts/dev.sh sync-live   one live vendor sync (read-only; costs API budget)
#   ./scripts/dev.sh migrate     apply database migrations
#   ./scripts/dev.sh db          MariaDB shell
#   ./scripts/dev.sh wp <args>   wp-cli inside the WordPress container
#   ./scripts/dev.sh finalize    flush WooCommerce caches after a manual SQL change
#   ./scripts/dev.sh cron on|off run the scheduler, or stop it
#   ./scripts/dev.sh status      what is running, and on which images
#
# Editing is the point: src/**.ts restarts the API in about a second, web/**.tsx hot-swaps into
# the open tab, and the bridge plugin's PHP is live on the next request. None of that needs a
# rebuild, a docker cp, or this script.
#
# Vendor orders cannot leave this box — the engine runs with SILLAGE_DEV_BOX=1, which overrules
# the Orders page's Live button. See src/storefront/profile.ts.
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "no .env here — run from the dev stack directory" >&2; exit 1; }
[[ -f compose.dev.yaml ]] || { echo "no compose.dev.yaml — this is not the dev stack" >&2; exit 1; }

dc() { docker compose -f compose.yaml -f compose.dev.yaml --env-file .env "$@"; }

cmd="${1:-help}"
shift || true

case "$cmd" in
  up)
    dc up -d "$@"
    echo
    dc ps --format 'table {{.Name}}\t{{.Status}}'
    ;;
  down)    dc down "$@" ;;
  restart) dc restart sillage-core "$@" ;;
  logs)
    if [[ $# -gt 0 ]]; then dc logs -f --tail 100 "$@"
    else dc logs -f --tail 100 sillage-core sillage-web
    fi
    ;;
  status)
    dc ps --format 'table {{.Name}}\t{{.Status}}\t{{.Image}}'
    ;;
  test)     dc exec -T sillage-core bun test "$@" ;;
  check)    dc exec -T sillage-core bun run typecheck ;;
  migrate)  dc exec -T sillage-core bun run migrate ;;
  # Offline by default: the fixtures under .feedscratch are real downloaded feeds, so a normal
  # dev loop costs the wholesalers nothing and cannot be rate-limited mid-debug.
  sync)      dc exec -T sillage-core bun run sync -- --source=local --vendor="${1:-all}" ;;
  sync-live) dc exec -T sillage-core bun run sync -- --source=live --vendor="${1:?vendor required: beautyfort|bts}" ;;
  db)
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
    docker exec -it -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot "$@"
    ;;
  wp)       docker exec -u www-data ecom wp "$@" ;;
  finalize) bash scripts/wp-finalize.sh ;;
  cron)
    case "${1:-}" in
      on)  dc --profile cron up -d sillage-cron ;;
      off) dc stop sillage-cron 2>/dev/null || true; dc rm -f sillage-cron 2>/dev/null || true ;;
      *)   echo "usage: dev.sh cron on|off" >&2; exit 1 ;;
    esac
    ;;
  help|-h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $cmd (try: dev.sh help)" >&2; exit 1 ;;
esac
