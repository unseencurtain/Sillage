#!/usr/bin/env bash
# Build the test WordPress image and (re)start the test container on the VPS.
# Runs ON THE VPS. Does not touch the live "ecom" container or the live database.
#
# Requires: $STATE_DIR/.env with TEST_DB_PASSWORD (created by ops/test/README.md step 2).
# Plugin source is bind-mounted read-only from the repo copy, so code changes need only a
# re-sync and a container restart, not an image rebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${STATE_DIR:-$HOME/sillage-test}"
PORT="${TEST_PORT:-8180}"
NET="${TEST_NETWORK:-ecom_network}"
DB_HOST="${TEST_DB_HOST:-ecom-db}"
DB_NAME="${TEST_DB_NAME:-sillage_test}"
DB_USER="${TEST_DB_USER:-wptest}"
FRONT="${TEST_FRONTEND_URL:-http://localhost:5173}"
IMG="sillage-test-wordpress:latest"
VOL="sillage_test_html"
URL="http://127.0.0.1:${PORT}"

[ -f "$STATE_DIR/.env" ] || { echo "Missing $STATE_DIR/.env (TEST_DB_PASSWORD)"; exit 1; }
# shellcheck disable=SC1091
. "$STATE_DIR/.env"

docker build -q -f "$ROOT/ops/test/Dockerfile" -t "$IMG" "$ROOT" >/dev/null
docker volume create "$VOL" >/dev/null
docker rm -f sillage-test >/dev/null 2>&1 || true

docker run -d --name sillage-test --restart unless-stopped \
  --network "$NET" \
  -p "127.0.0.1:${PORT}:80" \
  -v "$VOL:/var/www/html" \
  -v "$ROOT/plugins/headless-core:/var/www/html/wp-content/plugins/headless-core:ro" \
  -v "$ROOT/plugins/headless-woocommerce:/var/www/html/wp-content/plugins/headless-woocommerce:ro" \
  -v "$ROOT/plugins/storefront-ean:/var/www/html/wp-content/plugins/storefront-ean:ro" \
  -v "$ROOT/plugins/sillage-warehouses:/var/www/html/wp-content/plugins/sillage-warehouses:ro" \
  -v "$ROOT/plugins/purelymail-smtp:/var/www/html/wp-content/plugins/purelymail-smtp:ro" \
  -e WORDPRESS_DB_HOST="$DB_HOST" \
  -e WORDPRESS_DB_USER="$DB_USER" \
  -e WORDPRESS_DB_PASSWORD="$TEST_DB_PASSWORD" \
  -e WORDPRESS_DB_NAME="$DB_NAME" \
  -e WORDPRESS_CONFIG_EXTRA="define('WP_HOME','$URL');define('WP_SITEURL','$URL');define('HEADLESS_FRONTEND_URL','$FRONT');define('HEADLESS_ALLOWED_ORIGINS',['$FRONT']);define('DISALLOW_FILE_EDIT',true);" \
  "$IMG" >/dev/null

echo "sillage-test running on $URL (localhost only). Waiting for WordPress..."
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "$URL/wp-login.php"; then echo "up"; exit 0; fi
  sleep 2
done
echo "WordPress did not answer in time. See: docker logs sillage-test"; exit 1
