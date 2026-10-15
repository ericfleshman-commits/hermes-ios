#!/usr/bin/env bash
# Publish the current main as an over-the-air update, only if it is safe.
# Usage: scripts/ota-publish.sh "short message"
# Gates: clean tree, in sync with origin/main, typecheck, all tests, iOS export.
# Native changes (entitlements, new native modules, runtimeVersion) still need
# a TestFlight build: OTA only replaces JavaScript and assets.
set -euo pipefail
cd "$(dirname "$0")/.."
msg="${1:?usage: scripts/ota-publish.sh \"message\"}"
[ -z "$(git status --porcelain)" ] || { echo "refusing: uncommitted changes"; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "refusing: HEAD is not origin/main (push first)"; exit 1; }
npx tsc --noEmit
npm test >/dev/null || { echo "refusing: tests failed (run npm test)"; exit 1; }
out="${TMPDIR:-/tmp}/hm-ota-export"; rm -rf "$out"
npx expo export --platform ios --output-dir "$out" >/dev/null
sha=$(git rev-parse --short HEAD)
npx --no-install eas update --channel production --environment production --platform ios \
  --message "$msg ($sha)" --non-interactive | grep -E "Update group ID|iOS update ID|Commit"
echo "Undo if needed: scripts/ota-undo.sh"
