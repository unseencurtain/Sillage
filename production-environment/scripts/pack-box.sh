#!/usr/bin/env bash
#
# Pack the whole box into one file you can download.
#
#   bash ~/sillage/scripts/pack-box.sh              # stops the stacks, packs, starts them
#   bash ~/sillage/scripts/pack-box.sh --live       # no downtime, database files taken hot
#   bash ~/sillage/scripts/pack-box.sh --live --keep 3
#   OUT=/tmp/box.tar.gz bash ~/sillage/scripts/pack-box.sh
#
# Run it when you want a copy — before a risky change, before wiping a box, before handing one
# over. Deliberately not on a timer: it writes the better part of a gigabyte and reads every
# database, and a backup that starts on its own is a surprise in the middle of something else.
#
# Download the result somewhere that is not the box. A backup living only on the machine it backs
# up is a backup of nothing, which is what an `rm -rf` in $HOME proved here on 2026-09-08.
#
# This is the backup that is worth having, and it only works because WordPress and MariaDB were
# moved out of Docker named volumes and into each stack's data/ directory (scripts/to-bind-mounts.sh).
# While they lived in volumes, a tar of the home folder looked complete and quietly contained no
# WordPress installation and no database — which you only discover when you try to restore it.
#
# Default is to stop the stacks first. A MariaDB data directory copied while the server is writing
# to it can restore into a corrupt table, and a backup you cannot trust is not a backup. --live
# skips the downtime and additionally writes SQL dumps, which are consistent even when the files
# underneath are not, so a hot pack is still restorable.
#
# Excluded: .ssh (keys do not travel with data), previous packs, and the feed cache, which is
# hundreds of megabytes of vendor XML that re-downloads itself.
set -euo pipefail

LIVE=0
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --keep) KEEP="${2:?}"; shift 2 ;;
    *) echo "unexpected argument: $1" >&2; exit 1 ;;
  esac
done

STAMP="$(date -u +%Y%m%d-%H%M)"
OUT="${OUT:-$HOME/box-${STAMP}.tar.gz}"
STACKS=()
for d in "$HOME"/*/; do
  [[ -f "${d}compose.yaml" && -f "${d}.env" ]] && STACKS+=("$(basename "$d")")
done
[[ "${#STACKS[@]}" -gt 0 ]] || { echo "no stacks found in $HOME" >&2; exit 1; }
echo "stacks: ${STACKS[*]}"

compose_for() {
  local s="$1"
  local args=(-f compose.yaml)
  [[ -f "$HOME/$s/compose.dev.yaml" ]] && args+=(-f compose.dev.yaml)
  printf '%s ' "${args[@]}"
}

if [[ "$LIVE" -eq 1 ]]; then
  echo "==> hot pack: writing SQL dumps so the copy is restorable even if the datadir files are not"
  for s in "${STACKS[@]}"; do
    ( cd "$HOME/$s" && set -a && . ./.env && set +a
      mkdir -p dumps
      for db in "$WORDPRESS_DB" "$SILLAGE_DB"; do
        docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" "$DB_HOST" \
          mariadb-dump -uroot --single-transaction --quick --routines --events \
          --default-character-set=utf8mb4 "$db" | gzip -1 > "dumps/${db}.sql.gz"
        echo "    ${s}: dumps/${db}.sql.gz"
      done )
  done
else
  echo "==> stopping the stacks (both shops are down until this finishes)"
  for s in "${STACKS[@]}"; do
    ( cd "$HOME/$s" && eval "docker compose $(compose_for "$s") --env-file .env down" ) >/dev/null 2>&1
    echo "    ${s} down"
  done
fi

# Caddy's config is the one thing that matters and does not live in $HOME: without it a restored
# box serves nothing on any hostname, and the crawler shield and TLS settings would have to be
# reconstructed from memory. It rides along under _etc/ and adopt-box.sh rewrites the hostnames.
if [[ -d /etc/caddy ]]; then
  echo "==> including /etc/caddy"
  sudo rm -rf "$HOME/_etc"
  sudo mkdir -p "$HOME/_etc"
  sudo cp -a /etc/caddy "$HOME/_etc/"
  sudo chown -R "$(id -u):$(id -g)" "$HOME/_etc"
fi

echo "==> packing $HOME"
# sudo: MariaDB's datadir is owned by uid 999 and WordPress by www-data, and a tar that cannot read
# them would succeed with holes in it. Numeric owners so the restore does not depend on the target
# box having the same user names.
sudo tar --numeric-owner -C "$HOME" \
  --exclude='./.ssh' \
  --exclude='./.cache' \
  --exclude='./box-*.tar.gz' \
  --exclude='./*.tar.gz' \
  --exclude='./*/.feedscratch/*' \
  -czf "$OUT" . 2>/dev/null || true
sudo chown "$(id -u):$(id -g)" "$OUT"

if [[ "$LIVE" -eq 0 ]]; then
  echo "==> starting the stacks"
  for s in "${STACKS[@]}"; do
    ( cd "$HOME/$s" && eval "docker compose $(compose_for "$s") --env-file .env up -d" ) >/dev/null 2>&1
    echo "    ${s} up"
  done
fi

{
  echo "packed        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "from host     $(hostname)"
  echo "stacks        ${STACKS[*]}"
  echo "consistency   $([[ "$LIVE" -eq 1 ]] && echo 'hot (use dumps/ to restore databases)' || echo 'stacks stopped (files are consistent)')"
  for s in "${STACKS[@]}"; do
    echo "  ${s} shop  $(grep -oP '(?<=^SHOP_DOMAIN=).*' "$HOME/$s/.env" 2>/dev/null || echo '?')"
  done
} > "${OUT%.tar.gz}.txt"

echo
echo "$(du -h "$OUT" | cut -f1)  ${OUT}"
sed 's/^/  /' "${OUT%.tar.gz}.txt"
if [[ "$KEEP" -gt 0 ]]; then
  # Keep the newest KEEP packs. A 750 MB file a night fills a 38 GB disk in a month, and a full
  # disk stops the shop, which is a worse outcome than a shorter history.
  mapfile -t OLD < <(ls -1t "$HOME"/box-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
  for f in "${OLD[@]:-}"; do
    [[ -n "$f" ]] || continue
    rm -f "$f" "${f%.tar.gz}.txt"
    echo "pruned $(basename "$f")"
  done
fi

echo
echo "Restore on another box: put this file in ~, then"
echo "  sudo tar --numeric-owner -C \$HOME -xzf $(basename "$OUT")"
echo "  cd ~/<stack> && bash scripts/adopt-box.sh   # rewrites the hostnames for that box"
