#!/usr/bin/env bash
# Copy only the three managed vendor credentials from one existing Sillage host to another.
# WordPress data, databases, dashboard/WP logins and database secrets never leave either host.
set -euo pipefail

FROM=""
TO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2 ;;
    --to) TO="${2:?}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --from <ssh-alias> --to <ssh-alias>"
      exit 0
      ;;
    *) echo "Unexpected argument: $1" >&2; exit 2 ;;
  esac
done
: "${FROM:?required: --from <ssh-alias>}"
: "${TO:?required: --to <ssh-alias>}"
[[ "$FROM" != "$TO" ]] || { echo "Source and destination must differ" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSH_CONFIG=$("$SCRIPT_DIR/ssh-config-for-aliases.py" "$FROM" "$TO")
trap 'rm -f "$SSH_CONFIG"' EXIT
SSH=(ssh -F "$SSH_CONFIG" -o BatchMode=yes)

# Read the main env and dashboard-managed overlay remotely. JSON travels directly through the
# encrypted SSH pipe; it is never printed to the terminal or saved to the local filesystem.
SOURCE_SCRIPT=$(cat <<'SOURCE'
set -euo pipefail
set -a
source "$HOME/sillage/.env"
set +a
python3 - "$HOME/sillage/sillage-core/data/secrets.overlay.env" <<'PYTHON'
import json, os, pathlib, sys
keys = ("BEAUTYFORT_USER", "BEAUTYFORT_SECRET", "BTS_JWT_TOKEN")
data = {k: os.environ.get(k, "") for k in keys}
p = pathlib.Path(sys.argv[1])
if p.exists():
    for row in p.read_text().splitlines():
        row = row.strip()
        if not row or row.startswith("#") or "=" not in row:
            continue
        k, v = row.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if k in keys and v:
            data[k] = v
print(json.dumps(data, separators=(",", ":")))
PYTHON
SOURCE
)
DEST_CODE=$(cat <<'PYTHON'
import http.cookiejar, json, os, sys, time, urllib.error, urllib.request
values = json.load(sys.stdin)
keys = ("BEAUTYFORT_USER", "BEAUTYFORT_SECRET", "BTS_JWT_TOKEN")
if not all(values.get(k) for k in keys):
    missing = [k for k in keys if not values.get(k)]
    raise SystemExit("Source has no value for: " + ", ".join(missing))
base = "http://127.0.0.1:4000"
jar = http.cookiejar.CookieJar()
http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def request(path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with http.open(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}
for _ in range(40):
    try:
        with urllib.request.urlopen(base + "/health", timeout=2):
            break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("Sillage dashboard API did not become ready")
status, _ = request("/api/auth/login", "POST", {
    "user": os.environ.get("DASHBOARD_USER", ""),
    "password": os.environ.get("DASHBOARD_PASSWORD", ""),
})
if status != 200:
    raise SystemExit(f"Dashboard login failed (HTTP {status}); credentials were not changed")
for key in keys:
    status, result = request("/api/secrets", "PUT", {"key": key, "value": values[key]})
    if status != 200 or result.get("ok") is not True:
        raise SystemExit(f"Dashboard rejected {key} (HTTP {status}); inspect Secrets page")
status, result = request("/api/secrets")
states = {item.get("key"): item for item in result.get("secrets", [])}
for key in keys:
    item = states.get(key, {})
    if not item.get("set") or item.get("source") != "overlay":
        raise SystemExit(f"Dashboard did not confirm {key} as saved in the overlay")
print("Dashboard saved and verified 3 vendor secrets: BEAUTYFORT_USER, BEAUTYFORT_SECRET, BTS_JWT_TOKEN (values hidden).")
PYTHON
)
DEST_B64=$(printf '%s' "$DEST_CODE" | base64 -w0)
printf '%s\n' "$SOURCE_SCRIPT" | "${SSH[@]}" "$FROM" 'bash -s' | \
  "${SSH[@]}" "$TO" "cd ~/sillage && set -a && source .env && set +a && docker compose --env-file .env up -d --force-recreate sillage-core sillage-cron >/dev/null && python3 -c \"import base64; exec(base64.b64decode('$DEST_B64'))\""
