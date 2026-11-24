#!/bin/sh
# Bashwink launcher. Resolves its own location (through symlinks) and runs the CLI bundle
# with the Bun that ships in this archive, so nothing is read from the source checkout, from
# PATH, or from a developer-specific location.
set -eu
self=$0
while [ -L "$self" ]; do
    link=$(readlink "$self")
    case "$link" in
        /*) self=$link ;;
        *) self=$(dirname "$self")/$link ;;
    esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$root/libexec/bun" "$root/lib/bashwink.js" "$@"
