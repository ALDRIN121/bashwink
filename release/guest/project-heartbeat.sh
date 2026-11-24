#!/bin/sh
# Diagnostic helper used by qualification, identical to the fixture helper: it leaves a real
# task record and starts a bounded detached writer whose counter the host can observe on the
# stage disk. It is inert unless something inside the session runs it.
set -eu
/opt/bun /opt/bashwink/bashwink.js plan new "Persistent VM fixture task" --files=one.ts,two.ts,new.ts
setsid sh -c '
    for tick in $(seq 1 120); do
        printf "%s\n" "$tick" > /run/bw-heartbeats
        sleep 0.2
    done
' < /dev/null > /dev/null 2>&1 &
