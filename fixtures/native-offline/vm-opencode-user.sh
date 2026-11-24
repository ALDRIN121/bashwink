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
/opt/opencode --version
/opt/bun /opt/mock.ts &
trap 'kill "$!" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5; do
    wget -q -O /dev/null http://127.0.0.1:8117/healthz && break
    sleep 1
done
/opt/bun /opt/bashwink/bashwink.js trust /workspace --by fixture
/opt/bun /opt/bashwink/bashwink.js
grep -q '"phase":"boot"' "$BASHWINK_HOME/data/evidence/evidence.jsonl"
grep '"phase":"after"' "$BASHWINK_HOME/data/evidence/evidence.jsonl" | grep -q '"tool":"write"'
grep '"phase":"after"' "$BASHWINK_HOME/data/evidence/evidence.jsonl" | grep -q '"tool":"shell"'
