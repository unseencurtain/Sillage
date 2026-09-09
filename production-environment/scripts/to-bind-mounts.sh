#!/usr/bin/env bash
#
# Move this stack's WordPress and MariaDB out of Docker named volumes and into the stack directory.
#
#   cd ~/sillage && bash scripts/to-bind-mounts.sh
#
# One-time, per stack. Idempotent: if .env already points at the bind paths and they hold data, it
# says so and stops.
#
# Why: a named volume lives under /var/lib/docker, so `tar` of the stack directory silently omits
# WordPress core, every installed plugin and theme, wp-config.php, the uploads directory, and the
# database files. A backup taken that way restores a shop with no shop in it — which is exactly
# what happened, and it is only obvious once you try to restore onto a machine that never had them.
# With both under data/, the stack directory *is* the stack, and zipping it is a real backup.
#
# The stack is down while the files copy, which is a few minutes at production size. Nothing is
# deleted: the old volumes stay untouched, so the rollback is putting the two .env lines back.
set -euo pipefail

[[ -f .env && -f compose.yaml ]] || { echo "run this from a stack directory" >&2; exit 1; }
set -a; . ./.env; set +a

COMPOSE=(docker compose -f compose.yaml)
[[ -f compose.dev.yaml ]] && COMPOSE=(docker compose -f compose.yaml -f compose.dev.yaml)
COMPOSE+=(--env-file .env)

WP_DEST="./data/wp"
DB_DEST="./data/wp-db"

# Ask Docker what is mounted now rather than trusting .env: the point of this script is that the
# two can disagree.
#
# Find the containers through compose, never by guessing a name. Retail calls them ecom/ecom-db and
# wholesale calls them wholesale-ecom/wholesale-db, so a default of "ecom" run from the wholesale
# directory reads *retail's* mounts and reports whatever that stack happens to be doing — which is
# exactly the wrong answer, and it took wholesale down to find out.
IDS=$("${COMPOSE[@]}" ps -q 2>/dev/null || true)
[[ -n "$IDS" ]] || { echo "no containers for this stack are running — start it first" >&2; exit 1; }

mount_of() {
  local dest="$1" id
  for id in $IDS; do
    local found
    found=$(docker inspect "$id" \
      --format "{{range .Mounts}}{{if eq .Destination \"${dest}\"}}{{.Type}} {{.Name}}{{end}}{{end}}" 2>/dev/null)
    if [[ -n "$found" ]]; then printf '%s' "$found"; return; fi
  done
}

wp_vol=$(mount_of /var/www/html)
db_vol=$(mount_of /var/lib/mysql)

echo "wordpress mount: ${wp_vol:-<container not running>}"
echo "database  mount: ${db_vol:-<container not running>}"

if [[ "$wp_vol" == bind* && "$db_vol" == bind* ]]; then
  echo "already on bind mounts — nothing to do"
  exit 0
fi

WP_NAME="${wp_vol#volume }"
DB_NAME="${db_vol#volume }"
[[ -n "$WP_NAME" && -n "$DB_NAME" ]] || {
  echo "could not read both volume names — start the stack first" >&2; exit 1; }

echo
echo "==> stopping the stack (the shop is down from here until it is back up)"
"${COMPOSE[@]}" down

mkdir -p "$WP_DEST" "$DB_DEST"

# Copy inside a container, as root, with tar: MariaDB's datadir is owned by uid 999 and WordPress
# by www-data, and losing that ownership means a stack that starts and then refuses to read its
# own files. tar -p preserves it; cp as the ubuntu user would not.
copy_volume() {
  local name="$1" dest="$2"
  local count
  count=$(find "$dest" -mindepth 1 -maxdepth 1 | wc -l)
  if [[ "$count" -gt 0 ]]; then
    echo "    ${dest} is not empty (${count} entries) — leaving it alone"
    return
  fi
  echo "    ${name} → ${dest}"
  docker run --rm -v "${name}:/from:ro" -v "$(cd "$(dirname "$dest")" && pwd)/$(basename "$dest"):/to" \
    alpine sh -c 'cd /from && tar -cf - . | tar -C /to -xpf -'
}

echo "==> copying (this is the slow part)"
copy_volume "$WP_NAME" "$WP_DEST"
copy_volume "$DB_NAME" "$DB_DEST"

echo "==> pointing .env at the bind paths"
python3 - "$WP_DEST" "$DB_DEST" <<'PY'
import pathlib, sys
wp, db = sys.argv[1], sys.argv[2]
p = pathlib.Path(".env")
lines = p.read_text().splitlines()
want = {"WP_DATA": wp, "WP_DB_DATA": db}
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0].strip() if "=" in line else ""
    if key in want:
        out.append(f"{key}={want[key]}")
        seen.add(key)
    else:
        out.append(line)
missing = [k for k in want if k not in seen]
if missing:
    out.append("")
    out.append("# WordPress and MariaDB live in the stack directory, so tar of this directory is a")
    out.append("# complete backup. Removing these two lines sends them back into Docker volumes.")
    out += [f"{k}={want[k]}" for k in missing]
p.write_text("\n".join(out) + "\n")
print("   ", ", ".join(f"{k}={v}" for k, v in want.items()))
PY

echo "==> starting the stack"
"${COMPOSE[@]}" up -d

echo "==> waiting for the database"
for _ in $(seq 1 60); do
  docker exec "${DB_HOST:-ecom-db}" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 && break
  sleep 2
done

echo
IDS=$("${COMPOSE[@]}" ps -q 2>/dev/null || true)
source_of() {
  local dest="$1" id found
  for id in $IDS; do
    found=$(docker inspect "$id" \
      --format "{{range .Mounts}}{{if eq .Destination \"${dest}\"}}{{.Type}} {{.Source}}{{end}}{{end}}" 2>/dev/null)
    if [[ -n "$found" ]]; then printf '%s' "$found"; return; fi
  done
}
echo "wordpress now: $(source_of /var/www/html)"
echo "database  now: $(source_of /var/lib/mysql)"

if [[ -n "${SHOP_DOMAIN:-}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
    -H "Host: ${SHOP_DOMAIN}" "http://127.0.0.1:${ECOM_PORT:-8080}/" || true)
  echo "shop responds: HTTP ${code}"
fi

echo
echo "done. The old volumes ${WP_NAME} and ${DB_NAME} still exist — delete them only after"
echo "the shop has been verified: docker volume rm ${WP_NAME} ${DB_NAME}"
