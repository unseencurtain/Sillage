#!/usr/bin/env bash
# Change the pinned WordPress version, then build and deploy the updated image.
# Usage: scripts/bump-wordpress.sh 7.1.3 --host <ssh-alias> --shop shop.example --dash shop.example [--images images.example]
set -euo pipefail

VERSION="${1:-}"
shift || true
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "Usage: $0 <wordpress-version> --host <alias> --shop <domain> --dash <domain> [deploy-vps options...]" >&2
  exit 2
fi
if [[ " $* " != *" --host "* || " $* " != *" --shop "* || " $* " != *" --dash "* ]]; then
  echo "--host, --shop, and --dash are required; the deploy has no hostname defaults" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PE="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$PE/wordpress-image/Dockerfile"
python3 - "$DOCKERFILE" "$VERSION" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
updated, count = re.subn(r"(?m)^FROM wordpress:[0-9.]+-php8\.3-apache$", f"FROM wordpress:{sys.argv[2]}-php8.3-apache", text)
if count != 1:
    raise SystemExit("Expected exactly one pinned wordpress:<version>-php8.3-apache line")
p.write_text(updated)
PY

exec "$SCRIPT_DIR/deploy-vps.sh" "$@"
