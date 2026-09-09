#!/usr/bin/env bash
#
# Make a copy of this whole box, for you to download.
#
#   ssh <box>
#   ./pack.sh
#
# Lives in the home folder because that is where you land, and because the thing it produces is
# something a person decides to make — before a risky change, before wiping a box, before handing
# one over. Nothing runs it on a timer.
#
# What comes out is one file, ~/box-<date>.tar.gz, holding every stack directory: WordPress, both
# databases, the product photos, the .env files, the scripts, and /etc/caddy. Put that file on a
# blank VPS, untar it, run adopt-box.sh, and the shop is back. Both shops stay up while it runs.
#
# It keeps the newest three and deletes older ones, so this cannot fill the disk.
set -euo pipefail

for d in "$HOME"/*/; do
  if [[ -x "${d}scripts/pack-box.sh" || -f "${d}scripts/pack-box.sh" ]]; then
    exec bash "${d}scripts/pack-box.sh" --live --keep 3 "$@"
  fi
done

echo "No stack found in $HOME with scripts/pack-box.sh — is this a Sillage box?" >&2
exit 1
