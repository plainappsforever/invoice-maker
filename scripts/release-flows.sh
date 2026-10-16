#!/usr/bin/env bash
# Runs the Release flows (.maestro/release/) in their required order on the installed preview build, one Maestro run per
# flow so the order is fixed, and prints a pass/fail line per flow. Usage: scripts/release-flows.sh <ios|android> [flow ...]
# The first flow (upgrade-start) empties the app with its own "Delete all data", so the run needs no uninstall.
set -uo pipefail
cd "$(dirname "$0")/.."
platform=${1:?Usage: release-flows.sh <ios|android> [flow ...]}
shift
ORDER=(upgrade-start zero-prompt repeat-invoice pdf-share print csv-export about-privacy check-dates autosave-forms payments-cancel cold-start backup-delete numbering-continues)
flows=("$@")
[[ ${#flows[@]} -gt 0 ]] || flows=("${ORDER[@]}")
pass=0
fail=0
for f in "${flows[@]}"; do
  if scripts/e2e.sh "$platform" preview ".maestro/release/$f.yaml" > "artifacts/maestro/release-$platform-$f.log" 2>&1; then
    echo "PASS $f"
    pass=$((pass + 1))
  else
    echo "FAIL $f (log: artifacts/maestro/release-$platform-$f.log)"
    fail=$((fail + 1))
  fi
done
echo "Release flows on $platform: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
