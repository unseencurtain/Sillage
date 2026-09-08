#!/usr/bin/env bash
# Guard: an empty Ubuntu VPS must be able to come up from this repo alone.
# Run from repo root or this directory. No Docker, no VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PE="$ROOT/production-environment"
fail=0

check() {
  local msg="$1"
  shift
  if "$@"; then
    echo "ok  $msg"
  else
    echo "FAIL  $msg" >&2
    fail=1
  fi
}

check "bootstrap-host installs unzip (WooCommerce zip on first boot)" \
  grep -qE 'apt-get install -y .*unzip' "$PE/scripts/bootstrap-host.sh"

check "bootstrap-host installs python3 (vps-bootstrap patches wp-config)" \
  grep -qE 'apt-get install -y .*python3' "$PE/scripts/bootstrap-host.sh"

check "WordPress image is pinned, not wordpress:latest" \
  grep -qE '^FROM wordpress:7\.1-php8\.3-apache$' "$PE/wordpress-image/Dockerfile"
check "WordPress Dockerfile does not float latest" \
  grep -qvE '^FROM wordpress:latest$' "$PE/wordpress-image/Dockerfile"

check "build-push-images defaults to core+WordPress" \
  grep -qE '^WITH_WORDPRESS=1$' "$PE/scripts/build-push-images.sh"

check "deploy-vps defaults to core+WordPress" \
  grep -qE '^WITH_WORDPRESS=1$' "$PE/scripts/deploy-vps.sh"

check "deploy-vps copies wp-fresh-install.php onto the VPS" \
  grep -q 'scripts/wp-fresh-install.php' "$PE/scripts/deploy-vps.sh"

check "remote first-boot runs wp-fresh-install.php inside ecom" \
  grep -q 'ecom php /tmp/wp-fresh-install.php' "$PE/scripts/deploy-vps.sh"

check "first-boot PHP enables HPOS" \
  grep -q "woocommerce_custom_orders_table_enabled" "$PE/scripts/wp-fresh-install.php"

check "first-boot PHP turns Coming soon off" \
  grep -q "woocommerce_coming_soon" "$PE/scripts/wp-fresh-install.php"

check "deploy copies permalinks htaccess" \
  grep -q 'wordpress.htaccess' "$PE/scripts/deploy-vps.sh"

check "deploy does not rsync deleted wholesale bootstrap" \
  grep -qv 'bootstrap-wholesale.sh' "$PE/scripts/deploy-vps.sh"

check "deploy remote script has no stray extra fi before Caddy" \
  python3 - "$PE/scripts/deploy-vps.sh" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
# The quoted REMOTE heredoc used to contain a leftover `fi` after IMAGES_SITE_BLOCK.
idx = text.find("<<'REMOTE'")
if idx < 0:
    raise SystemExit(1)
body = text[idx:]
if "\nfi\n\nfi\n" in body or "\nfi\n\nsudo tee /etc/caddy/Caddyfile" in body:
    raise SystemExit(1)
raise SystemExit(0)
PY

check "docs no longer claim fresh deploy leaves HPOS off" \
  grep -qv 'fresh deploy leaves HPOS' "$ROOT/docs/VPS-DEPLOY.md"

check "deploy-vps does not default dashboard user to admin" \
  grep -qvE '^DASHBOARD_USER=admin$' "$PE/scripts/deploy-vps.sh"

check "wp-fresh-install refuses admin username" \
  grep -q 'must not be admin' "$PE/scripts/wp-fresh-install.php"

check "Login form does not pre-fill admin" \
  grep -q 'useState("")' "$PE/sillage-core/web/src/pages/Login.tsx"

if [[ "$fail" -ne 0 ]]; then
  echo "empty-VPS contract failed" >&2
  exit 1
fi
echo "empty-VPS contract passed"
