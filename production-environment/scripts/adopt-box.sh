#!/usr/bin/env bash
#
# Make a restored stack answer on *this* box's hostnames.
#
#   cd ~/sillage && bash scripts/adopt-box.sh \
#       --shop prinscosmetic.eu --dash sillage.prinscosmetic.eu --images images.prinscosmetic.eu \
#       --role development
#
# Run after unpacking a pack-box.sh tarball. A restored stack is a byte-for-byte copy of another
# box, which means every hostname in it still names that box. There are six places holding one, and
# missing any single one gives you a shop that half-works — pages render and every image is broken,
# or the dashboard loads and the login posts to a machine you no longer control:
#
#   1. .env                                   SHOP_DOMAIN / DASH_DOMAIN / IMAGES_DOMAIN and friends
#   2. /etc/caddy/sites/<stack>.caddy         which names this box answers on, and its TLS certs
#   3. wp_options.siteurl / .home             every link WordPress prints
#   4. sil_settings.wp_base_url               where the engine thinks the shop is
#   5. sil_settings.image_cdn_base_url        what bare filenames in the overrides resolve against
#   6. wp_postmeta._external_thumbnail_url    the photo URL already written on each product
#
# An adopted stack is a shop like any other: it carries the vendor credentials and the settings the
# pack was taken with, and neither vendor API has a sandbox. Open the Sync and Orders pages
# afterwards and set them the way you want *this* box to behave — see docs/SYNC-RULES.md. This
# script never touches those settings.
set -euo pipefail

SHOP=""; DASH=""; IMAGES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --shop) SHOP="${2:?}"; shift 2 ;;
    --dash) DASH="${2:?}"; shift 2 ;;
    --images) IMAGES="${2:?}"; shift 2 ;;
    # Retired: there is no development tier. Still swallowed so an old command line works.
    --role|--dev)
      shift
      if [[ "${1:-}" =~ ^(production|development)$ ]]; then shift; fi
      ;;
    *) echo "unexpected argument: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$SHOP" && -n "$DASH" ]] || { echo "need --shop and --dash (and normally --images)" >&2; exit 1; }
[[ -f .env && -f compose.yaml ]] || { echo "run this from a restored stack directory" >&2; exit 1; }

STACK="$(basename "$PWD")"
set -a; . ./.env; set +a
OLD_SHOP="${SHOP_DOMAIN:-}"; OLD_DASH="${DASH_DOMAIN:-}"; OLD_IMAGES="${IMAGES_DOMAIN:-}"
echo "adopting ${STACK}: ${OLD_SHOP:-?} → ${SHOP}"

COMPOSE=(docker compose -f compose.yaml --env-file .env)

echo "==> 1/6 .env"
python3 - "$SHOP" "$DASH" "$IMAGES" <<'PY'
import pathlib, sys
shop, dash, images = sys.argv[1], sys.argv[2], sys.argv[3]
values = {
    "SHOP_DOMAIN": shop,
    "DASH_DOMAIN": dash,
    "WP_BASE_URL": f"https://{shop}",
    "SILLAGE_DASHBOARD_URL": f"https://{dash}",
}
if images:
    values["IMAGES_DOMAIN"] = images
    values["LPS_MEDIA_BASE_URL"] = f"https://{images}"
p = pathlib.Path(".env")
out, seen = [], set()
for line in p.read_text().splitlines():
    key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else ""
    if key in values:
        out.append(f"{key}={values[key]}"); seen.add(key)
    else:
        out.append(line)
extra = [k for k in values if k not in seen]
if extra:
    out.append("")
    out.append("# Set by adopt-box.sh for this box.")
    out += [f"{k}={values[k]}" for k in extra]
p.write_text("\n".join(out) + "\n")
for k in values:
    print(f"    {k}={values[k]}")
PY
set -a; . ./.env; set +a

echo "==> 2/6 caddy"
SRC=""
for candidate in "$HOME/_etc/caddy/sites/${STACK}.caddy" "$HOME/_etc/caddy/sites/retail.caddy" \
                 "$HOME/_etc/caddy/sites/wholesale.caddy"; do
  [[ -f "$candidate" ]] && { SRC="$candidate"; break; }
done
if [[ -n "$SRC" ]] && grep -q "${OLD_SHOP}" "$SRC"; then
  sudo mkdir -p /etc/caddy/sites
  # The packed file carries the crawler shield, the media proxy and the header rules. Substituting
  # the three hostnames keeps all of that instead of re-authoring it here and drifting.
  sed -e "s/\b${OLD_SHOP}\b/${SHOP}/g" \
      ${OLD_DASH:+-e "s/\b${OLD_DASH}\b/${DASH}/g"} \
      ${OLD_IMAGES:+${IMAGES:+-e "s/\b${OLD_IMAGES}\b/${IMAGES}/g"}} \
      "$SRC" | sudo tee "/etc/caddy/sites/${STACK}.caddy" >/dev/null
  # Any other file claiming our hostnames makes Caddy refuse the whole config as ambiguous.
  for f in /etc/caddy/sites/*.caddy; do
    [[ "$f" == "/etc/caddy/sites/${STACK}.caddy" ]] && continue
    if sudo grep -qE "^(${SHOP}|${DASH}${IMAGES:+|${IMAGES}}) \{" "$f" 2>/dev/null; then
      echo "    removing ${f}, which also claims these hostnames"
      sudo rm -f "$f"
    fi
  done
  printf 'import /etc/caddy/sites/*.caddy\n' | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    && { sudo systemctl reload caddy; echo "    /etc/caddy/sites/${STACK}.caddy installed and reloaded"; } \
    || echo "    caddy config did not validate — left the running config alone" >&2
else
  echo "    no packed caddy config found for ${STACK}; skipping (deploy writes it instead)"
fi

echo "==> 3/6 starting the stack"
"${COMPOSE[@]}" up -d >/dev/null
for _ in $(seq 1 60); do
  docker exec "${DB_HOST}" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 && break
  sleep 2
done

mysql() { docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" "$DB_HOST" mariadb -uroot "$@"; }

echo "==> 4/6 wordpress urls"
mysql -e "UPDATE \`${WORDPRESS_DB}\`.wp_options
             SET option_value = 'https://${SHOP}'
           WHERE option_name IN ('siteurl','home');"
echo "    siteurl and home → https://${SHOP}"

echo "==> 5/6 engine settings"
mysql -e "UPDATE \`${SILLAGE_DB}\`.sil_settings
             SET setting_value = 'https://${SHOP}' WHERE setting_key = 'wp_base_url';"
if [[ -n "$IMAGES" ]]; then
  mysql -e "UPDATE \`${SILLAGE_DB}\`.sil_settings
               SET setting_value = 'https://${IMAGES}' WHERE setting_key = 'image_cdn_base_url';"
  echo "    wp_base_url → https://${SHOP}, image_cdn_base_url → https://${IMAGES}"
else
  echo "    wp_base_url → https://${SHOP} (no images domain given)"
fi

echo "==> 6/6 product photo urls"
if [[ -n "$IMAGES" && -n "$OLD_IMAGES" && "$IMAGES" != "$OLD_IMAGES" ]]; then
  # Only this stack's own photos. A Shopify or vendor CDN URL is not ours to rewrite.
  moved=$(mysql -N -e "
    UPDATE \`${WORDPRESS_DB}\`.wp_postmeta
       SET meta_value = REPLACE(meta_value, 'https://${OLD_IMAGES}/', 'https://${IMAGES}/')
     WHERE meta_key = '_external_thumbnail_url'
       AND meta_value LIKE 'https://${OLD_IMAGES}/%';
    SELECT ROW_COUNT();")
  echo "    repointed ${moved} thumbnails to ${IMAGES}"
else
  echo "    nothing to repoint"
fi

echo "==> flushing caches"
docker exec "${VALKEY_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -m1 valkey)}" \
  valkey-cli FLUSHALL >/dev/null 2>&1 || true
sleep 3
bash scripts/wp-finalize.sh 2>&1 | tail -1 || \
  echo "    finalize failed — if the shop looks empty, run scripts/wp-finalize.sh again" >&2

echo
echo "${STACK} adopted:"
echo "  shop      https://${SHOP}"
echo "  dashboard https://${DASH}"
[[ -n "$IMAGES" ]] && echo "  images    https://${IMAGES}"
echo "  settings  untouched — check Sync and Orders on this box (docs/SYNC-RULES.md)"
