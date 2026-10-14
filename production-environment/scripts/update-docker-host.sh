#!/usr/bin/env bash
# Update Docker Engine and the Compose plugin on an Ubuntu VPS over SSH.
# Usage: scripts/update-docker-host.sh <ssh-host-alias>
set -euo pipefail

HOST="${1:-}"
if [[ -z "$HOST" || "$HOST" == -* ]]; then
  echo "Usage: $0 <ssh-host-alias>" >&2
  exit 2
fi

ssh -F "${HOME}/.ssh/config" -o BatchMode=yes "$HOST" 'sudo apt-get update && sudo apt-get install -y --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && sudo systemctl restart docker && docker --version && docker compose version'
