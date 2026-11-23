#!/usr/bin/env bash
# Prove bare `bashwink` starts an interactive session in the CWD, from unrelated directories.
#
# The TUI is a full-screen application, so its stdout is escape sequences rather than text.
# Reading them is not evidence: the authoritative record is the plugin's own boot entry, which
# carries the `location` the runtime resolved and the `cwd` it started in. This script starts
# the TUI in each directory, gives it time to boot, terminates it, and checks that record.
#
# A directory is a pass only if a *new* boot entry appears for it. A TUI that silently fails
# to start would leave no boot entry, which is exactly the failure this is looking for.
set -uo pipefail

BW="${BW:-$HOME/Developer/bashwink-alpha-install/bin/bashwink}"
export BASHWINK_HOME="${BASHWINK_HOME:-$HOME/Developer/bashwink-alpha-verify-tui}"
export BASHWINK_OPENCODE_BIN="${BASHWINK_OPENCODE_BIN:-$HOME/.bun/install/cache/@opencode/cli-darwin-arm64@2.3.2@@@1/bin/opencode}"
EVIDENCE="$BASHWINK_HOME/data/evidence/evidence.jsonl"

pass=0
fail=0
check() {
  local label="$1" expected_rc="$2" actual_rc="$3" detail="${4:-}"
  if [ "$expected_rc" = "$actual_rc" ]; then
    printf 'PASS  %s%s\n' "$label" "${detail:+ — $detail}"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s (expected %s, got %s)%s\n' "$label" "$expected_rc" "$actual_rc" "${detail:+ — $detail}"
    fail=$((fail + 1))
  fi
}

mkdir -p "$BASHWINK_HOME"

# A killed session leaves the runtime's managed service behind, holding its port; the next
# launch then dies with a port-in-use stack trace instead of starting. That is a real alpha
# problem (reported clearly by the wrapper now), but it must not make this fixture flaky.
clear_stale_service() {
  pkill -f "opencode serve --service" 2>/dev/null
  pkill -f "bashwink.js" 2>/dev/null
  sleep 2
}

# Three unrelated directories: a Git repo, a non-Git directory, and a deep subdirectory.
GIT_DIR=/tmp/bw-tui-git
NOGIT_DIR=/tmp/bw-tui-nogit
NESTED_DIR=/tmp/bw-tui-nested/deep/sub
rm -rf /tmp/bw-tui-git /tmp/bw-tui-nogit /tmp/bw-tui-nested
mkdir -p "$GIT_DIR" "$NOGIT_DIR" "$NESTED_DIR"
(
  cd "$GIT_DIR" && git init -q . && printf 'def hello():\n    return "hi"\n' > greet.py \
    && git add -A && git -c user.email=a@b -c user.name=p commit -qm init
)
printf 'print("standalone")\n' > "$NOGIT_DIR/script.py"
printf 'x = 1\n' > "$NESTED_DIR/leaf.py"

count_boots() {
  [ -f "$EVIDENCE" ] || { echo 0; return; }
  grep -c '"phase":"boot"' "$EVIDENCE" 2>/dev/null || echo 0
}

# Start the TUI under a real pseudo-terminal, let it boot, then stop it.
#
# A PTY is mandatory, not incidental: the wrapper refuses to start an interactive session when
# neither stdout nor stdin is a terminal (it prints help instead), because spawning a TUI onto
# a pipe hangs rather than failing. `script` is what gives us one here, so the test exercises
# the same branch a developer's terminal does rather than a special case.
#
# Two portability traps cost real time here, and both failed *silently* as "no boot entry":
#   - macOS `script` has no `-c` flag (that is util-linux); it takes `[file [command ...]]`.
#   - `timeout` is absent on macOS, so a `timeout`-wrapped launch is a no-op.
# A bounded sleep plus an explicit kill is portable and cannot hang.
launch_for() {
  local directory="$1" seconds="$2"
  (
    cd "$directory" || exit 1
    script -q /dev/null "$BW" >/dev/null 2>&1 &
    local launcher=$!
    sleep "$seconds"
    pkill -TERM -f "bashwink.js" 2>/dev/null
    sleep 2
    pkill -KILL -f "bashwink.js" 2>/dev/null
    wait "$launcher" 2>/dev/null
  )
  sleep 1
}

last_boot_matches() {
  local needle="$1"
  [ -f "$EVIDENCE" ] || return 1
  tail -40 "$EVIDENCE" | grep '"phase":"boot"' | tail -1 | grep -q "$needle"
}

echo "=== bare 'bashwink' starts an interactive session in each directory ==="
for pair in "$GIT_DIR" "$NOGIT_DIR" "$NESTED_DIR"; do
  clear_stale_service
  before=$(count_boots)
  launch_for "$pair" 30
  after=$(count_boots)
  if [ "$after" -gt "$before" ] && last_boot_matches "$pair"; then
    check "TUI boots in $pair" ready ready "$(basename "$pair")"
  else
    check "TUI boots in $pair" ready "no boot entry (before=$before after=$after)" ""
  fi
done

# The TUI must not be what a non-interactive invocation gets: a pipeline cannot drive it, and
# spawning one onto a pipe hangs rather than failing.
echo
echo "=== a non-interactive bare invocation prints help, not a hung TUI ==="
# Piped AND no input: neither stream is a terminal, so the wrapper must decline the TUI rather
# than spawn one that cannot render.
piped=$(cd "$GIT_DIR" && "$BW" < /dev/null 2>/dev/null | head -1)
check "piped bare invocation prints help" "bashwink — an evidence-first coding agent" "$piped" ""

# Existing subcommands must still work with the new no-argument branch.
echo
echo "=== existing subcommands are preserved ==="
check "--version" 0 "$("$BW" --version >/dev/null 2>&1; echo $?)" "$("$BW" --version)"
check "--help" 0 "$("$BW" --help >/dev/null 2>&1; echo $?)" ""
check "doctor runs" 0 "$("$BW" doctor >/dev/null 2>&1; echo $?)" ""

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
