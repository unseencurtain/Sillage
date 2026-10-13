#!/usr/bin/env bash
# First-time and repeatable setup of the test store: WordPress, WooCommerce, plugins, seed data,
# Purelymail SMTP. Runs ON THE VPS after up.sh. Safe to re-run (seed is idempotent).
#
# Secrets: $STATE_DIR/.purelymail (600) with PURELYMAIL_USER, PURELYMAIL_PASSWORD, PURELYMAIL_FROM_NAME.
# Admin password: $STATE_DIR/.admin (600), generated on first run if missing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${STATE_DIR:-$HOME/sillage-test}"
PORT="${TEST_PORT:-8180}"
URL="http://127.0.0.1:${PORT}"
VOL="sillage_test_html"
IMG="wordpress:cli-php8.3"
. "$STATE_DIR/.env"

[ -f "$STATE_DIR/.admin" ] || { (umask 077; printf "TEST_ADMIN_PASSWORD=%s\n" "$(openssl rand -base64 18)" > "$STATE_DIR/.admin"); }
# shellcheck disable=SC1091
. "$STATE_DIR/.admin"

wpcli() {
  docker run --rm -i --user 33:33 --network "${TEST_NETWORK:-ecom_network}" \
    -v "$VOL:/var/www/html" \
    -v "$ROOT/ops/test/seed:/seed:ro" \
    -v "$ROOT/plugins/headless-core:/var/www/html/wp-content/plugins/headless-core:ro" \
    -v "$ROOT/plugins/headless-woocommerce:/var/www/html/wp-content/plugins/headless-woocommerce:ro" \
    -v "$ROOT/plugins/storefront-ean:/var/www/html/wp-content/plugins/storefront-ean:ro" \
    -v "$ROOT/plugins/sillage-warehouses:/var/www/html/wp-content/plugins/sillage-warehouses:ro" \
    -v "$ROOT/plugins/purelymail-smtp:/var/www/html/wp-content/plugins/purelymail-smtp:ro" \
    -e WP_CLI_CACHE_DIR=/tmp/wpcli-cache \
    -e WORDPRESS_DB_HOST="${TEST_DB_HOST:-ecom-db}" \
    -e WORDPRESS_DB_USER="${TEST_DB_USER:-wptest}" \
    -e WORDPRESS_DB_PASSWORD="$TEST_DB_PASSWORD" \
    -e WORDPRESS_DB_NAME="${TEST_DB_NAME:-sillage_test}" \
    --env-file "$STATE_DIR/.purelymail" \
    "$IMG" wp "$@"
}

# Mounts match up.sh so WP-CLI sees the same plugin code as the web container.
wpcli core install --url="$URL" --title="Sillage test store" --admin_user=admin \
  --admin_password="$TEST_ADMIN_PASSWORD" --admin_email=hello@aiyuco.com --skip-email 2>/dev/null || true
wpcli plugin install woocommerce --activate
wpcli plugin activate headless-core headless-woocommerce storefront-ean sillage-warehouses purelymail-smtp
wpcli rewrite structure '/%postname%/' --hard
wpcli option update woocommerce_currency EUR
wpcli option update woocommerce_default_country NL
wpcli option update woocommerce_store_address "Bargelaan 200"
wpcli option update woocommerce_store_city Leiden
wpcli eval-file /seed/seed.php

# Purelymail: the plugin encrypts the password itself via its sanitizer.
wpcli eval '
$user = getenv("PURELYMAIL_USER"); $pw = getenv("PURELYMAIL_PASSWORD");
$clean = purelymail_smtp_sanitize_settings(["connections"=>["main"=>["name"=>"Purelymail main","from_email"=>$user,"from_name"=>getenv("PURELYMAIL_FROM_NAME"),"username"=>$user,"password"=>$pw,"security"=>"tls"]],"active_connection"=>"main"]);
update_option(PURELYMAIL_SMTP_OPTION, $clean); echo "smtp: ", $clean["active_connection"], "\n";'
echo "setup complete: $URL (admin user: admin, password in $STATE_DIR/.admin)"
