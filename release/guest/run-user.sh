#!/bin/sh
# Runs as the unprivileged guest user "nobody". The session ends at BASHWINK_TIMEOUT_MS,
# which is shorter than the host's VM deadline so that work is saved before the VM stops.
set -eu
export HOME=/state BASHWINK_HOME=/state/bashwink TERM=xterm-256color SHELL=/bin/sh
export TMPDIR=/state/tmp
export BASHWINK_OPENCODE_BIN=/opt/opencode OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
export BASHWINK_TIMEOUT_MS=@SESSION_GUEST_MS@
test "$(id -u)" -ne 0
test ! -w /dev/vda
cd /workspace
mkdir -m 700 "$TMPDIR"
export BW_VM_PROJECT=1
export PATH="/opt:$PATH"
IFS= read -r session < /run/bw-project-session
test -f /state/bw-relay.json
export OPENCODE_CONFIG=/state/bw-relay.json OPENCODE_CONFIG_PROJECT_DISABLE=1
/opt/bun /opt/bashwink/bashwink.js trust /workspace --by bashwink-vm >/dev/null
if test -n "$session"; then
    exec /opt/bun /opt/bashwink/bashwink.js --session "$session"
fi
exec /opt/bun /opt/bashwink/bashwink.js
