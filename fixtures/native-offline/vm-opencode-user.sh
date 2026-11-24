#!/bin/sh
set -eu
export HOME=/state BASHWINK_HOME=/state/bashwink TERM=xterm-256color SHELL=/bin/sh
export TMPDIR=/state/tmp
export BASHWINK_OPENCODE_BIN=/opt/opencode OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
export BASHWINK_TIMEOUT_MS=28000
test "$(id -u)" -ne 0
test ! -w /dev/vda
cd /workspace
mkdir -m 700 "$TMPDIR"
session=''
if test -f /run/bw-project-session; then
    export BW_VM_PROJECT=1 OPENCODE_CONFIG=/opt/opencode-fixture.json
    export PATH="/opt:$PATH"
    IFS= read -r session < /run/bw-project-session
fi
/opt/opencode --version
/opt/bun /opt/mock.ts &
trap 'kill "$!" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5; do
    wget -q -O /dev/null http://127.0.0.1:8117/healthz && break
    sleep 1
done
/opt/bun /opt/bashwink/bashwink.js trust /workspace --by fixture
if test -n "$session"; then
    /opt/bun /opt/bashwink/bashwink.js --session "$session"
else
    /opt/bun /opt/bashwink/bashwink.js
fi
if test -f shell-result.txt; then
    grep -q '"phase":"boot"' "$BASHWINK_HOME/data/evidence/evidence.jsonl"
    grep '"phase":"after"' "$BASHWINK_HOME/data/evidence/evidence.jsonl" | grep -q '"tool":"write"'
    grep '"phase":"after"' "$BASHWINK_HOME/data/evidence/evidence.jsonl" | grep -q '"tool":"shell"'
fi
