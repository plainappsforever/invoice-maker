#!/usr/bin/env bash
# Copies the on-device PDF probe output (Settings → Debug → PDF probes) to a folder on the Mac for
# scripts/verify-pdfs.mjs. Usage: scripts/pull-pdf-probe.sh <ios|android> <dest-dir>
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
platform=${1:?Usage: pull-pdf-probe.sh <ios|android> <dest>}
dest=${2:?Usage: pull-pdf-probe.sh <ios|android> <dest>}
mkdir -p "$dest"
bundle=$(APP_VARIANT=development npx expo config --json --type public | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(process.argv[1]==="ios"?c.ios.bundleIdentifier:c.android.package)' "$platform")
device=$(scripts/boot.sh "$platform")
if [[ $platform == ios ]]; then
  cp "$(xcrun simctl get_app_container "$device" "$bundle" data)"/Documents/pdf-probe/* "$dest"/
else
  for f in $(adb -s "$device" shell run-as "$bundle" ls files/pdf-probe | tr -d '\r'); do
    adb -s "$device" exec-out run-as "$bundle" cat "files/pdf-probe/$f" >"$dest/$f"
  done
fi
ls "$dest" | wc -l | xargs echo "files copied:"
