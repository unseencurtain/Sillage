#!/usr/bin/env bash
# Build and push stack images to Docker Hub.
#
#   ./production-environment/scripts/build-push-images.sh
#   ./production-environment/scripts/build-push-images.sh --namespace unseencurtain --tag abc1234
#
# Tags each image as :<git-sha> and :latest (unless --no-latest).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAMESPACE=""
TAG=""
PUSH_LATEST=1

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --no-latest) PUSH_LATEST=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unexpected arg: $1" >&2; usage ;;
  esac
done

if [[ -z "$NAMESPACE" ]]; then
  # Prefer docker login username; fall back to known operator namespace.
  NAMESPACE="$(docker info 2>/dev/null | sed -n 's/^ Username: //p' | head -1 || true)"
  if [[ -z "$NAMESPACE" ]] && [[ -f "${HOME}/.docker/config.json" ]]; then
    NAMESPACE="$(python3 - <<'PY'
import json, base64, pathlib
p = pathlib.Path.home()/".docker"/"config.json"
try:
    cfg = json.loads(p.read_text())
except Exception:
    raise SystemExit(0)
auths = cfg.get("auths") or {}
for key in ("https://index.docker.io/v1/", "https://index.docker.io/v1/access-token", "index.docker.io"):
    auth = (auths.get(key) or {}).get("auth")
    if auth:
        try:
            raw = base64.b64decode(auth).decode()
            print(raw.split(":", 1)[0])
            break
        except Exception:
            pass
PY
)"
  fi
  NAMESPACE="${NAMESPACE:-unseencurtain}"
fi

if [[ -z "$TAG" ]]; then
  TAG="$(git -C "$ROOT" rev-parse --short HEAD)"
fi

CORE_REPO="${NAMESPACE}/sillage-core"
WP_REPO="${NAMESPACE}/sillage-wordpress"

echo "==> namespace=${NAMESPACE} tag=${TAG}"
echo "==> build ${CORE_REPO}:${TAG}"
docker build -t "${CORE_REPO}:${TAG}" "$ROOT/production-environment/sillage-core"
echo "==> build ${WP_REPO}:${TAG}"
docker build -t "${WP_REPO}:${TAG}" "$ROOT/production-environment/wordpress-image"

if [[ "$PUSH_LATEST" -eq 1 ]]; then
  docker tag "${CORE_REPO}:${TAG}" "${CORE_REPO}:latest"
  docker tag "${WP_REPO}:${TAG}" "${WP_REPO}:latest"
fi

echo "==> push ${CORE_REPO}:${TAG}"
docker push "${CORE_REPO}:${TAG}"
echo "==> push ${WP_REPO}:${TAG}"
docker push "${WP_REPO}:${TAG}"

if [[ "$PUSH_LATEST" -eq 1 ]]; then
  docker push "${CORE_REPO}:latest"
  docker push "${WP_REPO}:latest"
fi

echo
echo "SILLAGE_CORE_IMAGE=${CORE_REPO}:${TAG}"
echo "WORDPRESS_IMAGE=${WP_REPO}:${TAG}"
if [[ "$PUSH_LATEST" -eq 1 ]]; then
  echo "# also tagged :latest"
fi
