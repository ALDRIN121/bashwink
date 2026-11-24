#!/bin/sh
# Remove an installed Bashwink.
#
#   uninstall.sh [--prefix DIR] [--bin-dir DIR] [--purge-state]
#
# Removes the installed files and the `bashwink` link. Your projects are never touched.
# Saved sessions, evidence, approvals and provider settings are kept unless --purge-state is
# given; that option asks you to confirm and also deletes any retained VM stage directories.
set -eu

prefix="${HOME}/.local/opt/bashwink"
bin_dir="${HOME}/.local/bin"
purge=0
while [ $# -gt 0 ]; do
    case "$1" in
        --prefix) prefix=$2; shift 2 ;;
        --bin-dir) bin_dir=$2; shift 2 ;;
        --purge-state) purge=1; shift ;;
        -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "uninstall: unknown option $1" >&2; exit 2 ;;
    esac
done

case "$prefix" in
    */bashwink) ;;
    *) echo "uninstall: refusing --prefix $prefix: it must end in /bashwink so that removal can never touch another directory" >&2; exit 2 ;;
esac

state_dirs="${XDG_CONFIG_HOME:-$HOME/.config}/bashwink ${XDG_DATA_HOME:-$HOME/.local/share}/bashwink ${XDG_CACHE_HOME:-$HOME/.cache}/bashwink ${XDG_STATE_HOME:-$HOME/.local/state}/bashwink"

if pgrep -u "$(id -u)" -f 'offline-vm/vm-owner' >/dev/null 2>&1; then
    echo "uninstall: a Bashwink VM is still running. Exit it first." >&2
    exit 1
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

if [ "$purge" -eq 1 ]; then
    echo
    echo "--purge-state will delete saved sessions, evidence, approvals and provider settings:"
    for dir in $state_dirs; do
        if [ -e "$dir" ]; then echo "  $dir"; fi
    done
    echo "and retained VM stage directories (/private/tmp/bashwink-vm-*) that you own."
    echo "Any VM work you have not reviewed and applied will be lost."
    printf 'Type "delete" to continue: '
    read -r answer || answer=
    if [ "$answer" = delete ]; then
        for dir in $state_dirs; do
            if [ -e "$dir" ]; then rm -rf "$dir"; echo "removed $dir"; fi
        done
        for stage in /private/tmp/bashwink-vm-*; do
            if [ -d "$stage" ] && [ -O "$stage" ]; then rm -rf "$stage"; echo "removed $stage"; fi
        done
    else
        echo "state kept"
    fi
else
    echo
    echo "Kept your Bashwink state (sessions, evidence, approvals, provider settings):"
    for dir in $state_dirs; do
        if [ -e "$dir" ]; then echo "  $dir"; fi
    done
    echo "Delete it with: uninstall.sh --purge-state"
fi
exit 0
