#!/usr/bin/env bash
#
# Positive + negative control for the semantic lint gate (BW-006: "deterministic lint").
#
# A lint gate that has only ever been seen to pass proves nothing. This script asserts both
# directions in one run:
#
#   1. POSITIVE  the real tree lints clean
#   2. NEGATIVE  a committed fixture with genuine violations makes the linter exit nonzero
#
# It also asserts the *reason* for the negative result: the fixture must fail because of
# reported diagnostics, not because the linter crashed, could not resolve a config, or found
# no files. Those failure modes all produce a nonzero exit too, so an exit-code-only check
# would happily pass a completely broken gate.
#
# Usage: ./scripts/check_lint_gate.sh [--tree-only|--fixture-only]
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

FIXTURE="fixtures/lint-violation/bad.ts"
OXLINT="./node_modules/.bin/oxlint"
LINT_SCOPE="packages"
pass=0
fail=0

ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }

if [ ! -x "$OXLINT" ]; then
  echo "FAIL: $OXLINT not found — run 'bun install --frozen-lockfile' first" >&2
  exit 2
fi

MODE="both"
case "${1:-}" in
  --tree-only)    MODE="tree" ;;
  --fixture-only) MODE="fixture" ;;
  "")             ;;
  *) echo "usage: $0 [--tree-only|--fixture-only]" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# 1. POSITIVE CONTROL — the real tree must lint clean.
# ---------------------------------------------------------------------------
if [ "$MODE" != "fixture" ]; then
  echo "=== positive control: the tree lints clean ==="
  tree_out="$("$OXLINT" --deny-warnings "$LINT_SCOPE" 2>&1)"
  tree_rc=$?
  if [ "$tree_rc" -eq 0 ]; then
    ok "tree lints clean (exit 0)"
  else
    bad "tree does not lint clean (exit $tree_rc)"
    printf '%s\n' "$tree_out" | sed 's/^/      /'
  fi

  # "Exit 0 with nothing linted" is the classic vacuous pass: a typo in the scope path, an
  # over-broad ignore pattern, or a linter that silently skips files all produce a green
  # gate. oxlint reports "No files found to lint" and still exits 0, so assert the file
  # count explicitly rather than trusting the exit code.
  count_json="$("$OXLINT" --format=json "$LINT_SCOPE" 2>/dev/null)"
  n_files="$(printf '%s' "$count_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("number_of_files", 0))' 2>/dev/null || echo 0)"
  if [ "${n_files:-0}" -gt 0 ] 2>/dev/null; then
    ok "lint scope '$LINT_SCOPE' actually contained $n_files file(s)"
  else
    bad "lint scope '$LINT_SCOPE' linted ZERO files — the green result is vacuous"
  fi
fi

# ---------------------------------------------------------------------------
# 2. NEGATIVE CONTROL — the committed fixture must be rejected.
# ---------------------------------------------------------------------------
if [ "$MODE" != "tree" ]; then
  echo "=== negative control: a genuine violation is rejected ==="

  if [ ! -f "$FIXTURE" ]; then
    bad "negative-control fixture $FIXTURE is missing"
  else
    # The fixture deliberately lives OUTSIDE `packages/` (the lint scope), so the tree lint
    # never sees it and needs no ignore rule. `--no-ignore` is still passed because oxlint's
    # config `ignorePatterns` cannot be overridden per-invocation: if someone later excludes
    # the fixture there, this would report "No files found" and be mistaken for a detection.
    fix_out="$("$OXLINT" --no-ignore --deny-warnings "$FIXTURE" 2>&1)"
    fix_rc=$?

    if [ "$fix_rc" -ne 0 ]; then
      ok "fixture rejected with exit $fix_rc"
    else
      bad "fixture linted CLEAN (exit 0) — the gate is not enforcing anything"
    fi

    # The exit code must be earned by diagnostics, not by a crash or a config error.
    if printf '%s' "$fix_out" | grep -q 'no-unused-vars'; then
      ok "fixture rejected for no-unused-vars (a semantic rule actually fired)"
    else
      bad "no-unused-vars was not reported — the rule set has weakened"
    fi

    if printf '%s' "$fix_out" | grep -q 'no-debugger'; then
      ok "fixture rejected for no-debugger (a second independent rule fired)"
    else
      bad "no-debugger was not reported — the rule set has weakened"
    fi

    # Guard against "nonzero because it could not even run".
    if printf '%s' "$fix_out" | grep -qiE 'Failed to parse|Script not found|No files|error: (unable|cannot)'; then
      bad "linter failed to RUN rather than reporting lint violations"
      printf '%s\n' "$fix_out" | sed 's/^/      /'
    else
      ok "failure came from lint diagnostics, not from a broken invocation"
    fi
  fi
fi

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
