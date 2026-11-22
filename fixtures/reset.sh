#!/usr/bin/env bash
# Reset Bashwink QA fixtures to their committed Git baseline.
#
# Every fixture is a self-contained Git repo whose baseline is a single commit. Reset
# means: discard working-tree changes, delete untracked files, and confirm HEAD matches
# the baseline recorded in fixtures/BASELINES.txt. Idempotent.
#
# Usage:
#   ./fixtures/reset.sh              # reset every fixture
#   ./fixtures/reset.sh one-file-edit
#   ./fixtures/reset.sh --check      # verify only, change nothing
set -euo pipefail

fixtures_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$fixtures_dir/BASELINES.txt"

cases=(
  read-only-explore
  one-file-edit
  failed-test
  cancellation
  rollback
)

check_only=0
selected=()
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) selected+=("$arg") ;;
  esac
done

if [ ${#selected[@]} -eq 0 ]; then
  selected=("${cases[@]}")
fi

if [ ! -f "$manifest" ]; then
  echo "FAIL: missing $manifest (run fixtures/create_fixtures.sh)" >&2
  exit 1
fi

# Look up a fixture's expected baseline SHA. The manifest lives outside the fixtures
# because a file inside a repo cannot record that repo's own commit hash.
expected_for() {
  awk -v n="$1" '$1 == n { print $2 }' "$manifest"
}

failures=0
for name in "${selected[@]}"; do
  dir="$fixtures_dir/$name"
  if [ ! -d "$dir/.git" ]; then
    echo "FAIL $name: not a git fixture at $dir" >&2
    failures=$((failures + 1))
    continue
  fi

  expected="$(expected_for "$name")"
  if [ -z "$expected" ]; then
    echo "FAIL $name: no baseline SHA recorded in BASELINES.txt" >&2
    failures=$((failures + 1))
    continue
  fi

  if [ "$check_only" -eq 1 ]; then
    actual="$(git -C "$dir" rev-parse HEAD)"
    dirty="$(git -C "$dir" status --porcelain)"
    if [ "$actual" != "$expected" ]; then
      echo "FAIL $name: HEAD $actual != baseline $expected" >&2
      failures=$((failures + 1))
    elif [ -n "$dirty" ]; then
      # HEAD matching is not enough: a fixture with modified or untracked files is not
      # at its baseline, and callers gate on this check.
      echo "FAIL $name: HEAD is baseline but the working tree is dirty" >&2
      echo "$dirty" >&2
      failures=$((failures + 1))
    else
      echo "OK   $name ($actual)"
    fi
    continue
  fi

  git -C "$dir" reset --hard --quiet
  git -C "$dir" clean -fdq
  actual="$(git -C "$dir" rev-parse HEAD)"
  status="$(git -C "$dir" status --porcelain)"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL $name: HEAD $actual != baseline $expected after reset" >&2
    failures=$((failures + 1))
  elif [ -n "$status" ]; then
    echo "FAIL $name: working tree not clean after reset:" >&2
    echo "$status" >&2
    failures=$((failures + 1))
  else
    echo "OK   $name reset to $actual"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "$failures fixture(s) failed" >&2
  exit 1
fi
echo "all ${#selected[@]} fixture(s) at baseline"
