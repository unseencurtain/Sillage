#!/usr/bin/env bash
# Run on the VPS as ubuntu. Creates sillage DB user, patches wp-config, restarts stack.
set -euo pipefail

set -a
# shellcheck disable=SC1090
source "$HOME/ecom_sites/.env"
# shellcheck disable=SC1090
source "$HOME/sillage-core/.env"
set +a

WP_DB="${WORDPRESS_DB:-earth}"

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

WPCONFIG="$HOME/ecom_sites/data/wp/wp-config.php"
if grep -q "SILLAGE_SHARED_SECRET" "$WPCONFIG"; then
  echo "WP_CONFIG_ALREADY"
else
  python3 - "$WPCONFIG" "$SILLAGE_SHARED_SECRET" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
secret = sys.argv[2]
text = path.read_text()
block = f"""
/* Sillage bridge */
define( 'SILLAGE_SHARED_SECRET', '{secret}' );
define( 'SILLAGE_CORE_URL', 'http://sillage-core:4000' );
define( 'SILLAGE_DASHBOARD_URL', 'https://sillage.slilverbelt.xyz' );
define( 'SILLAGE_DB', 'sillage' );

"""
marker = "/* That's all, stop editing!"
if marker in text:
    text = text.replace(marker, block + marker)
else:
    text += "\n" + block
path.write_text(text)
print("WP_CONFIG_PATCHED")
PY
fi

mkdir -p "$HOME/sillage-core/logs"
echo "BOOTSTRAP_DONE"
