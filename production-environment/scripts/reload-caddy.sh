#!/usr/bin/env bash
# Validate and reload the Caddy config linked from ~/sillage/ops/caddy/.
set -euo pipefail

APP_DIR="${SILLAGE_DIR:-$HOME/sillage}"
STACK="${SILLAGE_STACK:-sillage}"
CONFIG="$APP_DIR/ops/caddy/$STACK.caddy"
LINK="/etc/caddy/sites/$STACK.caddy"

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing editable Caddy config: $CONFIG" >&2
  exit 1
fi
if [[ ! -L "$LINK" || "$(readlink -f "$LINK")" != "$CONFIG" ]]; then
  echo "Caddy import link is not pointing to $CONFIG ($LINK)" >&2
  exit 1
fi
sudo caddy fmt --overwrite "$CONFIG"
sudo chown "$(id -un):caddy" "$CONFIG"
sudo chmod 640 "$CONFIG"
sudo -u caddy test -r "$CONFIG"
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
printf 'Caddy reloaded from %s\n' "$CONFIG"
