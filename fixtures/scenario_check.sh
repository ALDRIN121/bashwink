#!/usr/bin/env bash
# Phase 0 acceptance: exercise the cancellation and rollback fixtures for real.
#
# Independent review / gate criterion: "killing the process does not claim an unfinished
# test passed or double-apply a patch". Previously these two fixtures were created and
# reset but their *scenarios* were never run, so the criterion was unverified.
#
# This script proves, with observable state, that:
#   1. cancellation: a SIGKILL mid-run leaves partial work and NO claim of completion, and
#      the fixture can be reset to baseline afterwards.
#   2. rollback: a mutation is applied, then reverted byte-for-byte to the baseline commit.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$REPO/fixtures"
pass=0; fail=0
ok()   { echo "PASS  $*"; pass=$((pass+1)); }
bad()  { echo "FAIL  $*"; fail=$((fail+1)); }

echo "=== cancellation fixture: kill mid-run ==="
cd "$FIX/cancellation" || exit 1
./../reset.sh cancellation >/dev/null 2>&1 || { bad "could not reset cancellation"; }
rm -f step-*.txt

# Start the 5-step scenario (1s per step), kill it partway through.
bash steps.sh >/tmp/cancel.out 2>&1 &
pid=$!
sleep 2.5
kill -9 "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
killed_status=$?

steps_done=$(ls step-*.txt 2>/dev/null | wc -l | tr -d ' ')
echo "  steps completed before kill: $steps_done / 5 (kill status $killed_status)"

if [ "$steps_done" -ge 1 ] && [ "$steps_done" -lt 5 ]; then
  ok "cancellation: partial work exists and no completion was reached"
else
  bad "cancellation: expected 1..4 steps completed, saw $steps_done"
fi

# The critical assertion: no completion marker was produced.
if [ -f step-5.txt ]; then
  bad "cancellation: step-5 exists — the run claimed completion despite being killed"
else
  ok "cancellation: step-5 absent — killed run did NOT claim completion"
fi

# Working tree must be dirty (partial work left behind), which is what a resumed run sees.
if git -C "$FIX/cancellation" status --porcelain | grep -q 'step-'; then
  ok "cancellation: partial artifacts are visible to a resumed process"
else
  bad "cancellation: no partial artifacts detected"
fi

# And it must reset cleanly.
"$FIX/reset.sh" cancellation >/tmp/cancel-reset.log 2>&1
if git -C "$FIX/cancellation" status --porcelain | grep -q .; then
  bad "cancellation: fixture did not reset to a clean tree"
else
  ok "cancellation: fixture resets to a clean baseline after the kill"
fi

echo
echo "=== rollback fixture: mutate then revert byte-for-byte ==="
cd "$FIX/rollback" || exit 1
"$FIX/reset.sh" rollback >/dev/null 2>&1

before_hash=$(git -C "$FIX/rollback" rev-parse HEAD)
before_blob=$(shasum -a 256 src/config.js | awk '{print $1}')
echo "  baseline tree: $before_hash"
echo "  baseline blob: ${before_blob:0:16}…"

bash mutate.sh
after_blob=$(shasum -a 256 src/config.js | awk '{print $1}')
if [ "$before_blob" != "$after_blob" ]; then
  ok "rollback: mutation actually changed the file"
else
  bad "rollback: mutation did not change the file"
fi

if grep -q "retries: 99" src/config.js; then
  ok "rollback: mutated content is present as expected"
else
  bad "rollback: mutated content missing"
fi

# Revert and prove byte-for-byte restoration.
git -C "$FIX/rollback" checkout -- src/config.js
after_revert=$(shasum -a 256 src/config.js | awk '{print $1}')
if [ "$after_revert" = "$before_blob" ]; then
  ok "rollback: reverted file is byte-identical to baseline"
else
  bad "rollback: reverted file differs from baseline ($before_blob vs $after_revert)"
fi

if [ "$(git -C "$FIX/rollback" status --porcelain | wc -l | tr -d ' ')" = "0" ]; then
  ok "rollback: working tree clean after revert"
else
  bad "rollback: working tree dirty after revert"
fi

echo
echo "=== summary ==="
echo "  passed: $pass"
echo "  failed: $fail"
[ "$fail" -eq 0 ] || exit 1
