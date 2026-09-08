#!/usr/bin/env bash
# Deploy / update Sillage on a Ubuntu VPS from one compose + one .env.
#
# Usage (from repo root):
#   ./production-environment/scripts/deploy-vps.sh --host ovhe
#   # Domains optional — defaults from production-environment/.env, else live-shop defaults:
#   #   shop=prinscosmetic.eu dash=sillage.prinscosmetic.eu images=images.prinscosmetic.eu
#   ./production-environment/scripts/deploy-vps.sh \
#       --host ovhe \
#       [--shop …] [--dash …] [--images …] \
#       [--dash-user europa] [--wp-user cherry] \
#       [--media-from ovhe] [--skip-dns-check] \
#       --finish   # after the operator has activated plugins and customised
#       [--dns] [--ip 139.99.61.71] \
#       [--skip-build] [--fresh] [--core-only] [--keep-caddy] [--replace-caddy]
#
# Flow (empty Ubuntu VPS — this is the default path):
#   0) Once, as root: bootstrap-host.sh (Docker, Caddy, ubuntu, unzip)
#   1) Hub images: rsync source onto the VPS and build+push THERE
#      (docker login lives on the host). Never docker build on the laptop/agent.
#      Default builds **core + WordPress** (Dockerfile pins WP 7.1 / PHP 8.3).
#      Pass --core-only only for a day-2 engine bump on an already-running shop.
#   2) rsync compose/config/plugin/overrides only
#   3) remote: docker compose pull && up -d && migrate + first-boot WordPress
#      (WooCommerce, HPOS, permalinks, Coming soon off, Blocksy).
#      Caddy is written for this shop. If the VPS already serves other hostnames,
#      the existing Caddyfile is left alone unless you pass --replace-caddy.
#
# Operator names: --dash-user / --wp-user pick the dashboard and WordPress logins.
# Omit them and a random non-admin pair is generated. "admin" is refused either way.
#
# Preflight: every hostname must already resolve to this VPS, or the deploy stops before
# building anything. --media-from copies the scraped product photos off an existing box.
#
# Secrets live in remote ~/sillage/.env (created once; preserved on update).
set -euo pipefail

HOST=""
SHOP_DOMAIN=""
DASH_DOMAIN=""
IMAGES_DOMAIN=""
DO_DNS=0
IP=""
SKIP_BUILD=0
FRESH=0
CLONE_FROM=""
WITH_WORDPRESS=1
KEEP_CADDY=""
DASH_USER=""
WP_USER=""
WP_ADMIN_USER=""
SKIP_DNS_CHECK=0
MEDIA_FROM=""
FINISH=0

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# Operator logins are chosen or generated, never "admin".
check_operator() {
  local flag="$1" name="$2"
  if [[ "${name,,}" == *admin* ]]; then
    echo "$flag must not contain \"admin\": $name" >&2
    exit 1
  fi
  if [[ ! "$name" =~ ^[a-z0-9][a-z0-9._-]{1,31}$ ]]; then
    echo "$flag must be 2-32 chars of a-z 0-9 . _ -: $name" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --shop) SHOP_DOMAIN="${2:?}"; shift 2 ;;
    --dash) DASH_DOMAIN="${2:?}"; shift 2 ;;
    --images) IMAGES_DOMAIN="${2:?}"; shift 2 ;;
    --dash-user) DASH_USER="${2:?}"; check_operator --dash-user "$DASH_USER"; shift 2 ;;
    --wp-user) WP_USER="${2:?}"; check_operator --wp-user "$WP_USER"; shift 2 ;;
    --dns) DO_DNS=1; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
    --finish) FINISH=1; shift ;;
    --media-from) MEDIA_FROM="${2:?}"; shift 2 ;;
    --ip) IP="${2:?}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --core-only) WITH_WORDPRESS=0; shift ;;
    --with-wordpress) WITH_WORDPRESS=1; shift ;;
    --keep-caddy) KEEP_CADDY=1; shift ;;
    --replace-caddy) KEEP_CADDY=0; shift ;;
    --clone-from) CLONE_FROM="${2:?}"; shift 2 ;;
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

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PE="$ROOT/production-environment"
# Prefer unified .env; fall back to legacy sillage-core/.env for vendor keys.
LOCAL_ENV_CANDIDATES=("$PE/.env" "$PE/sillage-core/.env")
LOCAL_ENV=""
for f in "${LOCAL_ENV_CANDIDATES[@]}"; do
  if [[ -f "$f" ]]; then LOCAL_ENV="$f"; break; fi
done
if [[ -z "$LOCAL_ENV" ]]; then
  echo "Missing $PE/.env (or sillage-core/.env) — copy .env.example and fill passwords." >&2
  exit 1
fi

SSH=(ssh -F "${HOME}/.ssh/config" -o BatchMode=yes)
SCP=(scp -F "${HOME}/.ssh/config" -o BatchMode=yes)
RSYNC=(rsync -az -e "ssh -F ${HOME}/.ssh/config -o BatchMode=yes")
REMOTE_DIR=sillage

# Fail on the tool, not on a bare "command not found" 200 lines in.
for _tool in ssh rsync; do
  command -v "$_tool" >/dev/null || {
    echo "$_tool is not installed — this script copies the stack to the VPS with it" >&2
    exit 1
  }
done
CHRONO="$ROOT/.deploy/deploy-CHRONOLOGY.md"
mkdir -p "$ROOT/.deploy"
CREDS="$ROOT/.deploy/vps-dashboard-${HOST}.txt"
START_EPOCH=$(date +%s)

# Staging defaults when CLI + local .env omit domains (ovhe).
DEFAULT_SHOP_DOMAIN=prinscosmetic.eu
DEFAULT_DASH_DOMAIN=sillage.prinscosmetic.eu
DEFAULT_IMAGES_DOMAIN=images.prinscosmetic.eu

log_step() {
  local msg="$1" now elapsed
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  elapsed=$(( $(date +%s) - START_EPOCH ))
  if [[ ! -f "$CHRONO" ]]; then
    printf '# Deploy chronology\n\n| UTC | Elapsed | Step |\n|---|---|---|\n' > "$CHRONO"
  fi
  printf '| %s | %dm%02ds | %s |\n' "$now" $((elapsed/60)) $((elapsed%60)) "$msg" | tee -a "$CHRONO"
}

# Domain precedence: CLI flags > remote ~/sillage/.env > local .env (non-localhost) > live-shop defaults.
CLI_SHOP="$SHOP_DOMAIN"
CLI_DASH="$DASH_DOMAIN"
CLI_IMAGES="$IMAGES_DOMAIN"
CLI_IP="$IP"

# shellcheck disable=SC1090
set -a; source "$LOCAL_ENV"; set +a
LOCAL_SHOP="${SHOP_DOMAIN:-}"
LOCAL_DASH="${DASH_DOMAIN:-}"
LOCAL_IMAGES="${IMAGES_DOMAIN:-}"
[[ -n "$CLI_IP" ]] && IP="$CLI_IP"

is_placeholder_domain() {
  case "${1:-}" in
    ""|localhost|*.localhost|shop.example.com|ops.example.com|images.example.com) return 0 ;;
    *) return 1 ;;
  esac
}

REMOTE_DOMAINS=$("${SSH[@]}" "$HOST" 'test -f ~/sillage/.env && set -a && source ~/sillage/.env && set +a && printf "%s\t%s\t%s" "${SHOP_DOMAIN:-}" "${DASH_DOMAIN:-}" "${IMAGES_DOMAIN:-}"' 2>/dev/null || true)
_R_SHOP=""; _R_DASH=""; _R_IMAGES=""
if [[ -n "$REMOTE_DOMAINS" ]]; then
  IFS=$'\t' read -r _R_SHOP _R_DASH _R_IMAGES <<<"$REMOTE_DOMAINS"
fi

pick_domain() {
  local cli="$1" remote="$2" localv="$3" fallback="$4"
  if [[ -n "$cli" ]]; then echo "$cli"; return; fi
  if [[ "$FRESH" -eq 0 ]] && ! is_placeholder_domain "$remote"; then echo "$remote"; return; fi
  if ! is_placeholder_domain "$localv"; then echo "$localv"; return; fi
  echo "$fallback"
}

SHOP_DOMAIN="$(pick_domain "$CLI_SHOP" "$_R_SHOP" "$LOCAL_SHOP" "$DEFAULT_SHOP_DOMAIN")"
DASH_DOMAIN="$(pick_domain "$CLI_DASH" "$_R_DASH" "$LOCAL_DASH" "$DEFAULT_DASH_DOMAIN")"
IMAGES_DOMAIN="$(pick_domain "$CLI_IMAGES" "$_R_IMAGES" "$LOCAL_IMAGES" "$DEFAULT_IMAGES_DOMAIN")"

if [[ "$FINISH" -eq 1 ]]; then
  # Stage after the operator activates plugins and customises the shop: verify and repair the
  # settings the engine and orders depend on, then report. Activation is never changed here.
  echo "==> readiness check on ${HOST} (${SHOP_DOMAIN})"
  "${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/scripts"
  "${RSYNC[@]}" "$PE/scripts/wp-readiness.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-readiness.php"
  "${RSYNC[@]}" "$PE/scripts/apply-grants.sh" "$HOST:~/${REMOTE_DIR}/scripts/apply-grants.sh"
  "${SSH[@]}" "$HOST" "cd ~/${REMOTE_DIR} && bash scripts/apply-grants.sh --strict" || exit $?
  echo
  "${SSH[@]}" "$HOST" "docker cp ~/${REMOTE_DIR}/scripts/wp-readiness.php ecom:/tmp/wp-readiness.php >/dev/null && docker exec -e SHOP_DOMAIN='${SHOP_DOMAIN}' -e WP_READINESS_FIX=1 ecom php /tmp/wp-readiness.php"
  exit $?
fi

log_step "START host=${HOST} shop=${SHOP_DOMAIN} dash=${DASH_DOMAIN} images=${IMAGES_DOMAIN:-none} skip_build=${SKIP_BUILD} wordpress=${WITH_WORDPRESS} keep_caddy=${KEEP_CADDY:-auto}"

if [[ -z "$IP" ]]; then
  IP=$("${SSH[@]}" "$HOST" 'curl -4 -sS --max-time 5 ifconfig.me || curl -4 -sS --max-time 5 icanhazip.com' | tr -d '[:space:]')
fi
: "${IP:?could not detect public IP}"
log_step "Public IP ${IP}"

if [[ "$DO_DNS" -eq 1 ]]; then
  if [[ -n "$IMAGES_DOMAIN" ]]; then
    bash "$PE/scripts/porkbun-dns.sh" "$SHOP_DOMAIN" "$DASH_DOMAIN" "$IP" "$IMAGES_DOMAIN"
  else
    bash "$PE/scripts/porkbun-dns.sh" "$SHOP_DOMAIN" "$DASH_DOMAIN" "$IP"
  fi
  log_step "DNS A records updated"
fi

# Check the names before spending twenty minutes on a stack that cannot get a certificate.
# Every DNS panel's host field appends the zone, so a pasted FQDN silently becomes
# shop.example.com.example.com: the doubled name resolves, the real one NXDOMAINs, and the
# only symptom is a browser connection failure once Let's Encrypt refuses to issue.
dns_of() {
  local name="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short +time=3 +tries=2 "$name" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1
  else
    getent ahostsv4 "$name" 2>/dev/null | awk '{print $1; exit}'
  fi
}

if [[ "$SKIP_DNS_CHECK" -eq 0 ]]; then
  dns_bad=()
  for name in "$SHOP_DOMAIN" "$DASH_DOMAIN" ${IMAGES_DOMAIN:+"$IMAGES_DOMAIN"}; do
    got="$(dns_of "$name")"
    if [[ "$got" != "$IP" ]]; then
      dns_bad+=("$name|${got:-NXDOMAIN}")
    fi
  done
  if [[ "${#dns_bad[@]}" -gt 0 ]]; then
    echo >&2
    echo "DNS is not ready for ${HOST} (${IP}):" >&2
    for entry in "${dns_bad[@]}"; do
      printf '  %-40s resolves to %s\n' "${entry%%|*}" "${entry##*|}" >&2
    done
    echo >&2
    echo "Add an A record per name. Enter the LABEL only — the panel appends the zone," >&2
    echo "so pasting the full name creates sub.domain.tld.domain.tld:" >&2
    zone="${SHOP_DOMAIN#*.}"
    [[ "$SHOP_DOMAIN" != *.*.* ]] && zone="$SHOP_DOMAIN"
    for entry in "${dns_bad[@]}"; do
      name="${entry%%|*}"
      label="${name%".$zone"}"
      [[ "$label" == "$name" ]] && label="@"
      printf '  HOST %-22s TYPE A   VALUE %s\n' "$label" "$IP" >&2
    done
    echo >&2
    echo "Then re-run. Pass --skip-dns-check to deploy anyway (HTTPS will not work)." >&2
    exit 1
  fi
  log_step "DNS verified for shop/dash/images → ${IP}"
fi

TAG="$(git -C "$ROOT" rev-parse --short HEAD)"
NAMESPACE="${DOCKERHUB_NAMESPACE:-}"
if [[ -z "$NAMESPACE" ]]; then
  NAMESPACE="$(docker info 2>/dev/null | sed -n 's/^ Username: //p' | head -1 || true)"
fi
NAMESPACE="${NAMESPACE:-unseencurtain}"
CORE_IMAGE="${NAMESPACE}/sillage-core:${TAG}"
WP_IMAGE="${NAMESPACE}/sillage-wordpress:${TAG}"
if [[ "$WITH_WORDPRESS" -eq 0 ]]; then
  WP_IMAGE="${NAMESPACE}/sillage-wordpress:latest"
fi

if [[ "$SKIP_BUILD" -eq 0 && "$WITH_WORDPRESS" -eq 0 ]]; then
  echo "NOTE: --core-only skips the WordPress image. Empty VPS first boot must omit --core-only."
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Hub build on ${HOST} (docker login lives there; this machine does not docker build)"
  "${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/sillage-core ~/${REMOTE_DIR}/scripts ~/${REMOTE_DIR}/wordpress-image"
  "${RSYNC[@]}" --delete \
    --exclude data --exclude logs --exclude node_modules --exclude web/dist \
    --exclude .feedscratch \
    "$PE/sillage-core/" "$HOST:~/${REMOTE_DIR}/sillage-core/"
  "${RSYNC[@]}" "$PE/scripts/build-push-images.sh" "$HOST:~/${REMOTE_DIR}/scripts/build-push-images.sh"
  BUILD_FLAGS=(--namespace "$NAMESPACE" --tag "$TAG")
  if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
    "${RSYNC[@]}" --delete "$PE/wordpress-image/" "$HOST:~/${REMOTE_DIR}/wordpress-image/"
    BUILD_FLAGS+=(--with-wordpress)
    log_step "Building core + WordPress ${CORE_IMAGE} ${WP_IMAGE}"
  else
    BUILD_FLAGS+=(--core-only)
    log_step "Building core-only ${CORE_IMAGE}"
  fi
  "${SSH[@]}" "$HOST" "bash ~/${REMOTE_DIR}/scripts/build-push-images.sh ${BUILD_FLAGS[*]}"
  log_step "Pushed Hub images from ${HOST}"
else
  log_step "Skipped image build; using ${CORE_IMAGE} ${WP_IMAGE}"
fi

# A Hub tag says nothing about the WordPress it carries: an old build can sit under a tag
# whose live datadir was upgraded in place afterwards, so the running shop reads newer than
# the image. Deploying it onto an empty VPS installs the old WordPress. Compare the bundled
# version against the Dockerfile pin before anything writes a datadir.
if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
  PIN_WP="$(sed -n 's/^FROM wordpress:\([0-9][0-9.]*\)-php.*/\1/p' "$PE/wordpress-image/Dockerfile" | head -1)"
  if [[ -z "$PIN_WP" ]]; then
    echo "Could not read the WordPress pin from wordpress-image/Dockerfile" >&2
    exit 1
  fi
  IMAGE_WP="$("${SSH[@]}" "$HOST" "docker pull -q '$WP_IMAGE' >/dev/null 2>&1 && docker run --rm --entrypoint php '$WP_IMAGE' -r 'include \"/usr/src/wordpress/wp-includes/version.php\"; echo \$wp_version;'" 2>/dev/null || true)"
  if [[ -z "$IMAGE_WP" ]]; then
    echo "Could not read WordPress version from ${WP_IMAGE} (missing on Hub?)" >&2
    exit 1
  fi
  if [[ "$IMAGE_WP" != "$PIN_WP" ]]; then
    echo "${WP_IMAGE} bundles WordPress ${IMAGE_WP}, Dockerfile pins ${PIN_WP}." >&2
    echo "Rebuild that tag (drop --skip-build) instead of shipping a stale image." >&2
    exit 1
  fi
  log_step "WordPress image carries ${IMAGE_WP} (matches pin)"
fi

echo "==> rsync compose/config/plugin → ${HOST}:~/${REMOTE_DIR}"
REMOTE_DATA=$("${SSH[@]}" "$HOST" 'test -f ~/sillage/.env && set -a && source ~/sillage/.env && set +a && printf %s "${DATA_DIR:-}"' 2>/dev/null || true)
if [[ -z "$REMOTE_DATA" ]]; then
  REMOTE_DATA="/home/ubuntu/${REMOTE_DIR}/data"
fi
"${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/ecom_sites/config ~/${REMOTE_DIR}/sillage-core/data ~/${REMOTE_DIR}/sillage-core/logs ~/${REMOTE_DIR}/.feedscratch ~/${REMOTE_DIR}/scripts ~/${REMOTE_DIR}/wp-staging ${REMOTE_DATA}/media ${REMOTE_DATA}/sitemaps"

"${RSYNC[@]}" "$PE/compose.yaml" "$HOST:~/${REMOTE_DIR}/compose.yaml"
"${RSYNC[@]}" "$PE/.env.example" "$HOST:~/${REMOTE_DIR}/.env.example"
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/config/" "$HOST:~/${REMOTE_DIR}/ecom_sites/config/"
"${RSYNC[@]}" "$PE/scripts/vps-bootstrap.sh" "$HOST:~/${REMOTE_DIR}/scripts/vps-bootstrap.sh"
"${RSYNC[@]}" "$PE/scripts/build-push-images.sh" "$HOST:~/${REMOTE_DIR}/scripts/build-push-images.sh"
"${RSYNC[@]}" "$PE/scripts/fix-wp-content-perms.sh" "$HOST:~/${REMOTE_DIR}/scripts/fix-wp-content-perms.sh"
"${RSYNC[@]}" "$PE/scripts/wp-fresh-install.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-fresh-install.php"
"${RSYNC[@]}" "$PE/scripts/wp-config-patch.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-config-patch.php"
"${RSYNC[@]}" "$PE/scripts/wp-readiness.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-readiness.php"
"${RSYNC[@]}" "$PE/scripts/apply-grants.sh" "$HOST:~/${REMOTE_DIR}/scripts/apply-grants.sh"
if [[ -f "$PE/sillage-core/data/image_overrides.json" ]]; then
  "${RSYNC[@]}" "$PE/sillage-core/data/image_overrides.json" \
    "$HOST:~/${REMOTE_DIR}/sillage-core/data/image_overrides.json"
fi
# WordPress lives in a Docker volume, so the plugin is staged on the host and copied into
# the container during bring-up rather than written straight into a host wp-content.
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
  "$HOST:~/${REMOTE_DIR}/wp-staging/sillage-bridge/"
# Keep a zero-byte php.ini if missing so the bind mount succeeds.
"${SSH[@]}" "$HOST" "touch ~/${REMOTE_DIR}/ecom_sites/config/php.ini; mkdir -p ${REMOTE_DATA}/media ${REMOTE_DATA}/sitemaps; touch ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env; chmod 600 ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env"
log_step "Minimal rsync done"

# Product photos are scraped, not vendor-supplied, so a rebuilt VPS has to inherit them from
# a box that already holds them. Streamed host-to-host through this machine because the two
# VPSes have no SSH trust between them.
if [[ -n "$MEDIA_FROM" ]]; then
  echo "==> copy product photos ${MEDIA_FROM} → ${HOST}"
  SRC_MEDIA=$("${SSH[@]}" "$MEDIA_FROM" 'for d in ~/ecom_sites/data/media ~/sillage/data/media ~/ecom_sites/data/lps-media; do [ -d "$d" ] && { printf %s "$d"; break; }; done')
  if [[ -z "$SRC_MEDIA" ]]; then
    echo "No media directory found on ${MEDIA_FROM}" >&2
    exit 1
  fi
  SRC_COUNT=$("${SSH[@]}" "$MEDIA_FROM" "sudo find '$SRC_MEDIA' -type f -name '*.jpg' | wc -l")
  echo "    ${SRC_MEDIA} on ${MEDIA_FROM} holds ${SRC_COUNT} JPEGs"
  "${SSH[@]}" "$MEDIA_FROM" "sudo tar -C '$SRC_MEDIA' -cf - ." \
    | "${SSH[@]}" "$HOST" "sudo tar -C '${REMOTE_DATA}/media' -xf - && sudo chown -R \$(id -u):\$(id -g) '${REMOTE_DATA}/media'"
  DST_COUNT=$("${SSH[@]}" "$HOST" "sudo find '${REMOTE_DATA}/media' -type f -name '*.jpg' | wc -l")
  echo "    ${HOST} now holds ${DST_COUNT} JPEGs"
  if [[ "$DST_COUNT" -lt "$SRC_COUNT" ]]; then
    echo "Photo copy came up short: ${DST_COUNT} of ${SRC_COUNT}" >&2
    exit 1
  fi
  log_step "Photos copied from ${MEDIA_FROM} (${DST_COUNT} JPEGs)"
fi

if [[ -n "$CLONE_FROM" ]]; then
  echo "--clone-from is no longer supported: WordPress and MariaDB live in Docker volumes," >&2
  echo "and cloning a live shop's datadir is what let core drift from its image." >&2
  echo "Deploy a fresh install and let the operator set the theme up." >&2
  exit 1
fi

echo "==> ensure remote .env"
REMOTE_HAS_ENV=$("${SSH[@]}" "$HOST" "test -f ~/${REMOTE_DIR}/.env && echo yes || echo no")
if [[ "$REMOTE_HAS_ENV" != "yes" || "$FRESH" -eq 1 ]]; then
  SECRET=$(openssl rand -hex 32)
  SESSION=$(openssl rand -hex 32)
  PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  WP_ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  DBPASS=$(openssl rand -hex 16)
  MYSQL_ROOT=$(openssl rand -hex 16)
  MYSQL_PWD_GEN=$(openssl rand -hex 16)
  new_operator() {
    local prefix="$1" id name
    while true; do
      id="$(openssl rand -hex 3)"
      name="${prefix}-${id}"
      [[ "${name,,}" != *admin* ]] && { printf '%s' "$name"; return; }
    done
  }
  DASH_USER="${DASH_USER:-$(new_operator desk)}"
  WP_USER="${WP_USER:-$(new_operator shop)}"

  # Prefer existing DB passwords when updating an older split-env host.
  LEGACY_ECOM=$("${SSH[@]}" "$HOST" 'test -f ~/ecom_sites/.env && echo yes || echo no')
  if [[ "$LEGACY_ECOM" == "yes" && "$FRESH" -eq 0 ]]; then
    # shellcheck disable=SC2029
    eval "$("${SSH[@]}" "$HOST" 'set -a; source ~/ecom_sites/.env; set +a; printf "MYSQL_ROOT=%q\nMYSQL_PWD_GEN=%q\n" "$MYSQL_ROOT_PWD" "$MYSQL_PWD"')"
  fi
  LEGACY_CORE=$("${SSH[@]}" "$HOST" 'test -f ~/sillage-core/.env && echo yes || echo no')
  if [[ "$LEGACY_CORE" == "yes" && "$FRESH" -eq 0 ]]; then
    # shellcheck disable=SC2029
    eval "$("${SSH[@]}" "$HOST" 'set -a; source ~/sillage-core/.env; set +a; printf "DBPASS=%q\nSECRET=%q\nSESSION=%q\nPASS=%q\n" "$SILLAGE_DB_PASSWORD" "$SILLAGE_SHARED_SECRET" "$SESSION_SECRET" "$DASHBOARD_PASSWORD"')"
  fi

  LPS_URL="https://${IMAGES_DOMAIN:-images.${SHOP_DOMAIN#*.}}"
  if [[ -z "$IMAGES_DOMAIN" ]]; then
    LPS_URL="${LPS_MEDIA_BASE_URL:-https://images.prinscosmetic.eu}"
  else
    LPS_URL="https://${IMAGES_DOMAIN}"
  fi

  "${SSH[@]}" "$HOST" "cat > ~/${REMOTE_DIR}/.env" <<EOF
# Generated by deploy-vps.sh — do not commit
SILLAGE_CORE_IMAGE=${CORE_IMAGE}
WORDPRESS_IMAGE=${WP_IMAGE}
MARIADB_IMAGE=mariadb:latest
VALKEY_IMAGE=valkey/valkey:8-alpine
LPS_MEDIA_IMAGE=nginx:alpine

DATA_DIR=/home/ubuntu/${REMOTE_DIR}/data
FEEDSCRATCH_DIR=/home/ubuntu/${REMOTE_DIR}/.feedscratch
SILLAGE_LOGS_DIR=/home/ubuntu/${REMOTE_DIR}/sillage-core/logs
IMAGE_OVERRIDES_FILE=/home/ubuntu/${REMOTE_DIR}/sillage-core/data/image_overrides.json
SILLAGE_SECRETS_FILE=/home/ubuntu/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env
MARIADB_CNF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/mariadb.vps.cnf
LPS_MEDIA_NGINX_CONF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/nginx-lps-media.conf
PHP_INI=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/php.ini
APACHE_HIDE_CONF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/apache-hide-version.conf
SITEMAP_HOST_DIR=/home/ubuntu/${REMOTE_DIR}/data/sitemaps

DB_BIND=127.0.0.1
DB_HOST_PORT=3307
ECOM_BIND=127.0.0.1
ECOM_PORT=104
MEDIA_BIND=127.0.0.1
MEDIA_PORT=105
SILLAGE_BIND=127.0.0.1
SILLAGE_PORT=4000

SHOP_DOMAIN=${SHOP_DOMAIN}
DASH_DOMAIN=${DASH_DOMAIN}
IMAGES_DOMAIN=${IMAGES_DOMAIN}
WP_BASE_URL=https://${SHOP_DOMAIN}
SILLAGE_DASHBOARD_URL=https://${DASH_DOMAIN}
LPS_MEDIA_BASE_URL=${LPS_URL}

MYSQL_ROOT_PWD=${MYSQL_ROOT}
MYSQL_DB=earth
MYSQL_USER=lime
MYSQL_PWD=${MYSQL_PWD_GEN}

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
SILLAGE_SHARED_SECRET=${SECRET}

BEAUTYFORT_USER=${BEAUTYFORT_USER:-}
BEAUTYFORT_SECRET=${BEAUTYFORT_SECRET:-}
BEAUTYFORT_ENDPOINT=${BEAUTYFORT_ENDPOINT:-https://www.beautyfort.com/api/soap/v4}
BEAUTYFORT_TEST_MODE=false
BTS_JWT_TOKEN=${BTS_JWT_TOKEN:-}
BTS_BASE_URL=${BTS_BASE_URL:-https://api.btswholesaler.com/v1/api}
BTS_LANGUAGE=en-US
BRASTY_PRODUCT_FEED_URL=${BRASTY_PRODUCT_FEED_URL:-}
BRASTY_AVAILABILITY_FEED_URL=${BRASTY_AVAILABILITY_FEED_URL:-}

DASHBOARD_USER=${DASH_USER}
DASHBOARD_PASSWORD=${PASS}
WP_ADMIN_USER=${WP_USER}
WP_ADMIN_PASS=${WP_ADMIN_PASS}
WP_ADMIN_EMAIL=${WP_USER}@${SHOP_DOMAIN}
SESSION_SECRET=${SESSION}
FIXTURES_DIR=/app/.feedscratch
REDIS_URL=redis://valkey:6379
EOF
  "${SSH[@]}" "$HOST" "chmod 600 ~/${REMOTE_DIR}/.env"

  cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=${DASH_USER}
password=${PASS}
shop=https://${SHOP_DOMAIN}
wp_admin_user=${WP_USER}
wp_admin_password=${WP_ADMIN_PASS}
ip=${IP}
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$CREDS"
  log_step "Created ~/${REMOTE_DIR}/.env + ${CREDS}"
else
  # Update image tags + domains/vendor keys; keep DB/dashboard secrets.
  # Non-empty local values win; empty local values leave remote secrets untouched.
  "${SSH[@]}" "$HOST" "SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' IMAGES_DOMAIN='$IMAGES_DOMAIN' CORE_IMAGE='$CORE_IMAGE' WP_IMAGE='$WP_IMAGE' WITH_WORDPRESS='$WITH_WORDPRESS' LOCAL_BF_USER='${BEAUTYFORT_USER:-}' LOCAL_BF_SECRET='${BEAUTYFORT_SECRET:-}' LOCAL_BF_ENDPOINT='${BEAUTYFORT_ENDPOINT:-}' LOCAL_BTS_JWT='${BTS_JWT_TOKEN:-}' LOCAL_BTS_BASE='${BTS_BASE_URL:-}' LOCAL_BRASTY_PRODUCT='${BRASTY_PRODUCT_FEED_URL:-}' LOCAL_BRASTY_AVAIL='${BRASTY_AVAILABILITY_FEED_URL:-}' python3 -" <<'PY'
import os, pathlib, re
p = pathlib.Path.home() / "sillage" / ".env"
text = p.read_text()
def set_key(text, key, value):
    if value is None:
        return text
    pat = re.compile(rf"^{re.escape(key)}=.*$", re.M)
    line = f"{key}={value}"
    if pat.search(text):
        return pat.sub(line, text)
    return text.rstrip() + "\n" + line + "\n"
shop = os.environ["SHOP_DOMAIN"]
dash = os.environ["DASH_DOMAIN"]
images = os.environ.get("IMAGES_DOMAIN") or ""
lps = f"https://{images}" if images else None
pairs = [
    ("SILLAGE_CORE_IMAGE", os.environ["CORE_IMAGE"]),
    ("SHOP_DOMAIN", shop),
    ("DASH_DOMAIN", dash),
    ("IMAGES_DOMAIN", images),
    ("WP_BASE_URL", f"https://{shop}"),
    ("LPS_MEDIA_BASE_URL", lps),
    ("BEAUTYFORT_USER", os.environ.get("LOCAL_BF_USER") or None),
    ("BEAUTYFORT_SECRET", os.environ.get("LOCAL_BF_SECRET") or None),
    ("BEAUTYFORT_ENDPOINT", os.environ.get("LOCAL_BF_ENDPOINT") or None),
    ("BTS_JWT_TOKEN", os.environ.get("LOCAL_BTS_JWT") or None),
    ("BTS_BASE_URL", os.environ.get("LOCAL_BTS_BASE") or None),
    ("BRASTY_PRODUCT_FEED_URL", os.environ.get("LOCAL_BRASTY_PRODUCT") or None),
    ("BRASTY_AVAILABILITY_FEED_URL", os.environ.get("LOCAL_BRASTY_AVAIL") or None),
]
if os.environ.get("WITH_WORDPRESS") == "1":
    pairs.insert(1, ("WORDPRESS_IMAGE", os.environ["WP_IMAGE"]))
for k, v in pairs:
    if v is not None and v != "":
        text = set_key(text, k, v)
p.write_text(text)
print("ENV_UPDATED")
PY
  # Read every credential back from the remote .env, which is the only copy that survives. This
  # rewrites the file, so anything not read here is lost: the WordPress login used to be dropped
  # on any second deploy, leaving no record of the wp-admin password anywhere but the server.
  read -r REMOTE_USER REMOTE_PASS REMOTE_WP_USER REMOTE_WP_PASS <<<"$(
    "${SSH[@]}" "$HOST" 'set -a; source ~/sillage/.env; set +a; printf "%s %s %s %s" \
      "$DASHBOARD_USER" "$DASHBOARD_PASSWORD" "${WP_ADMIN_USER:-}" "${WP_ADMIN_PASS:-}"'
  )"
  cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=${REMOTE_USER}
password=${REMOTE_PASS}
shop=https://${SHOP_DOMAIN}
wp_admin_user=${REMOTE_WP_USER}
wp_admin_password=${REMOTE_WP_PASS}
ip=${IP}
updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$CREDS"
  log_step "Updated image tags in existing .env"
fi

echo "==> remote pull + up"
"${SSH[@]}" "$HOST" "APP_DIR=\$HOME/${REMOTE_DIR} SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' IMAGES_DOMAIN='$IMAGES_DOMAIN' CLONE_MODE='${CLONE_FROM:+1}' FRESH='$FRESH' WP_ADMIN_USER='${WP_USER:-${WP_ADMIN_USER:-}}' WP_ADMIN_PASS='${WP_ADMIN_PASS:-}' KEEP_CADDY='${KEEP_CADDY:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
set -a; source .env; set +a

WP_PORT="${ECOM_PORT:-104}"
MEDIA_PORT="${MEDIA_PORT:-105}"

IMAGES_SITE_BLOCK=""
if [[ -n "${IMAGES_DOMAIN:-}" ]]; then
  IMAGES_SITE_BLOCK="${IMAGES_DOMAIN} {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:${MEDIA_PORT} {
		header_down -Server
		header_down -Via
	}
}"
fi

# Empty VPS: write the Caddyfile for this shop. If the box already terminates
# TLS for other hostnames (shared retail+wholesale), leave it alone.
if [[ -z "${KEEP_CADDY:-}" && -f /etc/caddy/Caddyfile ]]; then
  while read -r site; do
    [[ -z "$site" ]] && continue
    ours=0
    for d in ${SHOP_DOMAIN:-} ${DASH_DOMAIN:-} ${IMAGES_DOMAIN:-}; do
      [[ "$site" == "$d" ]] && ours=1
    done
    if [[ "$ours" -eq 0 ]]; then
      echo "Caddy already serves $site — leaving /etc/caddy/Caddyfile (pass --replace-caddy to overwrite)"
      KEEP_CADDY=1
      break
    fi
  done < <(grep -E '^[A-Za-z0-9._-]+\.[A-Za-z0-9.-]+ \{' /etc/caddy/Caddyfile | awk '{print $1}' || true)
fi

if [[ "${KEEP_CADDY:-0}" == "1" ]]; then
  echo "Skipping Caddyfile rewrite"
else
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${SHOP_DOMAIN} {
	# AI training crawlers walk every /product and /brand page. Prefork PHP
	# cannot survive that on a ~4 GB box. Images CDN stays open (cheap files).
	# See docs/CRAWLER-SHIELD.md
	@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
	handle @heavybot {
		respond "Forbidden" 403
	}
	handle_path /lps-media/* {
		header {
			-Server
			-Via
		}
		reverse_proxy localhost:${MEDIA_PORT} {
			header_down -Server
			header_down -Via
		}
	}
	# Product listing for Google: static files from Bun, not PHP.
	# Fast price/stock sync does not rewrite these. See docs/SEO.md
	handle /robots.txt {
		root * ${DATA_DIR}/sitemaps
		file_server
		header Cache-Control "public, max-age=3600"
		header -Server
	}
	handle /wp-sitemap* {
		root * ${DATA_DIR}/sitemaps
		file_server
		header Cache-Control "public, max-age=86400"
		header -Server
	}
	header {
		-Server
		-Via
		-X-Powered-By
	}
	reverse_proxy localhost:${WP_PORT} {
		header_down -Server
		header_down -Via
		header_down -X-Powered-By
	}
}
${DASH_DOMAIN} {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:${SILLAGE_PORT:-4000} {
		header_down -Server
		header_down -Via
	}
}
${IMAGES_SITE_BLOCK}
EOF
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile || sudo systemctl reload caddy
fi

docker network create ecom_network 2>/dev/null || true
docker network create redis_network 2>/dev/null || true

# Stop legacy split compose projects if they still own the container names.
if [[ -f "$HOME/redis/compose.yaml" ]]; then
  (cd "$HOME/redis" && docker compose down 2>/dev/null) || true
fi
if [[ -f "$HOME/ecom_sites/compose.yaml" ]]; then
  (cd "$HOME/ecom_sites" && docker compose down 2>/dev/null) || true
fi

mkdir -p "$DATA_DIR/media" "$DATA_DIR/sitemaps" \
  "$APP_DIR/sillage-core/logs" "$APP_DIR/.feedscratch"
# Ensure image overrides + secrets overlay files exist for bind mounts (file, not directory).
[[ -f "$APP_DIR/sillage-core/data/image_overrides.json" ]] \
  || echo '{}' > "$APP_DIR/sillage-core/data/image_overrides.json"
[[ -f "$APP_DIR/sillage-core/data/secrets.overlay.env" ]] \
  || : > "$APP_DIR/sillage-core/data/secrets.overlay.env"
chmod 600 "$APP_DIR/sillage-core/data/secrets.overlay.env" 2>/dev/null || true

docker compose --env-file .env pull
docker compose --env-file .env up -d ecom-db valkey
echo "Waiting for MariaDB..."
for i in $(seq 1 60); do
  if docker exec -i ecom-db healthcheck.sh --connect --innodb_initialized </dev/null 2>/dev/null; then
    break
  fi
  sleep 2
done

if [[ -f /tmp/sillage-clone.sql ]]; then
  echo "Importing cloned SQL..."
  docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot < /tmp/sillage-clone.sql
  rm -f /tmp/sillage-clone.sql
fi

docker compose --env-file .env up -d

# WordPress lives in a Docker volume, so every check and edit goes through the container. The
# host has no business holding WordPress core: that is how a datadir drifted to a newer version
# than the image it booted from, and it is why hard rule 1 exists at all.
wp_has_config() { docker exec ecom test -f /var/www/html/wp-config.php 2>/dev/null; }
wp_chown() { docker exec ecom chown -R www-data:www-data /var/www/html/wp-content 2>/dev/null || true; }

echo "Waiting for WordPress files..."
for i in $(seq 1 90); do
  wp_has_config && break
  sleep 2
done

# The bridge plugin ships on every deploy, into the volume rather than a host wp-content.
if [[ -d "$APP_DIR/wp-staging/sillage-bridge" ]]; then
  docker exec ecom rm -rf /var/www/html/wp-content/plugins/sillage-bridge
  docker cp "$APP_DIR/wp-staging/sillage-bridge" ecom:/var/www/html/wp-content/plugins/
  wp_chown
  echo "sillage-bridge copied into the WordPress volume"
fi

# Whether WordPress needs installing is a question about the *database*, not about wp-config.php.
# The official image's entrypoint writes wp-config.php on first boot, and the loop above waits for
# exactly that, so a file test here is always false by the time it is read — which silently skipped
# the whole install: no WooCommerce, no Blocksy, no admin user, and a shop that answered on :80
# with the WordPress five-minute install screen.
wp_installed() {
  docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot -N \
    -e "SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema='${MYSQL_DB}' AND table_name='${WP_TABLE_PREFIX:-wp_}options';" \
    </dev/null 2>/dev/null | grep -q '^1$'
}

NEED_FRESH=0
wp_installed || NEED_FRESH=1
if [[ -z "${CLONE_MODE:-}" && ( "$NEED_FRESH" -eq 1 || "${FRESH:-0}" == "1" ) ]]; then
  echo "Fetching WooCommerce / redis-cache / Blocksy from wordpress.org..."
  STAGE="$(mktemp -d)"
  for item in "plugin:woocommerce" "plugin:redis-cache" "theme:blocksy"; do
    kind=${item%%:*}; slug=${item##*:}
    if docker exec ecom test -d "/var/www/html/wp-content/${kind}s/${slug}"; then
      echo "  $slug already present"
      continue
    fi
    curl -fsSL -o "$STAGE/${slug}.zip" "https://downloads.wordpress.org/${kind}/${slug}.latest-stable.zip"
    unzip -qo "$STAGE/${slug}.zip" -d "$STAGE"
    docker cp "$STAGE/${slug}" "ecom:/var/www/html/wp-content/${kind}s/"
    rm -rf "$STAGE/${slug}" "$STAGE/${slug}.zip"
    echo "  $slug installed"
  done
  rm -rf "$STAGE"
  wp_chown

  # Wait again for wp-config from the official image entrypoint
  for i in $(seq 1 60); do
    wp_has_config && break
    sleep 2
  done

  if wp_has_config; then
    if [[ -f "$APP_DIR/ecom_sites/config/wordpress.htaccess" ]]; then
      docker cp "$APP_DIR/ecom_sites/config/wordpress.htaccess" ecom:/var/www/html/.htaccess
      docker exec ecom chown www-data:www-data /var/www/html/.htaccess || true
    fi
    INSTALL_PHP="$APP_DIR/scripts/wp-fresh-install.php"
    if [[ ! -f "$INSTALL_PHP" ]]; then
      echo "Missing $INSTALL_PHP — cannot finish empty-VPS WordPress install" >&2
      exit 1
    fi
    docker cp "$INSTALL_PHP" ecom:/tmp/wp-fresh-install.php
    docker exec \
      -e SHOP_DOMAIN="$SHOP_DOMAIN" \
      -e WP_BASE_URL="${WP_BASE_URL:-https://${SHOP_DOMAIN}}" \
      -e WP_ADMIN_USER="${WP_ADMIN_USER:-}" \
      -e WP_ADMIN_PASS="${WP_ADMIN_PASS:-}" \
      -e WP_ADMIN_EMAIL="${WP_ADMIN_EMAIL:-}" \
      -e SHOP_TITLE="${SHOP_TITLE:-Cosmetic}" \
      -e SILLAGE_SHARED_SECRET="${SILLAGE_SHARED_SECRET:-}" \
      -e SILLAGE_DASHBOARD_URL="https://${DASH_DOMAIN}" \
      -e SILLAGE_CORE_INTERNAL_URL="http://sillage-core:4000" \
      ecom php /tmp/wp-fresh-install.php
  fi
fi

export SILLAGE_DASHBOARD_URL="https://${DASH_DOMAIN}"
wp_chown
if wp_has_config; then
  # Creates the sillage DB user and grants, then patches wp-config inside the container:
  # the bridge constants, DISABLE_WP_CRON, and FS_METHOD for wp-admin plugin uploads.
  bash "$APP_DIR/scripts/vps-bootstrap.sh"
fi

if [[ -n "${CLONE_MODE:-}" ]]; then
  docker exec ecom php -r "
    require '/var/www/html/wp-load.php';
    \$url = 'https://${SHOP_DOMAIN}';
    update_option('siteurl', \$url);
    update_option('home', \$url);
    echo \"urls=\$url\\n\";
  " || true
fi

cd "$APP_DIR"
set -a; source .env; set +a
if [[ -f ecom_sites/config/sillage-grants.sql ]]; then
  # Report-only: the WooCommerce tables do not exist until the operator activates the plugin, and
  # MariaDB refuses a grant on a missing table. --finish applies the rest and enforces it.
  bash scripts/apply-grants.sh
fi
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot \
  -e "GRANT SELECT, INSERT, UPDATE ON earth.wp_wc_order_addresses TO 'sillage'@'%'; FLUSH PRIVILEGES;" || true

docker compose --env-file .env up -d
docker exec sillage-core bun run migrate
# Drop unused Hub tags / dangling layers so day-2 deploys do not pile up 20+ images.
docker image prune -af
echo "Images after prune:"
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot \
  -e "GRANT SELECT ON sillage.sil_ean_index TO 'lime'@'%'; GRANT SELECT ON sillage.sil_settings TO 'lime'@'%'; GRANT SELECT ON sillage.sil_vendors TO 'lime'@'%'; FLUSH PRIVILEGES;" || true
if [[ "${WP_ACTIVATE_PLUGINS:-0}" == "1" ]]; then
  docker exec ecom php -r 'require "/var/www/html/wp-load.php"; require_once ABSPATH."wp-admin/includes/plugin.php"; activate_plugin("sillage-bridge/sillage-bridge.php"); echo "plugin ok\n";' || true
fi

# The live box was hand-tuned with swap and a sitemap cron that no script created, so a
# rebuilt VPS came up subtly different: OOM kills during the first import, and Caddy serving
# robots.txt / wp-sitemap*.xml out of a directory nothing ever wrote. Both belong here.
if ! swapon --show | grep -q '^/swapfile'; then
  echo "==> 4G swapfile (a full sync peaks near 2 GB)"
  sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
  sudo mkdir -p /etc/sysctl.d
  echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-sillage-swap.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-sillage-swap.conf >/dev/null
fi
swapon --show

# Pass the directory and the base URL explicitly: the script defaults to the live box's layout
# and the live shop's domain, and cron has none of the deploy environment. Getting either wrong
# is silent — Caddy serves an empty directory, or robots.txt advertises another shop's sitemap.
SITEMAP_ENV="SITEMAP_HOST_DIR=${SITEMAP_HOST_DIR:-${DATA_DIR}/sitemaps} WP_BASE_URL=https://${SHOP_DOMAIN}"
SITEMAP_CRON="0 19 * * * ${SITEMAP_ENV} python3 ${APP_DIR}/scripts/write-sitemaps.py >> ${APP_DIR}/sillage-core/logs/sitemap-cron.log 2>&1"
if ! crontab -l 2>/dev/null | grep -qF "write-sitemaps.py"; then
  # A box that has never had a crontab makes `crontab -l` exit non-zero, which under `set -e`
  # killed the subshell before the echo and left an empty crontab behind — silently, because the
  # error was sent to /dev/null. The live box had a crontab already, so this only ever showed up
  # on a genuinely fresh machine.
  { crontab -l 2>/dev/null || true; echo "$SITEMAP_CRON"; } | crontab -
  echo "==> installed sitemap cron"
fi
mkdir -p "$DATA_DIR/sitemaps"
SITEMAP_HOST_DIR="${SITEMAP_HOST_DIR:-${DATA_DIR}/sitemaps}" WP_BASE_URL="https://${SHOP_DOMAIN}" \
  python3 "$APP_DIR/scripts/write-sitemaps.py" >>"$APP_DIR/sillage-core/logs/sitemap-cron.log" 2>&1 \
  && echo "==> sitemaps written" || echo "NOTE: first sitemap run failed; catalogue is probably still empty"

curl -sS "http://127.0.0.1:${SILLAGE_PORT:-4000}/health" || true
echo
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
echo "Deploy finished. Open https://${DASH_DOMAIN}"
REMOTE

log_step "Remote bring-up finished"
TOTAL=$(( $(date +%s) - START_EPOCH ))
log_step "DONE total=${TOTAL}s (~$((TOTAL/60))m$((TOTAL%60))s)"

echo
echo "==> done"
echo "Shop:      https://${SHOP_DOMAIN}"
echo "Dashboard: https://${DASH_DOMAIN}"
[[ -n "$IMAGES_DOMAIN" ]] && echo "Images:    https://${IMAGES_DOMAIN}"
echo "Compose:   ${HOST}:~/${REMOTE_DIR}/compose.yaml"
echo "Env:       ${HOST}:~/${REMOTE_DIR}/.env"
echo "Creds:     $CREDS"
echo "Images:    ${CORE_IMAGE}  ${WP_IMAGE}"
