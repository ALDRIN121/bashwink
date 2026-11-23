#!/usr/bin/env bash
#
# BW-055 acceptance fixture: TaskContract / IntentLock data plane.
#
# Walks the lifecycle a person actually uses, in a throwaway home and a real git repo:
#
#   plan -> contract (draft) -> start refused -> approve -> start allowed
#        -> observe a check pass -> criterion passed with linked evidence
#        -> revise the contract, dropping a criterion -> dropped, evidence kept
#        -> re-add the dropped id -> refused
#
# No model and no network: this is the data plane, and every assertion is on real CLI output
# and real exit codes.
#
# Usage: ./fixtures/contract/run.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO="$PWD"
BUN="${BUN:-bun}"
CLI="$REPO/packages/bw-cli/src/bin.ts"
pass=0
fail=0
ok()  { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
export BASHWINK_HOME="$WORK/home"
PROJECT="$WORK/project"
mkdir -p "$PROJECT"
cli() { (cd "$PROJECT" && "$BUN" run "$CLI" "$@" 2>&1); }
cli_rc() { (cd "$PROJECT" && "$BUN" run "$CLI" "$@" >/dev/null 2>&1); printf '%s' "$?"; }

git -C "$PROJECT" init -q
git -C "$PROJECT" config user.email "fixture@bashwink.invalid"
git -C "$PROJECT" config user.name "Bashwink Fixture"
printf 'hello\n' > "$PROJECT/greeting.txt"
git -C "$PROJECT" add greeting.txt
git -C "$PROJECT" commit -qm "baseline"
BASE=$(git -C "$PROJECT" rev-parse HEAD)

echo "=== 1. create a plan and a derived contract ==="
cli plan new "greet the user" --files=greeting.txt >/dev/null
out=$(cli contract new --base "$BASE" --forbid fixtures --negative "must not touch fixture baselines")
echo "$out" | sed 's/^/      /'
case "$out" in
  *"revision 1 (draft)"*) ok "contract starts at revision 1, draft" ;;
  *) bad "contract was not created as a draft at revision 1" ;;
esac
case "$out" in
  *"3 required"*) ok "every declared check became a required criterion" ;;
  *) bad "criteria were not derived as required" ;;
esac

echo
echo "=== 2. starting work under a draft contract is refused ==="
cli plan task inspect ready >/dev/null
out=$(cli plan task inspect in_progress)
rc=$?
echo "      $out" | head -3 | sed 's/^/      /'
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "approve it before starting work"; then
  ok "draft contract blocks execution with an actionable reason"
else
  bad "draft contract did not block execution (exit $rc)"
fi

echo
echo "=== 3. approval unlocks execution, and the contract records who approved ==="
out=$(cli contract approve --by "Aldrin")
echo "      $out" | sed 's/^/      /'
case "$out" in
  *"approved"*) ok "contract approval recorded" ;;
  *) bad "approval was not recorded" ;;
esac
rc=$(cli_rc plan task inspect in_progress)
if [ "$rc" -eq 0 ]; then ok "approved contract permits work to start"; else bad "approved contract still blocked (exit $rc)"; fi

echo
echo "=== 4. an observation moves the criterion and links its evidence ==="
cli plan observe inspect inspect-files-exist pass --exit 0 >/dev/null
status=$(cli contract status --json)
printf '%s' "$status" > "$WORK/status.json"
python3 - "$WORK/status.json" <<'PY' > "$WORK/check.out" 2>&1
import json, sys
data = json.load(open(sys.argv[1]))
row = next(r for r in data["criteria"] if r["id"] == "inspect.inspect-files-exist")
print(row["status"], len(row["evidence"]), row["evidence"][0].get("observationId"))
PY
read -r cstatus cevidence cobs < "$WORK/check.out"
echo "      criterion=$cstatus evidence=$cevidence observation=$cobs"
if [ "$cstatus" = "passed" ] && [ "$cevidence" = "1" ] && [ "${cobs:-0}" -gt 0 ]; then
  ok "criterion passed, with one linked observation"
else
  bad "criterion status/evidence link is wrong"
fi
if [ "$(cli_rc plan task inspect verified)" -ne 0 ]; then
  ok "one passing check is not enough to verify the whole task"
else
  bad "the task verified after one of its three checks passed"
fi

echo
echo "=== 5. revising the contract drops a criterion without deleting it ==="
cat > "$WORK/rev2.json" <<'JSON'
{
  "objective": "greet the user",
  "allowedPaths": ["greeting.txt"],
  "forbiddenPaths": ["fixtures"],
  "negativeRequirements": ["must not touch fixture baselines"],
  "criteria": [
    {"id": "implement.implement-diff-present", "statement": "the working tree differs from HEAD", "required": true, "task": "implement", "check": "implement-diff-present"},
    {"id": "verify.verify-tests-pass", "statement": "the evidence suite passes", "required": true, "task": "verify", "check": "verify-tests-pass"}
  ]
}
JSON
out=$(cli contract revise --file "$WORK/rev2.json" --reason "inspect is covered by review")
echo "      $out" | sed 's/^/      /'
case "$out" in
  *"1 dropped (kept, not deleted)"*) ok "revision reports the dropped criterion" ;;
  *) bad "revision did not report the drop" ;;
esac
cli contract status --json > "$WORK/rev2-status.json"
python3 - "$WORK/rev2-status.json" <<'PY' > "$WORK/drop.out" 2>&1
import json, sys
data = json.load(open(sys.argv[1]))
row = next(r for r in data["criteria"] if r["id"] == "inspect.inspect-files-exist")
print(f"{row['status']}|{row.get('statusReason','')}|{len(row['evidence'])}|{data['revision']}|{data['approval']}")
PY
IFS='|' read -r dstatus dreason devidence drev dappr < "$WORK/drop.out"
echo "      dropped=$dstatus revision=$drev approval=$dappr evidence=$devidence"
if [ "$dstatus" = "dropped" ] && [ "$devidence" = "1" ] && [ "$drev" = "2" ]; then
  ok "the dropped criterion kept its status and its evidence"
else
  bad "the dropped criterion lost its status or evidence"
fi
if printf '%s' "$dreason" | grep -q "inspect is covered by review"; then
  ok "the drop records why it happened"
else
  bad "the drop has no reason"
fi
if [ "$dappr" = "draft" ]; then
  ok "a content revision resets approval to draft"
else
  bad "a revision inherited approval it was never given"
fi

echo
echo "=== 6. a dropped criterion cannot be re-added under the same id ==="
cat > "$WORK/rev3.json" <<'JSON'
{
  "objective": "greet the user",
  "allowedPaths": ["greeting.txt"],
  "criteria": [
    {"id": "inspect.inspect-files-exist", "statement": "every target file exists", "required": true, "task": "inspect", "check": "inspect-files-exist"}
  ]
}
JSON
out=$(cli contract revise --file "$WORK/rev3.json" --reason "put inspect back")
rc=$?
echo "      $out" | sed 's/^/      /'
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "cannot be re-added"; then
  ok "re-adding a dropped id is refused cleanly (exit 1, not a crash)"
else
  bad "re-adding a dropped id was not refused cleanly (exit $rc)"
fi

echo
echo "=== 7. a revision citing an undeclared check is refused ==="
cat > "$WORK/bad.json" <<'JSON'
{"criteria": [{"id": "inspect.invented", "statement": "invented", "required": true, "task": "inspect", "check": "no-such-check"}]}
JSON
out=$(cli contract revise --file "$WORK/bad.json" --reason "attempt an unevidenceable criterion")
rc=$?
echo "      $(printf '%s' "$out" | head -2)" | sed 's/^/      /'
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "declares no check"; then
  ok "an unevidenceable criterion is refused before it is stored"
else
  bad "an unevidenceable criterion was accepted (exit $rc)"
fi

echo
echo "=== 8. the store survives a restart and keeps the revision history ==="
out=$(cli contract show --json)
printf '%s' "$out" > "$WORK/show.json"
python3 - "$WORK/show.json" <<'PY' > "$WORK/revisions.out" 2>&1
import json, sys
data = json.load(open(sys.argv[1]))
print(len(data["revisions"]), data["contract"]["revision"])
PY
read -r count rev < "$WORK/revisions.out"
echo "      revisions=$count current=$rev"
if [ "$count" = "2" ] && [ "$rev" = "2" ]; then
  ok "both revisions and the current revision read back from disk"
else
  bad "revision history did not survive the process boundary"
fi

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
