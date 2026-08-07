#!/usr/bin/env bash
# One-script Sillage deploy onto a Ubuntu VPS with Docker + Caddy already installed.
#
# Usage (from repo root / laptop):
#   ./production-environment/scripts/deploy-vps.sh \
#       --host ovh \
#       --shop cosmetic.silverblade.xyz \
#       --dash sillage.silverblade.xyz \
#       [--dns] \
#       [--clone-from ovhe] \
#       [--ip 51.79.255.226]
#
# Legacy positional form still works:
#   ./production-environment/scripts/deploy-vps.sh ovhe cosmetic.example.com sillage.example.com
#
# Secrets:
#   - Dashboard login → .deploy/vps-dashboard-<host>.txt (gitignored)
#   - Vendor keys from production-environment/sillage-core/.env
#   - Optional Porkbun DNS → .deploy/porkbun.env
#
set -euo pipefail

HOST=""
SHOP_DOMAIN=""
DASH_DOMAIN=""
DO_DNS=0
CLONE_FROM=""
IP=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --shop) SHOP_DOMAIN="${2:?}"; shift 2 ;;
    --dash) DASH_DOMAIN="${2:?}"; shift 2 ;;
    --dns) DO_DNS=1; shift ;;
    --clone-from) CLONE_FROM="${2:?}"; shift 2 ;;
    --ip) IP="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *)
      if [[ -z "$HOST" ]]; then HOST="$1"
      elif [[ -z "$SHOP_DOMAIN" ]]; then SHOP_DOMAIN="$1"
      elif [[ -z "$DASH_DOMAIN" ]]; then DASH_DOMAIN="$1"
      else echo "Unexpected arg: $1" >&2; usage
      fi
      shift
      ;;
  esac
done

: "${HOST:?SSH host required}"
: "${SHOP_DOMAIN:?shop domain required}"
: "${DASH_DOMAIN:?dash domain required}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCAL_ENV="$ROOT/production-environment/sillage-core/.env"
CHRONO="$ROOT/.deploy/deploy-CHRONOLOGY.md"
SSH=(ssh -F "${HOME}/.ssh/config" -o BatchMode=yes)
SCP=(scp -F "${HOME}/.ssh/config" -o BatchMode=yes)
RSYNC=(rsync -az -e "ssh -F ${HOME}/.ssh/config -o BatchMode=yes")

if [[ ! -f "$LOCAL_ENV" ]]; then
  echo "Missing $LOCAL_ENV — copy .env.example and fill vendor credentials first." >&2
  exit 1
fi

mkdir -p "$ROOT/.deploy"
CREDS="$ROOT/.deploy/vps-dashboard-${HOST}.txt"
START_EPOCH=$(date +%s)
log_step() {
  local msg="$1"
  local now elapsed
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  elapsed=$(( $(date +%s) - START_EPOCH ))
  printf '| %s | %dm%02ds | %s |\n' "$now" $((elapsed/60)) $((elapsed%60)) "$msg" | tee -a "$CHRONO"
}

if [[ ! -f "$CHRONO" ]]; then
  cat > "$CHRONO" <<EOF
# Deploy chronology

| UTC | Elapsed | Step |
|---|---|---|
EOF
fi

log_step "START host=${HOST} shop=${SHOP_DOMAIN} dash=${DASH_DOMAIN} dns=${DO_DNS} clone_from=${CLONE_FROM:-none}"

if [[ -z "$IP" ]]; then
  IP=$("${SSH[@]}" "$HOST" 'curl -4 -sS --max-time 5 ifconfig.me || curl -4 -sS --max-time 5 icanhazip.com' | tr -d '[:space:]')
fi
: "${IP:?could not detect public IP}"
log_step "Public IP ${IP}"

if [[ "$DO_DNS" -eq 1 ]]; then
  bash "$ROOT/production-environment/scripts/porkbun-dns.sh" "$SHOP_DOMAIN" "$DASH_DOMAIN" "$IP"
  log_step "Porkbun A records set for shop+dash → ${IP}"
fi

echo "==> rsync code → $HOST"
"${SSH[@]}" "$HOST" 'mkdir -p ~/sillage-core ~/Sillage/.feedscratch ~/ecom_sites/config ~/ecom_sites/data/wp/wp-content/plugins ~/sillage-core/logs ~/redis'
"${RSYNC[@]}" --delete \
  --exclude node_modules --exclude .env --exclude logs --exclude dist --exclude web/node_modules \
  "$ROOT/production-environment/sillage-core/" "$HOST:~/sillage-core/"
"${RSYNC[@]}" --delete \
  "$ROOT/production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
  "$HOST:~/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/"
"${RSYNC[@]}" "$ROOT/production-environment/redis/compose.yaml" "$HOST:~/redis/compose.yaml"
if [[ -d "$ROOT/.feedscratch" ]]; then
  "${RSYNC[@]}" "$ROOT/.feedscratch/" "$HOST:~/Sillage/.feedscratch/"
fi
if [[ -f "$ROOT/production-environment/ecom_sites/config/php.ini" ]]; then
  "${SCP[@]}" "$ROOT/production-environment/ecom_sites/config/php.ini" "$HOST:~/ecom_sites/config/php.ini"
fi
"${SCP[@]}" "$ROOT/production-environment/ecom_sites/config/nginx-lps-media.conf" "$HOST:~/ecom_sites/config/nginx-lps-media.conf"
"${SCP[@]}" "$ROOT/production-environment/scripts/vps-bootstrap.sh" "$HOST:~/vps-bootstrap.sh"
"${SCP[@]}" "$ROOT/production-environment/ecom_sites/config/sillage-grants.sql" "$HOST:~/ecom_sites/config/sillage-grants.sql"
"${SSH[@]}" "$HOST" 'mkdir -p ~/wordpress-image'
"${RSYNC[@]}" "$ROOT/production-environment/wordpress-image/" "$HOST:~/wordpress-image/"
log_step "Code + plugin + redis compose uploaded"

echo "==> build lime/wordpress:latest on ${HOST} (wordpress:latest + phpredis)"
"${SSH[@]}" "$HOST" 'cd ~/wordpress-image && docker build -t lime/wordpress:latest .'
log_step "Built lime/wordpress:latest on host"

if [[ -n "$CLONE_FROM" ]]; then
  echo "==> clone WordPress+DB from ${CLONE_FROM} → ${HOST} (live, no downtime on source)"
  "${SSH[@]}" "$HOST" 'mkdir -p ~/ecom_sites/data/wp ~/ecom_sites/data/wp-db'
  # Stream remote→remote via local stdin (rsync cannot do hostA: → hostB:)
  "${SSH[@]}" "$CLONE_FROM" 'tar -C ~/ecom_sites/data/wp --exclude=wp-content/cache -cf - .' \
    | "${SSH[@]}" "$HOST" 'tar -C ~/ecom_sites/data/wp -xf -'
  "${SSH[@]}" "$CLONE_FROM" 'set -a; source ~/ecom_sites/.env; set +a; docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb-dump -uroot --single-transaction --routines --triggers --all-databases' \
    | "${SSH[@]}" "$HOST" 'cat > /tmp/sillage-clone.sql'
  "${SSH[@]}" "$CLONE_FROM" 'cat ~/ecom_sites/.env' | "${SSH[@]}" "$HOST" 'cat > ~/ecom_sites/.env && chmod 600 ~/ecom_sites/.env'
  # Re-apply current plugin over the cloned tree
  "${RSYNC[@]}" --delete \
    "$ROOT/production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
    "$HOST:~/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/"
  log_step "Cloned wp files + SQL dump from ${CLONE_FROM}"
fi

echo "==> generate remote .env + dashboard password"
# shellcheck disable=SC1090
set -a; source "$LOCAL_ENV"; set +a
SECRET=$(openssl rand -hex 32)
SESSION=$(openssl rand -hex 32)
PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
WP_ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
DBPASS=$(openssl rand -hex 16)
MYSQL_ROOT=$(openssl rand -hex 16)
MYSQL_PWD=$(openssl rand -hex 16)

REMOTE_HAS_ECOM_ENV=$("${SSH[@]}" "$HOST" 'test -f ~/ecom_sites/.env && echo yes || echo no')
if [[ "$REMOTE_HAS_ECOM_ENV" != "yes" ]]; then
  "${SSH[@]}" "$HOST" "cat > ~/ecom_sites/.env" <<EOF
MYSQL_ROOT_PWD=${MYSQL_ROOT}
MYSQL_DB=earth
MYSQL_USER=lime
MYSQL_PWD=${MYSQL_PWD}
COMPOSE_PROFILES=
EOF
  "${SSH[@]}" "$HOST" 'chmod 600 ~/ecom_sites/.env'
  log_step "Created fresh ecom_sites/.env"
fi

"${SSH[@]}" "$HOST" "cat > ~/sillage-core/.env" <<EOF
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
"${SSH[@]}" "$HOST" 'chmod 600 ~/sillage-core/.env'

cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=admin
password=${PASS}
shop=https://${SHOP_DOMAIN}
wp_admin_user=admin
wp_admin_password=${WP_ADMIN_PASS}
ip=${IP}
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 600 "$CREDS"
echo "Dashboard password saved to $CREDS"
log_step "Wrote dashboard creds to ${CREDS}"

echo "==> remote compose / caddy / bring-up"
"${SSH[@]}" "$HOST" "SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' SILLAGE_DASHBOARD_URL='https://${DASH_DOMAIN}' CLONE_MODE='${CLONE_FROM:+1}' WP_ADMIN_PASS='${WP_ADMIN_PASS}' bash -s" <<'REMOTE'
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

WP_PORT=104
MEDIA_PORT=105

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
  # Static images only. Host bind-mount ./data/media (not a named volume).
  lps-media:
    container_name: lps-media
    image: nginx:alpine
    networks: [ecom_network]
    ports: ["127.0.0.1:${MEDIA_PORT}:80"]
    restart: always
    volumes:
      - ./data/media:/usr/share/nginx/html:ro
      - ./config/nginx-lps-media.conf:/etc/nginx/conf.d/default.conf:ro
  ecom:
    container_name: ecom
    image: lime/wordpress:latest
    networks: [ecom_network, redis_network]
    ports: ["127.0.0.1:${WP_PORT}:80"]
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
      - /home/ubuntu/Sillage/.feedscratch:/app/.feedscratch
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

sudo mkdir -p /home/ubuntu/ecom_sites/data/media
# Remove legacy Apache alias mount if a prior deploy left the conf behind.
rm -f /home/ubuntu/ecom_sites/config/apache-lps-media.conf
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${SHOP_DOMAIN} {
	# Product images: host dir → lps-media container (not WordPress/Apache).
	handle_path /lps-media/* {
		reverse_proxy localhost:${MEDIA_PORT}
	}
	reverse_proxy localhost:${WP_PORT}
}
${DASH_DOMAIN} {
	reverse_proxy localhost:4000
}
EOF
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile || sudo systemctl reload caddy

docker network create ecom_network 2>/dev/null || true
docker network create redis_network 2>/dev/null || true

cd ~/redis
docker compose up -d

cd ~/ecom_sites
# php.ini optional
[[ -f config/php.ini ]] || touch config/php.ini

docker compose up -d ecom-db
echo "Waiting for MariaDB..."
# IMPORTANT: redirect stdin — this script is fed via `bash -s`; docker exec would otherwise
# consume the rest of the remote script and silently abort the deploy.
for i in $(seq 1 60); do
  if docker exec -i ecom-db healthcheck.sh --connect --innodb_initialized </dev/null 2>/dev/null; then
    break
  fi
  sleep 2
done
echo "MariaDB ready (or timed out), continuing..."

# Import cloned SQL before starting WordPress (fresh datadir may already have empty earth)
if [[ -f /tmp/sillage-clone.sql ]]; then
  echo "Importing cloned SQL..."
  set -a; source ~/ecom_sites/.env; set +a
  docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot < /tmp/sillage-clone.sql
  rm -f /tmp/sillage-clone.sql
fi

docker compose up -d lps-media ecom
echo "Waiting for WordPress files..."
for i in $(seq 1 90); do
  if [[ -f "$HOME/ecom_sites/data/wp/wp-config.php" ]]; then
    break
  fi
  sleep 2
done

if [[ ! -f "$HOME/ecom_sites/data/wp/wp-config.php" ]]; then
  echo "wp-config.php still missing after wait" >&2
  ls -la "$HOME/ecom_sites/data/wp" | head >&2 || true
  exit 1
fi

# Download free Woo/theme plugins if missing (from wordpress.org — not a live-site clone)
if [[ -z "${CLONE_MODE:-}" ]]; then
  echo "Fetching WooCommerce / redis-cache / Blocksy from wordpress.org..."
  sudo chown -R "$USER":"$USER" "$HOME/ecom_sites/data/wp/wp-content" || true
  mkdir -p "$HOME/ecom_sites/data/wp/wp-content/plugins" "$HOME/ecom_sites/data/wp/wp-content/themes"
  cd /tmp
  for item in \
    "plugin:woocommerce" \
    "plugin:redis-cache" \
    "theme:blocksy"
  do
    kind=${item%%:*}; slug=${item##*:}
    dest="$HOME/ecom_sites/data/wp/wp-content/${kind}s/${slug}"
    if [[ -d "$dest" ]]; then
      echo "  $slug already present"
      continue
    fi
    curl -fsSL -o "${slug}.zip" "https://downloads.wordpress.org/${kind}/${slug}.latest-stable.zip"
    unzip -qo "${slug}.zip" -d "$HOME/ecom_sites/data/wp/wp-content/${kind}s"
    rm -f "${slug}.zip"
    echo "  $slug installed"
  done
fi

# Fresh WordPress install (empty site — not a clone of production catalog)
if [[ -z "${CLONE_MODE:-}" ]]; then
  echo "Running fresh wp_install..."
  cat > /tmp/wp-fresh-install.php <<'PHP'
<?php
define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');
$_SERVER['HTTP_HOST'] = getenv('SHOP_DOMAIN') ?: 'localhost';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'];
$_SERVER['REQUEST_URI'] = '/';
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
$url = 'https://' . $_SERVER['HTTP_HOST'];
echo 'installed=' . (is_blog_installed() ? 'yes' : 'no') . PHP_EOL;
if (!is_blog_installed()) {
    $pass = getenv('WP_ADMIN_PASS') ?: wp_generate_password(20, false);
    $r = wp_install('Cosmetic', 'admin', 'admin@' . $_SERVER['HTTP_HOST'], true, '', $pass, 'en_US');
    echo 'wp_install_ok user=' . ($r['user_id'] ?? '?') . PHP_EOL;
}
update_option('siteurl', $url);
update_option('home', $url);
update_option('woocommerce_currency', 'EUR');
update_option('woocommerce_currency_pos', 'left');
update_option('woocommerce_price_num_decimals', '2');
require_once ABSPATH . 'wp-admin/includes/plugin.php';
foreach (['woocommerce/woocommerce.php', 'redis-cache/redis-cache.php', 'sillage-bridge/sillage-bridge.php'] as $p) {
    if (!file_exists(WP_PLUGIN_DIR . '/' . $p)) { echo "$p missing\n"; continue; }
    $res = activate_plugin($p);
    echo $p . (is_wp_error($res) ? (' FAIL ' . $res->get_error_message()) : ' ok') . PHP_EOL;
}
if (wp_get_theme('blocksy')->exists()) {
    switch_theme('blocksy');
    echo "theme=blocksy\n";
}
echo 'siteurl=' . get_option('siteurl') . PHP_EOL;
PHP
  docker cp /tmp/wp-fresh-install.php ecom:/tmp/wp-fresh-install.php
  docker exec -e SHOP_DOMAIN="$SHOP_DOMAIN" -e WP_ADMIN_PASS="$WP_ADMIN_PASS" ecom php /tmp/wp-fresh-install.php
fi

export SILLAGE_DASHBOARD_URL="https://${DASH_DOMAIN}"
# wp-config is owned by www-data; allow ubuntu to patch constants
sudo chown "$USER":"$USER" "$HOME/ecom_sites/data/wp/wp-config.php" || true
sudo chmod 664 "$HOME/ecom_sites/data/wp/wp-config.php" || true
bash ~/vps-bootstrap.sh

# URL rewrite when cloning another storefront
if [[ -n "${CLONE_MODE:-}" ]]; then
  docker exec ecom php -r "
    require '/var/www/html/wp-load.php';
    \$url = 'https://${SHOP_DOMAIN}';
    update_option('siteurl', \$url);
    update_option('home', \$url);
    echo \"urls=\$url\\n\";
  " || true
fi

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

set -a; source ~/ecom_sites/.env; source ~/sillage-core/.env; set +a
# Apply canonical grants before migrate (sil_ean_index grant comes after migrate).
sed "s|__SILLAGE_DB_PASSWORD__|${SILLAGE_DB_PASSWORD}|g" ~/ecom_sites/config/sillage-grants.sql \
  | docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot \
  -e "GRANT SELECT, INSERT, UPDATE ON earth.wp_wc_order_addresses TO 'sillage'@'%'; FLUSH PRIVILEGES;"

# Plugin download above cds to /tmp — compose.yaml lives in ecom_sites.
cd ~/ecom_sites
docker compose build sillage-core
docker compose up -d lps-media ecom sillage-core sillage-cron
docker exec sillage-core bun run migrate
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot \
  -e "GRANT SELECT ON sillage.sil_ean_index TO 'lime'@'%'; FLUSH PRIVILEGES;"
docker exec ecom php -r 'require "/var/www/html/wp-load.php"; require_once ABSPATH."wp-admin/includes/plugin.php"; activate_plugin("sillage-bridge/sillage-bridge.php"); echo "plugin ok\n";' || true

curl -sS http://127.0.0.1:4000/health || true
echo
echo "Deploy finished. Open https://${DASH_DOMAIN}"
REMOTE

log_step "Remote bring-up finished"
TOTAL=$(( $(date +%s) - START_EPOCH ))
log_step "DONE total=${TOTAL}s (~$((TOTAL/60))m$((TOTAL%60))s)"

echo
echo "==> done"
echo "Shop:      https://${SHOP_DOMAIN}"
echo "Dashboard: https://${DASH_DOMAIN}"
echo "Password:  $CREDS"
echo "Chronology:$CHRONO"
