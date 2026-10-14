#!/usr/bin/env bash
# Rebuild the headless Sillage + React storefront from local source in the recorded order.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FRONTEND="$REPO/../react_store/frontend"
HOST=""
SHOP=""
DASHBOARD_PATH="/sillagedash"
IMAGES_DOMAIN=""
MEDIA_FROM=""
SKIP_BUILD=0

usage() {
  echo "Usage: $0 --host ssh-alias --shop domain --images images.domain [--dashboard-path /sillagedash] [--media-from photo-source-alias] [--skip-build]" >&2
  exit 2
}
while (($#)); do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --shop) SHOP="${2:?}"; shift 2 ;;
    --dashboard-path) DASHBOARD_PATH="${2:?}"; shift 2 ;;
    --images) IMAGES_DOMAIN="${2-}"; shift 2 ;;
    --media-from) MEDIA_FROM="${2:?}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
[[ -n "$HOST" && "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ "$SHOP" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ "$IMAGES_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ "$DASHBOARD_PATH" =~ ^/[A-Za-z0-9/_-]+$ && "$DASHBOARD_PATH" != *".."* ]] || usage
[[ -d "$FRONTEND" ]] || { echo "Missing local React frontend: $FRONTEND" >&2; exit 1; }
[[ -f "$REPO/production-environment/sillage-core/package.json" ]] || { echo "Missing local Sillage dashboard source" >&2; exit 1; }

mkdir -p "$REPO/.deploy"
CHRONO="$REPO/.deploy/deploy-CHRONOLOGY.md"
CHRONO_DOC="$REPO/docs/DEPLOYMENT-CHRONOLOGY.md"
if [[ ! -f "$CHRONO" ]]; then
  printf '# Replication chronology\n\n| UTC | Step | Elapsed | Result |\n|---|---|---:|---|\n' > "$CHRONO"
fi
if [[ ! -f "$CHRONO_DOC" ]]; then
  printf '# Deployment chronology\n\n| UTC | Step | Elapsed | Result |\n|---|---|---:|---|\n' > "$CHRONO_DOC"
fi
run_step() {
  local label="$1" start end elapsed stamp
  shift
  start=$(date +%s)
  echo "==> $label"
  if "$@"; then
    end=$(date +%s); elapsed=$((end-start)); stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '| %s | %s | %ss | complete |\n' "$stamp" "$label" "$elapsed" | tee -a "$CHRONO" "$CHRONO_DOC"
  else
    end=$(date +%s); elapsed=$((end-start)); stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local status=$?
    printf '| %s | %s | %ss | FAILED (exit %s; see run output for diagnostics) |\n' "$stamp" "$label" "$elapsed" "$status" | tee -a "$CHRONO" "$CHRONO_DOC"
    return 1
  fi
}

STACK_ARGS=(--host "$HOST" --shop "$SHOP" --dash "$SHOP" --images "$IMAGES_DOMAIN" --dashboard-path "$DASHBOARD_PATH")
[[ -n "$MEDIA_FROM" ]] && STACK_ARGS+=(--media-from "$MEDIA_FROM")
[[ "$SKIP_BUILD" == 1 ]] && STACK_ARGS+=(--skip-build)
run_step "Local Sillage dashboard build (${DASHBOARD_PATH})" env VITE_BASE_PATH="${DASHBOARD_PATH%/}/" bun --cwd "$REPO/production-environment/sillage-core" run web:build
run_step "WordPress + Sillage stack, migrations, and editable Caddy site" bash "$HERE/deploy-vps.sh" "${STACK_ARGS[@]}"

SSH_CONFIG="$(python3 "$HERE/ssh-config-for-aliases.py" "$HOST")"
trap 'rm -f "$SSH_CONFIG"' EXIT
export SILLAGE_SSH_HOST="$HOST" SILLAGE_SSH_CONFIG="$SSH_CONFIG" SILLAGE_SITE="https://$SHOP"
run_step "Headless WooCommerce plugins" bun "$FRONTEND/tools/sillage-deploy.ts" plugins
run_step "React customer-auth MU plugin" bun "$FRONTEND/tools/sillage-deploy.ts" mu
run_step "Local React build + upload" bun "$FRONTEND/tools/sillage-deploy.ts" frontend
echo "Replication complete: React https://$SHOP, WP Admin https://$SHOP/wp-admin/, dashboard https://$SHOP$DASHBOARD_PATH"
