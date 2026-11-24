#!/bin/sh
# The approved fixture command leaves a real task record and starts a bounded guest writer.
set -eu
/opt/bun /opt/bashwink/bashwink.js plan new "Persistent VM fixture task" --files=one.ts,two.ts,new.ts
setsid sh -c '
    for tick in $(seq 1 120); do
        printf "%s\n" "$tick" > /run/bw-heartbeats
        sleep 0.2
    done
' < /dev/null > /dev/null 2>&1 &
