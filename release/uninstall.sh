#!/bin/sh
# Remove an installed Bashwink.
#
#   uninstall.sh [--prefix DIR] [--bin-dir DIR] [--purge-state]
#
# Removes the installed files and the `bashwink` link. Your projects are never touched.
# Saved sessions, evidence, approvals and provider settings are kept unless --purge-state is
# given. That option lists what it will delete, asks you to type "delete", and then:
#
#   - removes VM stage directories ONLY if this installation recorded them, they are still the
#     directories it recorded, and no session is using them (`bashwink sandbox stages`);
#   - removes the state directories listed below.
#
# It never deletes a directory just because its name looks like a Bashwink one. Stage
# directories left by older builds, other installations or other tools are reported and kept.
set -eu

prefix="${HOME}/.local/opt/bashwink"
bin_dir="${HOME}/.local/bin"
purge=0
while [ $# -gt 0 ]; do
    case "$1" in
        --prefix) prefix=$2; shift 2 ;;
        --bin-dir) bin_dir=$2; shift 2 ;;
        --purge-state) purge=1; shift ;;
        -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "uninstall: unknown option $1" >&2; exit 2 ;;
    esac
done

case "$prefix" in
    */bashwink) ;;
    *) echo "uninstall: refusing --prefix $prefix: it must end in /bashwink so that removal can never touch another directory" >&2; exit 2 ;;
esac

state_dirs="${XDG_CONFIG_HOME:-$HOME/.config}/bashwink ${XDG_DATA_HOME:-$HOME/.local/share}/bashwink ${XDG_CACHE_HOME:-$HOME/.cache}/bashwink ${XDG_STATE_HOME:-$HOME/.local/state}/bashwink"
cli="$prefix/current/bin/bashwink"

if pgrep -u "$(id -u)" -f "$prefix/.*/offline-vm/vm-owner" >/dev/null 2>&1; then
    echo "uninstall: a Bashwink VM from this installation is still running. Exit it first." >&2
    exit 1
fi

delete_state=0
if [ "$purge" -eq 1 ]; then
    echo "--purge-state will delete saved sessions, evidence, approvals and provider settings:"
    for dir in $state_dirs; do
        if [ -e "$dir" ]; then echo "  $dir"; fi
    done
    echo "and VM stage directories that this installation recorded and that no session is using:"
    if [ -x "$cli" ]; then
        "$cli" sandbox stages | sed 's/^/  /' || true
    else
        echo "  (the installed command is missing, so stage directories cannot be identified)"
    fi
    echo "Any VM work you have not reviewed and applied will be lost."
    printf 'Type "delete" to continue: '
    read -r answer || answer=
    if [ "$answer" = delete ]; then
        delete_state=1
        if [ -x "$cli" ]; then
            if ! "$cli" sandbox stages --purge; then
                echo "uninstall: could not clean the recorded VM stages, so nothing was deleted." >&2
                exit 1
            fi
        fi
    else
        echo "state kept"
    fi
fi

link="$bin_dir/bashwink"
if [ -L "$link" ]; then
    case "$(readlink "$link")" in
        "$prefix"/*) rm -f "$link"; echo "removed $link" ;;
        *) echo "left $link alone: it does not point into $prefix" ;;
    esac
fi
if [ -d "$prefix" ]; then
    rm -rf "$prefix"
    echo "removed $prefix"
fi

if [ "$delete_state" -eq 1 ]; then
    for dir in $state_dirs; do
        if [ -e "$dir" ]; then rm -rf "$dir"; echo "removed $dir"; fi
    done
elif [ "$purge" -eq 0 ]; then
    echo
    echo "Kept your Bashwink state (sessions, evidence, approvals, provider settings):"
    for dir in $state_dirs; do
        if [ -e "$dir" ]; then echo "  $dir"; fi
    done
    echo "Delete it with: uninstall.sh --purge-state"
fi
exit 0
