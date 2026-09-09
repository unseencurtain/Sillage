#!/usr/bin/env bash
#
# Label what a stack is for. Run it in the stack directory, on the box.
#
#   cd ~/sillage && bash scripts/set-role.sh development
#   cd ~/sillage && bash scripts/set-role.sh production
#   bash scripts/set-role.sh                              # print the current label and stop
#
# A role belongs to a deployment, not to a machine. Any box can hold either role, both boxes can
# hold the same one, and boxes get rebuilt, packed and swapped constantly.
#
# What the role changes, and it is genuinely nothing at runtime: the engine never reads it. Both
# roles run the same image, the same compose file, the same bind mounts, and the same two vendor
# APIs on the same credentials — neither wholesaler has a sandbox, so a "development" stack is a
# real client of the real API and always was. A stack that behaved differently would not be testing
# production. Dispatch is decided by the Orders page Dry-run / Live choice on every stack.
#
# The label exists so deploy-vps.sh can tell that ~/sillage on this box is the live shop and refuse
# to redeploy the other role over it without --switch-role. That is its whole job.
set -euo pipefail

[[ -f .env && -f compose.yaml ]] || {
  echo "run this from a stack directory (the one holding .env and compose.yaml)" >&2; exit 1; }

WANT="${1:-}"

current() { grep -E '^SILLAGE_ROLE=' .env | tail -1 | cut -d= -f2- || true; }
NOW="$(current)"
[[ -n "$NOW" ]] || NOW="unlabelled (deploys treat it as production)"

if [[ -z "$WANT" ]]; then
  echo "$(basename "$PWD"): $NOW"
  exit 0
fi

case "$WANT" in
  production|development) ;;
  *) echo "role must be production or development, not \"$WANT\"" >&2; exit 1 ;;
esac

python3 - "$WANT" <<'PY'
import re, sys, pathlib
want = sys.argv[1]
p = pathlib.Path(".env")
out, seen = [], False
for line in p.read_text().splitlines():
    # SILLAGE_DEV_BOX was the old form of this label, back when it also refused live dispatch.
    # Drop it rather than carry a second answer to the same question.
    if re.match(r"^SILLAGE_DEV_BOX=", line):
        continue
    if re.match(r"^SILLAGE_ROLE=", line):
        if seen:
            continue
        out.append(f"SILLAGE_ROLE={want}"); seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"SILLAGE_ROLE={want}")
p.write_text("\n".join(out) + "\n")
PY

echo "$(basename "$PWD"): $WANT"
echo "  label only — dispatch still follows the Orders page on either role"
exit 0
