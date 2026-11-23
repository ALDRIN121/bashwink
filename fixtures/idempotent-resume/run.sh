#!/usr/bin/env bash
#
# BW-019 acceptance fixture: kill a run mid-write, then resume, and prove it neither
# double-applies the patch nor falsely verifies the abandoned check.
#
# This is a real kill. A child process is started, it records a durable attempt, and is then
# SIGKILLed while holding that attempt open. The parent asserts on the database afterwards,
# which is the only evidence that survives a process that never got to finish.
#
# The helper assertions live in sibling `.ts` files rather than inline `bun -e` scripts: an
# inline script has to survive two levels of shell quoting, and one round of that produced a
# `${HOME}+"/data/…"` expression that bash rewrote into a regex literal. Keeping them as
# files makes the fixture reviewable.
#
# Usage: ./fixtures/idempotent-resume/run.sh
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

BUN="${BUN:-bun}"
CLI="packages/bw-cli/src/bin.ts"
pass=0
fail=0
ok()  { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export BASHWINK_HOME="$WORK/home"
mkdir -p "$BASHWINK_HOME/data" "$BASHWINK_HOME/config"

echo "=== 1. create a plan and move its first task to in_progress ==="
"$BUN" run "$CLI" plan new "resume fixture" >/dev/null 2>&1 || { echo "could not create plan" >&2; exit 2; }
"$BUN" run "$CLI" plan task inspect ready >/dev/null 2>&1
"$BUN" run "$CLI" plan task inspect in_progress >/dev/null 2>&1

echo
echo "=== 2. SIGKILL a process holding an unfinished attempt ==="
"$BUN" run fixtures/idempotent-resume/hold-attempt.ts > "$WORK/child.out" 2>&1 &
child_pid=$!
sleep 3
if kill -0 "$child_pid" 2>/dev/null; then
  kill -9 "$child_pid" 2>/dev/null
  wait "$child_pid" 2>/dev/null
  ok "child was SIGKILLed while holding an attempt open"
else
  bad "child exited on its own; the kill scenario did not reproduce"
  sed 's/^/      /' "$WORK/child.out" 2>/dev/null
fi

echo
echo "=== 3. the interrupted work is visible and NOT verified ==="
status_out="$("$BUN" run "$CLI" resume --status 2>&1)"
printf '%s\n' "$status_out" | sed 's/^/      /'
case "$status_out" in
  *"unfinished attempts: 1"*) ok "the unfinished attempt survived the kill and is reported" ;;
  *) bad "the unfinished attempt was not reported" ;;
esac
case "$status_out" in
  *"interrupted tasks: inspect(in_progress)"*) ok "the interrupted task is reported as in_progress, not verified" ;;
  *) bad "the interrupted task was not reported as in_progress" ;;
esac

echo
echo "=== 4. resume reopens the task but never verifies it ==="
resume_out="$("$BUN" run "$CLI" resume 2>&1)"
printf '%s\n' "$resume_out" | sed 's/^/      /'
case "$resume_out" in
  *"reopened: inspect -> in_progress"*) ok "resume reopened the task into in_progress" ;;
  *) bad "resume did not reopen the task" ;;
esac
case "$resume_out" in
  *"inspect -> verified"*) bad "resume falsely verified the abandoned task" ;;
  *) ok "resume did NOT claim the abandoned task passed" ;;
esac
case "$resume_out" in
  *"NOT verified"*) ok "resume states the work is unverified and lists what to re-run" ;;
  *) bad "resume did not warn that the work is unverified" ;;
esac

echo
echo "=== 5. an abandoned attempt is not treated as applied ==="
applied="$("$BUN" run fixtures/idempotent-resume/check-applied.ts 2>&1)"
echo "      alreadyApplied=$applied"
if [ "$applied" = "no" ]; then
  ok "an abandoned attempt is not counted as applied, so resume re-checks the file"
else
  bad "an abandoned attempt was treated as applied — resume would skip a write that never happened"
fi

echo
echo "=== 6. the same write happens exactly once across two attempts ==="
export TARGET="$WORK/edited.txt"
idem="$("$BUN" run fixtures/idempotent-resume/check-idempotent.ts 2>&1)"
echo "      $idem"
case "$idem" in
  *"writes=1"*) ok "the identical write was applied exactly once" ;;
  *) bad "the write was applied more than once (double-apply)" ;;
esac
case "$idem" in
  *"second=skipped_already_applied"*) ok "the second attempt was skipped by fingerprint, not by luck" ;;
  *) bad "the second attempt was not skipped for the recorded reason" ;;
esac

echo
echo "=== 7. the killed task still cannot be verified ==="
# Two independent refusals apply, and either is a correct answer: the state machine blocks
# in_progress -> verified (a task must be implemented first), and the check guard blocks
# implemented -> verified while a declared check has no observation. The assertion accepts
# both and requires that the refusal is one of them, not a generic error.
verify_out="$("$BUN" run "$CLI" plan task inspect verified 2>&1)"
verify_rc=$?
printf '%s\n' "$verify_out" | sed 's/^/      /'
if [ "$verify_rc" -eq 0 ]; then
  bad "verification succeeded after an interruption"
else
  case "$verify_out" in
    *"was never run"*) ok "verification refused: the check has no observation" ;;
    *"illegal transition"*"verified"*) ok "verification refused: the state machine forbids it from here" ;;
    *) bad "verification was refused for an unexpected reason" ;;
  esac
fi

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
