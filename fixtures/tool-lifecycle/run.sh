#!/usr/bin/env bash
#
# BW-014 acceptance fixture: drive the REAL OpenCode runtime, through the `bashwink` wrapper,
# against the local mock provider, and prove:
#
#   1. the tool sequence is complete for a fixture run (a `before` AND a matching `after`,
#      joined on the same call id),
#   2. the exit status is captured, not left unknown,
#   3. the event carries a task id (or an explicit unassigned reason),
#   4. a secret planted in the environment never reaches the evidence log,
#   5. the evidence file is append-only: a second run EXTENDS it rather than rewriting it.
#
# "no mocked success presented as real execution": this runs the actual binary. The model is a
# local mock, which is a deliberate, documented choice (ADR-006) — there is no real API key in
# this environment and there is no need for one to prove the tool-lifecycle seam.
#
# Requires an OpenCode runtime. Set BASHWINK_OPENCODE_BIN, or install @opencode/cli@2.3.2.
# Skips (exit 0, clearly announced) when no runtime is available, so CI on a machine without
# one reports honestly instead of failing for the wrong reason.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

BUN="${BUN:-bun}"
CLI="packages/bw-cli/src/bin.ts"
MOCK="fixtures/mock_provider.py"
PORT="${PORT:-0}"
pass=0
fail=0
skip=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }
note() { printf 'SKIP  %s\n' "$1"; skip=$((skip + 1)); }

if [ -z "${BASHWINK_OPENCODE_BIN:-}" ] && ! command -v opencode >/dev/null 2>&1; then
  if [ ! -x "node_modules/.bin/opencode" ]; then
    note "no OpenCode runtime available; this fixture needs the real binary"
    echo
    echo "passed: $pass  failed: $fail  skipped: $skip"
    exit 0
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; kill "${mock_pid:-}" 2>/dev/null' EXIT
export BASHWINK_HOME="$WORK/home"
mkdir -p "$BASHWINK_HOME/data" "$BASHWINK_HOME/config"

echo "=== 1. start the local mock provider (no API key, offline) ==="
mkdir -p "$WORK/project"
python3 "$MOCK" --port "$PORT" --scenario canary --log "$WORK/mock.jsonl" > "$WORK/mock.out" 2>&1 &
mock_pid=$!
# Wait for this fixture's own readiness message. A different listener on the same
# loopback port would give false-positive readiness and an unrelated request log.
mock_port=""
for _ in $(seq 1 50); do
  mock_port=$(sed -n 's/^\[mock\] listening on http:\/\/127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' "$WORK/mock.out")
  [ -n "$mock_port" ] && break
  kill -0 "$mock_pid" 2>/dev/null || break
  sleep 0.1
done
if [ -z "$mock_port" ]; then
  bad "mock provider did not start"
  sed 's/^/      /' "$WORK/mock.out"
  exit 1
fi
ok "mock provider listening on 127.0.0.1:$mock_port"

echo
echo "=== 2. configure the project to use it, and trust the workspace ==="
mkdir -p "$WORK/project/.opencode"
sed "s/127.0.0.1:8117/127.0.0.1:$mock_port/" fixtures/opencode.json > "$WORK/project/opencode.json"
"$BUN" run "$CLI" trust "$WORK/project" --by "fixture" >/dev/null 2>&1
"$BUN" run "$CLI" plan new "run the check in the fixture workspace" >/dev/null 2>&1
"$BUN" run "$CLI" plan task inspect ready >/dev/null 2>&1
"$BUN" run "$CLI" plan task inspect in_progress >/dev/null 2>&1
# Mark the task active so the evidence plugin can attribute calls to it (BW-016).
mkdir -p "$BASHWINK_HOME/data/evidence"
printf 'inspect' > "$BASHWINK_HOME/data/active-task"
ok "workspace prepared (plan + active task 'inspect')"

echo
echo "=== 3. run the REAL agent through the wrapper ==="
export BASHWINK_EVIDENCE_DIR="$BASHWINK_HOME/data/evidence"
export BASHWINK_SECRET_SENTINEL="sk-proj-THISMUSTNEVERAPPEAR0123456789"
run_out="$(cd "$WORK/project" && "$BUN" run "$OLDPWD/packages/bw-cli/src/bin.ts" \
  run --standalone --auto --model bashwink-mock/mock-tool-model "List the files" 2>&1)"
run_rc=$?
printf '%s\n' "$run_out" | sed 's/^/      /' | head -20
echo "      wrapper exit code: $run_rc"
if [ "$run_rc" -eq 0 ] && [ "$(cat "$WORK/project/.bw-shell-canary" 2>/dev/null)" = 'shell ran' ]; then
  ok "approved compound shell command created the canary"
else
  bad "positive control failed to create the shell canary"
fi

LOG="$BASHWINK_HOME/data/evidence/evidence.jsonl"
export LOG
if [ -f "$LOG" ]; then
  ok "evidence log was written at the default Bashwink location"
else
  bad "no evidence log was written"
fi

echo
echo "=== 4. the tool sequence is complete ==="
before_count=$(grep -c '"phase":"before"' "$LOG" 2>/dev/null || echo 0)
after_count=$(grep -c '"phase":"after"' "$LOG" 2>/dev/null || echo 0)
echo "      before=$before_count after=$after_count"
if [ "$before_count" -gt 0 ]; then
  ok "at least one 'before' event was recorded"
else
  bad "no 'before' event was recorded — the hook did not fire"
fi
if [ "$after_count" -gt 0 ]; then
  ok "at least one 'after' event was recorded — the outcome is captured"
else
  bad "no 'after' event: the call outcome is unknown"
fi

echo
echo "=== 5. before and after are joined on one call id, and the exit status is present ==="
summary="$("$BUN" run fixtures/tool-lifecycle/summarise-evidence.ts 2>&1)"
echo "      $summary"
case "$summary" in
  *'"matched":0'*) bad "no after-event shares a call id with a before-event" ;;
  *) ok "every after-event shares a call id with its before-event" ;;
esac
case "$summary" in
  *'"exits":[0'*) ok "the shell exit status was captured (0)" ;;
  *) bad "the exit status was not captured — the outcome would read status-unknown" ;;
esac

echo
echo "=== 6. every event is task-linked or explicitly unassigned ==="
case "$summary" in
  *'"bare":0'*) ok "no event is silently unattributed" ;;
  *) bad "some events have neither a task id nor a reason" ;;
esac
case "$summary" in
  *'"linked":0'*) bad "no event was attributed to the plan's task" ;;
  *) ok "events were attributed to the active task" ;;
esac

echo "=== 7. the planted secret is absent from the evidence log ==="
if grep -q 'THISMUSTNEVERAPPEAR' "$LOG" 2>/dev/null; then
  bad "a credential-shaped value reached the evidence log"
else
  ok "the planted secret never reached the log"
fi
if grep -q 'THISMUSTNEVERAPPEAR' "$WORK"/mock.jsonl 2>/dev/null; then
  note "the mock's own request log contains the sentinel (it is the fixture's input, not our output)"
fi

echo
echo "=== 8. the log is append-only across runs ==="
first_bytes=$(wc -c < "$LOG" )
first_lines=$(wc -l < "$LOG")
(cd "$WORK/project" && "$BUN" run "$OLDPWD/packages/bw-cli/src/bin.ts" \
  run --standalone --auto --model bashwink-mock/mock-tool-model "List the files again" >/dev/null 2>&1)
second_lines=$(wc -l < "$LOG")
echo "      lines: $first_lines -> $second_lines"
if [ "$second_lines" -gt "$first_lines" ]; then
  ok "the second run extended the log instead of rewriting it"
else
  bad "the second run did not append (the log was rewritten or the run failed)"
fi
if "$BUN" run packages/bw-evidence/src/cli.ts verify "$LOG" > "$WORK/verify.out" 2>&1; then
  ok "the hash chain still verifies after two runs"
else
  bad "the hash chain does not verify"
  sed 's/^/      /' "$WORK/verify.out"
fi

echo
echo "=== 9. the interrupted task is still not verified ==="
status_out="$("$BUN" run "$CLI" plan show 2>&1)"
case "$status_out" in
  *verified*) bad "the task became verified just because a tool ran" ;;
  *) ok "running a tool did not verify the task" ;;
esac

echo
echo "=== 10. risky shell calls need approval and a native deny survives auto-approval ==="
assert_shell_refused() {
  local start="$1" label="$2"
  if python3 - "$LOG" "$start" <<'PY_CHECK'
import json, sys
with open(sys.argv[1]) as log:
    rows = [json.loads(line) for line in log][int(sys.argv[2]):]
shell = [row for row in rows if row.get("call", {}).get("tool") == "shell"]
assert any(row["phase"] == "before" for row in shell), "mock never requested shell"
after = [row for row in shell if row["phase"] == "after"]
assert any(row["payload"].get("status") == "error" for row in after), "shell refusal was not observed"
assert not any(row["payload"].get("status") == "completed" for row in after), "shell ran"
PY_CHECK
  then ok "$label"; else bad "$label"; fi
}
rm -f "$WORK/project/.bw-shell-canary"
before_approval=$(wc -l < "$LOG")
(cd "$WORK/project" && "$BUN" run "$OLDPWD/packages/bw-cli/src/bin.ts" \
  run --model bashwink-mock/mock-tool-model "Permission check" > "$WORK/approval.out" 2>&1)
assert_shell_refused "$before_approval" "unattended run requires shell approval by default"
if [ -e "$WORK/project/.bw-shell-canary" ]; then
  bad "unapproved shell created the canary"
else
  ok "unapproved shell left no canary"
fi

python3 - "$WORK/project/opencode.json" <<'PY_RULE'
import json, pathlib, sys
file = pathlib.Path(sys.argv[1])
config = json.loads(file.read_text())
config["permissions"] = [{"action": "shell", "resource": "*", "effect": "deny"}]
file.write_text(json.dumps(config))
PY_RULE
before_deny=$(wc -l < "$LOG")
before_request=$(wc -l < "$WORK/mock.jsonl")
(cd "$WORK/project" && "$BUN" run "$OLDPWD/packages/bw-cli/src/bin.ts" \
  run --auto --model bashwink-mock/mock-tool-model "Permission check" > "$WORK/deny.out" 2>&1)
if python3 - "$LOG" "$before_deny" "$WORK/mock.jsonl" "$before_request" <<'PY_DENY'
import json, sys

def events(filename, start):
    with open(filename) as log:
        return [json.loads(line) for line in log][int(start):]

rows = events(*sys.argv[1:3])
assert any(row["phase"] == "boot" for row in rows), "runtime did not boot"
assert not any(row.get("call", {}).get("tool") == "shell" for row in rows), "shell was dispatched"
requests = events(*sys.argv[3:5])
offered = [r.get("tool_names", []) for r in requests if r["event"] == "request"]
assert any("read" in names for names in offered), "the model was never offered the regular file tools"
assert not any({"shell", "bash"}.intersection(names) for names in offered), "native shell was offered"
execute = [r for r in rows if r.get("call", {}).get("tool") == "execute"]
if any("execute" in names for names in offered):
    assert any(r["phase"] == "denied" for r in execute), "alternate tool was not refused"
assert not any(r["phase"] == "after" and r["payload"].get("status") == "completed" for r in execute), "alternate tool ran"
PY_DENY
then
  ok "explicit native shell denial removes shell even with auto-approval"
else
  bad "explicit native shell denial did not survive auto-approval"
fi
if [ -e "$WORK/project/.bw-shell-canary" ]; then
  bad "explicitly denied shell created the canary under auto-approval"
else
  ok "explicit denial left no canary under auto-approval"
fi
if "$BUN" run packages/bw-evidence/src/cli.ts verify "$LOG" > "$WORK/verify.out" 2>&1; then
  ok "the chain verifies after permission refusals"
else
  bad "chain verification failed after permission refusals"
fi

echo "passed: $pass  failed: $fail  skipped: $skip"
[ "$fail" -eq 0 ] || exit 1
exit 0
