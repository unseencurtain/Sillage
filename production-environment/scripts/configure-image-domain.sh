#!/usr/bin/env bash
# Persist the public image host in the VPS env and the authenticated Sillage settings store.
set -euo pipefail
ENV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST=""
DOMAIN=""
while (($#)); do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    -h|--help) echo "Usage: $0 --host <ssh-alias> --domain images.example.com"; exit 0 ;;
    *) echo "Unexpected argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$HOST" && "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--host SSH alias is required" >&2; exit 2; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid image domain" >&2; exit 2; }
SSH_CONFIG="$(python3 "$ENV_ROOT/scripts/ssh-config-for-aliases.py" "$HOST")"
trap 'rm -f "$SSH_CONFIG"' EXIT
ssh -F "$SSH_CONFIG" -o BatchMode=yes "$HOST" "IMAGE_DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/sillage"
python3 - "$IMAGE_DOMAIN" <<'PY'
import pathlib, re, sys
domain = sys.argv[1]
path = pathlib.Path('.env')
lines = path.read_text().splitlines()
updates = {'IMAGES_DOMAIN': domain, 'LPS_MEDIA_BASE_URL': f'https://{domain}'}
for key, value in updates.items():
    pattern = re.compile(r'^\s*#?\s*' + re.escape(key) + r'\s*=')
    matches = [i for i, line in enumerate(lines) if pattern.match(line)]
    new = f'{key}={value}'
    if matches:
        first = matches[0]
        lines[first] = new
        for idx in reversed(matches[1:]):
            del lines[idx]
    else:
        lines.append(new)
path.write_text('\n'.join(lines) + '\n')
PY
set -a
source .env
set +a
python3 - "$IMAGE_DOMAIN" <<'PY'
import http.cookiejar, json, os, sys, time, urllib.error, urllib.request
domain = sys.argv[1]
base = 'http://127.0.0.1:4000'
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def request(path, method='GET', body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
        headers={'Content-Type': 'application/json'} if data is not None else {})
    try:
        with client.open(req, timeout=15) as response:
            return response.status, json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b'{}')
for _ in range(30):
    try:
        with urllib.request.urlopen(base + '/health', timeout=2): break
    except Exception: time.sleep(1)
else: raise SystemExit('Sillage API is not healthy')
status, _ = request('/api/auth/login', 'POST', {'user': os.environ.get('DASHBOARD_USER', ''), 'password': os.environ.get('DASHBOARD_PASSWORD', '')})
if status != 200: raise SystemExit(f'Dashboard login failed (HTTP {status})')
status, result = request('/api/settings', 'PUT', {'image_cdn_base_url': f'https://{domain}'})
if status != 200 or result.get('ok') is not True: raise SystemExit(f'Image URL setting failed (HTTP {status})')
status, settings = request('/api/settings')
if status != 200 or settings.get('image_cdn_base_url', '').rstrip('/') != f'https://{domain}':
    raise SystemExit('Dashboard did not return the requested image base URL')
print('Dashboard image base URL saved and verified; value: https://' + domain)
PY
REMOTE
