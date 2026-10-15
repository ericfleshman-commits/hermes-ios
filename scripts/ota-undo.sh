#!/usr/bin/env bash
# Undo a bad over-the-air update in one command.
#   scripts/ota-undo.sh            republish the previous update group
#   scripts/ota-undo.sh <group>    republish a specific known-good group
#   scripts/ota-undo.sh --embedded go back to the JS built into the installed app
# Phones pick it up on their next two launches (download, then run).
# Note: updates published before 2026-10-11 never reached a phone (the channel
# was unlinked); the first one that did is 5a15b741-a99a-48a8-88d0-31e4e23ecba4.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--embedded" ]; then
  exec npx --no-install eas update:roll-back-to-embedded --channel production --platform ios \
    --message "roll back to embedded" --non-interactive
fi
group="${1:-}"
if [ -z "$group" ]; then
  group=$(npx --no-install eas update:list --branch production --json --non-interactive 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read(); i = min(x for x in (raw.find("{"), raw.find("[")) if x >= 0)
d = json.loads(raw[i:]); rows = d.get("currentPage", d) if isinstance(d, dict) else d
print(rows[1]["group"])')
fi
echo "Republishing update group $group to channel production"
npx --no-install eas update:republish --group "$group" --destination-channel production --platform ios \
  --message "undo: republish $group" --non-interactive
