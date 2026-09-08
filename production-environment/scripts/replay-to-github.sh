#!/usr/bin/env bash
# Replay this checkout onto GitHub `unseencurtain/Sillage` main.
#
# Cursor origin and GitHub have **parallel SHAs**. Do not `git merge` or add GitHub
# as a remote on the Cursor clone. Copy files onto a fresh GitHub `main` checkout.
#
#   GITHUB_TOKEN=ghp_... ./production-environment/scripts/replay-to-github.sh
#   # or SSH: ssh -T git@github.com  then run without a token
#
# Never touches unseencurtain/sillage-b2b. Wholesale is a separate repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${REPLAY_WORKDIR:-/tmp/sillage-github-replay}"
GITHUB_SILLAGE="${GITHUB_SILLAGE_REPO:-unseencurtain/Sillage}"

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git checkout: $ROOT" >&2
  exit 1
fi

src_sha="$(git -C "$ROOT" rev-parse --short HEAD)"
src_subject="$(git -C "$ROOT" log -1 --format=%s)"

install_unseencurtain_key() {
  local keyfile="${HOME}/.ssh/unseencurtain"
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  if [[ -n "${UNSEENCURTAIN_SSH_PRIVATE_KEY:-}" && ! -f "$keyfile" ]]; then
    printf '%s\n' "$UNSEENCURTAIN_SSH_PRIVATE_KEY" >"$keyfile"
    chmod 600 "$keyfile"
  fi
  if [[ -f "$keyfile" ]]; then
    if [[ ! -f "${HOME}/.ssh/config" ]] || ! grep -q 'IdentityFile.*unseencurtain' "${HOME}/.ssh/config" 2>/dev/null; then
      cat >>"${HOME}/.ssh/config" <<'CFG'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/unseencurtain
    IdentitiesOnly yes
CFG
      chmod 600 "${HOME}/.ssh/config"
    fi
    export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i ${HOME}/.ssh/unseencurtain -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
  fi
}

push_url() {
  local repo="$1"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    printf 'https://x-access-token:%s@github.com/%s.git' "$GITHUB_TOKEN" "$repo"
  else
    printf 'git@github.com:%s.git' "$repo"
  fi
}

replay_sillage() {
  rm -rf "$WORKDIR"
  mkdir -p "$(dirname "$WORKDIR")"
  echo "==> clone github.com/${GITHUB_SILLAGE} (main only)"
  git clone --depth 1 --branch main "https://github.com/${GITHUB_SILLAGE}.git" "$WORKDIR"
  github_sha="$(git -C "$WORKDIR" rev-parse --short HEAD)"
  echo "    github HEAD ${github_sha}"
  echo "    source HEAD ${src_sha} (${src_subject})"

  echo "==> replace tree with tracked files from ${ROOT}"
  git -C "$WORKDIR" rm -r --quiet -f --ignore-unmatch .
  git -C "$ROOT" archive HEAD | tar -x -C "$WORKDIR"
  git -C "$WORKDIR" add -A

  if git -C "$WORKDIR" diff --cached --quiet; then
    echo "    GitHub main already matches this tree"
    return 0
  fi

  git -C "$WORKDIR" \
    -c user.name="${GIT_AUTHOR_NAME:-Cursor Agent}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-cursoragent@cursor.com}" \
    commit -m "$(cat <<EOF
Replay this checkout onto GitHub unseencurtain/Sillage main

Cursor origin SHA ${src_sha} (${src_subject}). GitHub was still on ${github_sha}.
Histories are parallel — files copied, remotes not merged.

Retail only (BeautyFort + BTS). Wholesale is unseencurtain/sillage-b2b.
EOF
)"
  echo "==> push ${GITHUB_SILLAGE} main"
  git -C "$WORKDIR" push "$(push_url "$GITHUB_SILLAGE")" HEAD:main
  echo "    pushed $(git -C "$WORKDIR" rev-parse --short HEAD)"
}

install_unseencurtain_key
replay_sillage
