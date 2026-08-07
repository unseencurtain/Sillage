#!/usr/bin/env bash
# One-script Sillage deploy onto a fresh (or existing) Ubuntu VPS with Docker + Caddy.
#
# Usage (from your laptop, in the repo):
#   ./production-environment/scripts/deploy-vps.sh ovhe cosmetic.slilverbelt.xyz sillage.slilverbelt.xyz
#
# Args:
#   $1  SSH host (ssh config alias or user@ip)
#   $2  Storefront domain (WordPress / WooCommerce)
#   $3  Dashboard domain (sillage-core UI)
#
# Passwords / secrets:
#   - Dashboard login is written to .deploy/vps-dashboard.txt on THIS machine (gitignored).
#   - Vendor API keys are copied from production-environment/sillage-core/.env (must already exist).
#   - WooCommerce DB password stays whatever is already in remote ecom_sites/.env
#
set -euo pipefail

HOST="${1:?SSH host required, e.g. ovhe}"
SHOP_DOMAIN="${2:?Storefront domain required}"
DASH_DOMAIN="${3:?Dashboard domain required}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOCAL_ENV="$ROOT/production-environment/sillage-core/.env"

if [[ ! -f "$LOCAL_ENV" ]]; then
  echo "Missing $LOCAL_ENV — copy .env.example and fill vendor credentials first." >&2
  exit 1
fi

mkdir -p "$ROOT/.deploy"
CREDS="$ROOT/.deploy/vps-dashboard.txt"

echo "==> rsync code → $HOST"
ssh "$HOST" 'mkdir -p ~/sillage-core ~/Sillage/.feedscratch ~/ecom_sites/config ~/ecom_sites/data/wp/wp-content/plugins ~/sillage-core/logs'
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude logs --exclude dist --exclude web/node_modules \
  "$ROOT/production-environment/sillage-core/" "$HOST:~/sillage-core/"
rsync -az --delete \
  "$ROOT/production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
  "$HOST:~/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/"
if [[ -d "$ROOT/.feedscratch" ]]; then
  rsync -az "$ROOT/.feedscratch/" "$HOST:~/Sillage/.feedscratch/"
fi

echo "==> generate remote .env + dashboard password"
# shellcheck disable=SC1090
set -a; source "$LOCAL_ENV"; set +a
SECRET=$(openssl rand -hex 32)
SESSION=$(openssl rand -hex 32)
PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
DBPASS=$(openssl rand -hex 16)

ssh "$HOST" "cat > ~/sillage-core/.env" <<EOF
NODE_ENV=production
PORT=4000
LOG_LEVEL=info
DB_HOST=ecom-db
DB_PORT=3306
DB_USER=sillage
SILLAGE_DB_PASSWORD=${DBPASS}
SILLAGE_DB=sillage
WORDPRESS_DB=earth
WP_TABLE_PREFIX=wp_
DB_CONNECTION_LIMIT=10
WP_BASE_URL=https://${SHOP_DOMAIN}
SILLAGE_SHARED_SECRET=${SECRET}
BEAUTYFORT_USER=${BEAUTYFORT_USER}
BEAUTYFORT_SECRET=${BEAUTYFORT_SECRET}
BEAUTYFORT_ENDPOINT=${BEAUTYFORT_ENDPOINT:-https://www.beautyfort.com/api/soap/v4}
BEAUTYFORT_TEST_MODE=false
BTS_JWT_TOKEN=${BTS_JWT_TOKEN}
BTS_BASE_URL=${BTS_BASE_URL:-https://api.btswholesaler.com/v1/api}
BTS_LANGUAGE=en-US
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=${PASS}
SESSION_SECRET=${SESSION}
FIXTURES_DIR=/app/.feedscratch
REDIS_URL=redis://valkey:6379
EOF
ssh "$HOST" 'chmod 600 ~/sillage-core/.env'

cat > "$CREDS" <<EOF
url=https://${DASH_DOMAIN}
user=admin
password=${PASS}
shop=https://${SHOP_DOMAIN}
EOF
chmod 600 "$CREDS"
echo "Dashboard password saved to $CREDS"

echo "==> upload compose / caddy / bootstrap"
scp "$ROOT/production-environment/scripts/vps-bootstrap.sh" "$HOST:~/vps-bootstrap.sh"
scp "$ROOT/production-environment/ecom_sites/config/php.ini" "$HOST:~/ecom_sites/config/php.ini" 2>/dev/null || true

ssh "$HOST" "SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' bash -s" <<'REMOTE'
set -euo pipefail
cat > ~/ecom_sites/config/mariadb.cnf <<'CNF'
[mariadbd]
innodb_buffer_pool_size         = 1G
innodb_log_file_size            = 256M
innodb_log_buffer_size          = 64M
max_allowed_packet              = 64M
innodb_flush_log_at_trx_commit  = 2
innodb_flush_method             = O_DIRECT
max_connections                 = 100
character-set-server            = utf8mb4
collation-server                = utf8mb4_unicode_ci
CNF

# Keep existing WP port mapping if present (104), else 80.
WP_PORT=104
grep -q '104:80' ~/ecom_sites/compose.yaml 2>/dev/null || WP_PORT=80

cat > ~/ecom_sites/compose.yaml <<EOF
name: wordpress-ecom
services:
  ecom-db:
    container_name: ecom-db
    image: mariadb:latest
    networks: [ecom_network]
    restart: always
    ports: ["127.0.0.1:3307:3306"]
    volumes:
      - ./data/wp-db:/var/lib/mysql
      - ./config/mariadb.cnf:/etc/mysql/conf.d/sillage.cnf:ro
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PWD}
      MYSQL_DATABASE: \${MYSQL_DB}
      MYSQL_USER: \${MYSQL_USER}
      MYSQL_PASSWORD: \${MYSQL_PWD}
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 5
  ecom:
    container_name: ecom
    image: lime/wordpress:latest
    networks: [ecom_network, redis_network]
    ports: ["${WP_PORT}:80"]
    restart: always
    depends_on:
      ecom-db:
        condition: service_healthy
    volumes:
      - ./data/wp:/var/www/html
      - ./config/php.ini:/usr/local/etc/php/conf.d/conf.ini:ro
    environment:
      WORDPRESS_DB_HOST: ecom-db
      WORDPRESS_DB_USER: \${MYSQL_USER}
      WORDPRESS_DB_PASSWORD: \${MYSQL_PWD}
      WORDPRESS_DB_NAME: \${MYSQL_DB}
  x-sillage-common: &sillage-common
    build:
      context: /home/ubuntu/sillage-core
    image: sillage-core:latest
    networks: [ecom_network, redis_network]
    restart: unless-stopped
    depends_on:
      ecom-db:
        condition: service_healthy
    env_file: [/home/ubuntu/sillage-core/.env]
    environment:
      DB_HOST: ecom-db
      DB_PORT: "3306"
      REDIS_URL: redis://valkey:6379
      WP_BASE_URL: https://${SHOP_DOMAIN}
      FIXTURES_DIR: /app/.feedscratch
    volumes:
      - /home/ubuntu/sillage-core/logs:/app/logs
      - /home/ubuntu/Sillage/.feedscratch:/app/.feedscratch:ro
  sillage-core:
    <<: *sillage-common
    container_name: sillage-core
    hostname: sillage-core
    command: ["bun", "run", "src/server/index.ts"]
    ports: ["127.0.0.1:4000:4000"]
  sillage-cron:
    <<: *sillage-common
    container_name: sillage-cron
    hostname: sillage-cron
    command: ["/usr/local/bin/supercronic", "-passthrough-logs", "/app/crontab"]
networks:
  ecom_network:
    name: ecom_network
    external: true
  redis_network:
    name: redis_network
    external: true
EOF

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${SHOP_DOMAIN} {
	reverse_proxy localhost:${WP_PORT}
}
${DASH_DOMAIN} {
	reverse_proxy localhost:4000
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

docker network create ecom_network 2>/dev/null || true
docker network create redis_network 2>/dev/null || true

bash ~/vps-bootstrap.sh

# Patch DISABLE_WP_CRON + currency
docker exec ecom php -r 'require "/var/www/html/wp-load.php"; update_option("woocommerce_currency","EUR");' || true
WP=~/ecom_sites/data/wp/wp-config.php
grep -q DISABLE_WP_CRON "$WP" || python3 - <<'PY'
from pathlib import Path
p = Path.home()/"ecom_sites/data/wp/wp-config.php"
t = p.read_text()
b = "\ndefine( 'DISABLE_WP_CRON', true );\n"
m = "/* That's all, stop editing!"
p.write_text(t.replace(m, b+m) if m in t else t+b)
PY

cd ~/ecom_sites
docker compose up -d ecom-db
docker compose build sillage-core
docker compose up -d sillage-core sillage-cron ecom
docker exec sillage-core bun run migrate
docker exec ecom php -r 'require "/var/www/html/wp-load.php"; activate_plugin("sillage-bridge/sillage-bridge.php"); echo "plugin ok\n";'
# Grants for earth tables (needs -i)
set -a; source ~/ecom_sites/.env; source ~/sillage-core/.env; set +a
docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_posts TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_postmeta TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_terms TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_termmeta TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_term_taxonomy TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_term_relationships TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_wc_product_meta_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_wc_product_attributes_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON earth.wp_wc_category_lookup TO 'sillage'@'%';
GRANT SELECT ON earth.wp_options TO 'sillage'@'%';
GRANT SELECT ON earth.wp_wc_orders TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE ON earth.wp_wc_order_addresses TO 'sillage'@'%';
GRANT SELECT ON earth.wp_wc_order_operational_data TO 'sillage'@'%';
GRANT SELECT ON earth.wp_woocommerce_order_items TO 'sillage'@'%';
GRANT SELECT ON earth.wp_woocommerce_order_itemmeta TO 'sillage'@'%';
GRANT SELECT ON earth.wp_woocommerce_attribute_taxonomies TO 'sillage'@'%';
GRANT SELECT ON sillage.sil_ean_index TO 'lime'@'%';
FLUSH PRIVILEGES;
SQL
curl -sS http://127.0.0.1:4000/health || true
echo
echo "Deploy finished. Open https://${DASH_DOMAIN} — password is on the laptop in .deploy/vps-dashboard.txt"
REMOTE

echo "==> done"
echo "Dashboard: https://${DASH_DOMAIN}"
echo "Password file: $CREDS"
