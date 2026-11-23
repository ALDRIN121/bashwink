/**
 * Negative-control fixture for the lint gate.
 *
 * This file MUST contain genuine semantic lint violations and MUST be excluded from the
 * normal lint scope (see `ignorePatterns` in `.oxlintrc.json`), so the gate stays green on
 * the real tree while `scripts/check_lint_gate.sh` proves the gate can actually fail.
 *
 * It is committed on purpose. A lint gate that has only ever been observed to pass is
 * untested: a misconfigured `ignorePatterns`, a silently empty file set, or a linter that
 * exits 0 regardless would all look identical to a passing gate. If a future change makes
 * this file lint clean, the gate has silently weakened.
 *
 * Violations planted here (both are error-severity under `categories.correctness`):
 *   - no-unused-vars  — a declared binding that is never read
 *   - no-debugger     — a `debugger` statement
 */
export function compare(left: number, right: number): boolean {
  const unusedVariable = 42
  debugger
  return left === right
}
