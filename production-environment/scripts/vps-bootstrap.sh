#!/usr/bin/env bash
# Run on the VPS as ubuntu. Creates sillage DB user, patches wp-config.
# Expects unified env at ~/sillage/.env (falls back to legacy split envs).
set -euo pipefail

set -a
# shellcheck disable=SC1090
SCRIPT_HOME="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$SCRIPT_HOME/.env" ]]; then
  source "$SCRIPT_HOME/.env"
elif [[ -f "$HOME/sillage/.env" ]]; then
  source "$HOME/sillage/.env"
elif [[ -f "$HOME/ecom_sites/.env" && -f "$HOME/sillage-core/.env" ]]; then
  source "$HOME/ecom_sites/.env"
  source "$HOME/sillage-core/.env"
else
  echo "Missing $SCRIPT_HOME/.env (or ~/sillage/.env)" >&2
  exit 1
fi
set +a

WP_DB="${WORDPRESS_DB:-earth}"
DATA_DIR="${DATA_DIR:-$HOME/ecom_sites/data}"

docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${SILLAGE_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'sillage'@'%' IDENTIFIED BY '${SILLAGE_DB_PASSWORD}';
ALTER USER 'sillage'@'%' IDENTIFIED BY '${SILLAGE_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${SILLAGE_DB}\`.* TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_posts TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_postmeta TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_terms TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_termmeta TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_term_taxonomy TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_term_relationships TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_wc_product_meta_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_wc_product_attributes_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_wc_category_lookup TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_options TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_wc_orders TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE ON \`${WP_DB}\`.wp_wc_order_addresses TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_wc_order_operational_data TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_woocommerce_order_items TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_woocommerce_order_itemmeta TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_woocommerce_attribute_taxonomies TO 'sillage'@'%';
FLUSH PRIVILEGES;
SQL
echo "DB_USER_OK"

if [[ -n "${SILLAGE_DASHBOARD_URL:-}" ]]; then
  DASH_URL="$SILLAGE_DASHBOARD_URL"
elif [[ -n "${DASH_DOMAIN:-}" ]]; then
  DASH_URL="https://${DASH_DOMAIN}"
else
  # No default. This becomes the dashboard link baked into wp-config, and the old fallback named a
  # specific VPS, so a shop on a new domain got a wp-admin link back to the previous box.
  echo "Set DASH_DOMAIN or SILLAGE_DASHBOARD_URL — this is the dashboard link wp-config carries" >&2
  exit 1
fi
# WordPress lives in a Docker volume, so wp-config.php is edited inside the container.
PATCH="$SCRIPT_HOME/scripts/wp-config-patch.php"
if [[ ! -f "$PATCH" ]]; then
  echo "Missing $PATCH" >&2
  exit 1
fi
docker cp "$PATCH" ecom:/tmp/wp-config-patch.php
docker exec \
  -e SILLAGE_SHARED_SECRET="$SILLAGE_SHARED_SECRET" \
  -e SILLAGE_DASHBOARD_URL="$DASH_URL" \
  -e SILLAGE_DB="${SILLAGE_DB:-sillage}" \
  ecom php /tmp/wp-config-patch.php

mkdir -p "${SILLAGE_LOGS_DIR:-$HOME/sillage/sillage-core/logs}"
echo "BOOTSTRAP_DONE"
