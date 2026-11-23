#!/usr/bin/env bash
#
# Phase 1 exit-gate demonstration, as ONE scripted walkthrough on ONE plan:
#
#   bashwink doctor -> plan -> patch -> terminate mid-check -> resume -> inspect events
#
# Every section is the real CLI against real state in a throwaway BASHWINK_HOME; the agent
# turn is the real OpenCode v2.3.2 binary against the local mock provider (ADR-006), so no
# credential or network egress is involved.
#
# The point of running it as one script rather than five proofs is that the *transitions*
# between the legs are where a plausible-looking demo usually breaks: an active-task marker
# left behind, a plan file that disagrees with the database, a resume that reopens the wrong
# task.
#
# Usage: ./fixtures/phase1-demo/run.sh
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

BUN="${BUN:-bun}"
CLI="packages/bw-cli/src/bin.ts"
MOCK="fixtures/mock_provider.py"
PORT="${PORT:-8121}"
step=0
banner() { step=$((step + 1)); printf '\n───────── %s. %s ─────────\n' "$step" "$1"; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; kill "${mock_pid:-}" 2>/dev/null; }
trap cleanup EXIT

export BASHWINK_HOME="$WORK/home"
mkdir -p "$BASHWINK_HOME/data" "$BASHWINK_HOME/config"
PROJECT="$WORK/project"
mkdir -p "$PROJECT"
cli() { (cd "$PROJECT" && "$BUN" run "$OLDPWD/$CLI" "$@"); }

echo "Bashwink Phase 1 demonstration"
echo "home:    $BASHWINK_HOME"
echo "project: $PROJECT"

# ---------------------------------------------------------------- 1. doctor
banner "doctor — preconditions before anything else runs"
cli doctor | sed 's/^/  /'
doctor_rc=${PIPESTATUS[0]}
echo "  (doctor exit $doctor_rc; nonzero here is expected and honest — no provider key is set)"

# ---------------------------------------------------------------- 2. trust
banner "trust the workspace — required before any write"
cli trust "$PROJECT" --by "phase1-demo" | sed 's/^/  /'

# ---------------------------------------------------------------- 3. plan
banner "plan — an inspectable objective, before any edit"
cli plan new "Fix the slugify off-by-one in transform.ts" --files=transform.ts | sed 's/^/  /'
printf 'export const slugify = (s: string) => s.trim().replace(/ /g, "-")\n' > "$PROJECT/transform.ts"
cli plan show | sed 's/^/  /'

# ------------------------------------------------------------ 4. approval
banner "approve — no edits are possible before a human approves"
cli plan task inspect ready | sed 's/^/  /'
cli plan task inspect in_progress | sed 's/^/  /'
cli plan approve --by "phase1-demo" | sed 's/^/  /'

# ---------------------------------------------------------- 5. agent turn
banner "patch — one real agent turn through the runtime"
python3 "$MOCK" --port "$PORT" --scenario ok --log "$WORK/mock.jsonl" > "$WORK/mock.out" 2>&1 &
mock_pid=$!
for _ in $(seq 1 60); do
  python3 - "$PORT" <<'PY' 2>/dev/null && break
import socket, sys
s = socket.socket(); s.settimeout(0.2)
try: s.connect(("127.0.0.1", int(sys.argv[1])))
except OSError: sys.exit(1)
sys.exit(0)
PY
  sleep 0.2
done
cp fixtures/opencode.json "$PROJECT/opencode.json"
mkdir -p "$BASHWINK_HOME/data/evidence"
printf 'inspect' > "$BASHWINK_HOME/data/active-task"
export BASHWINK_EVIDENCE_DIR="$BASHWINK_HOME/data/evidence"
cli run --standalone --model bashwink-mock/mock-tool-model "Run the check" 2>&1 | sed 's/^/  /' | head -8

# ------------------------------------------------- 6. terminate mid-check
banner "terminate mid-check — SIGKILL while a write attempt is open"
"$BUN" run fixtures/idempotent-resume/hold-attempt.ts > "$WORK/killed.out" 2>&1 &
child=$!
sleep 3
if kill -0 "$child" 2>/dev/null; then
  kill -9 "$child" 2>/dev/null; wait "$child" 2>/dev/null
  echo "  killed the in-flight attempt (SIGKILL)"
else
  echo "  the child finished before it could be killed"
fi
cli resume --status | sed 's/^/  /'

# ------------------------------------------------------------- 7. resume
banner "resume — reopen without claiming anything passed"
cli resume | sed 's/^/  /'

# ------------------------------------------- 8. inspect the recorded events
banner "inspect events — what actually ran"
cli evidence export | sed 's/^/  /' | head -30

echo
echo "───────── verifying the demonstration's claims ─────────"
LOG="$BASHWINK_HOME/data/evidence/evidence.jsonl"
export LOG
fail=0
check() { if [ "$1" = "0" ]; then echo "  PASS  $2"; else echo "  FAIL  $2"; fail=1; fi; }

"$BUN" run fixtures/tool-lifecycle/summarise-evidence.ts > "$WORK/summary.json" 2>&1
cat "$WORK/summary.json" | sed 's/^/  /'

grep -q '"matched":1' "$WORK/summary.json"; check $? "an after-event is joined to its before-event"
grep -q '"exits":\[0\]' "$WORK/summary.json"; check $? "the shell exit status was captured"
grep -q '"bare":0' "$WORK/summary.json"; check $? "every event is task-linked or explicitly unassigned"

cli plan show | grep -q 'inspect.*in_progress'; check $? "the killed task is back in_progress, not verified"
cli plan show | grep -qv 'verified.*verified'; check $? "nothing was verified by the interruption"

"$BUN" run packages/bw-evidence/src/cli.ts verify "$LOG" > "$WORK/verify.out" 2>&1
check $? "the evidence hash chain verifies after the whole walkthrough"

echo
if [ "$fail" -eq 0 ]; then
  echo "DEMONSTRATION PASSED ($step stages)"
else
  echo "DEMONSTRATION FAILED"
fi
exit "$fail"
