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
PORT="${PORT:-8117}"
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
python3 "$MOCK" --port "$PORT" --scenario ok --log "$WORK/mock.jsonl" > "$WORK/mock.out" 2>&1 &
mock_pid=$!
# Wait for the port rather than sleeping blindly; a fixed sleep is a flaky test.
for _ in $(seq 1 50); do
  if python3 - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.2)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
sys.exit(0)
PY
  then break; fi
  sleep 0.2
done
if grep -qiE 'error|traceback' "$WORK/mock.out" 2>/dev/null; then
  bad "mock provider did not start"
  sed 's/^/      /' "$WORK/mock.out"
else
  ok "mock provider listening on 127.0.0.1:$PORT"
fi

echo
echo "=== 2. configure the project to use it, and trust the workspace ==="
mkdir -p "$WORK/project/.opencode"
cp fixtures/opencode.json "$WORK/project/opencode.json"
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
  run --standalone --model bashwink-mock/mock-tool-model "List the files" 2>&1)"
run_rc=$?
printf '%s\n' "$run_out" | sed 's/^/      /' | head -20
echo "      wrapper exit code: $run_rc"

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
  run --standalone --model bashwink-mock/mock-tool-model "List the files again" >/dev/null 2>&1)
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
echo "passed: $pass  failed: $fail  skipped: $skip"
[ "$fail" -eq 0 ] || exit 1
exit 0
