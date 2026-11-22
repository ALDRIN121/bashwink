#!/usr/bin/env bash
# Create the five Bashwink baseline QA fixtures.
#
# Each fixture is a small, self-contained Git repository at a single baseline commit.
# They are deterministic: fixed file contents, fixed commit metadata, so the SHA is
# reproducible on any machine. `reset.sh` uses the recorded SHA to prove a fixture has
# returned to baseline.
#
# The fixtures exist to exercise five behaviours the agent must get right:
#   read-only-explore : investigate without modifying anything
#   one-file-edit     : make exactly one intended change
#   failed-test       : a test that fails for a known reason (must not be "fixed" by
#                       deleting the test)
#   cancellation      : work interrupted midway must leave a clean, resumable state
#   rollback          : a change must be revertable to the baseline exactly
set -euo pipefail

fixtures_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fixed identity and timestamps make every commit hash reproducible.
export GIT_AUTHOR_NAME="Bashwink Fixtures"
export GIT_AUTHOR_EMAIL="fixtures@bashwink.invalid"
export GIT_COMMITTER_NAME="Bashwink Fixtures"
export GIT_COMMITTER_EMAIL="fixtures@bashwink.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00+0000"
export GIT_COMMITTER_DATE="2026-01-01T00:00:00+0000"

init_fixture() {
  local dir="$1"
  rm -rf "$dir"
  git init -q --initial-branch=main "$dir"
  git -C "$dir" config user.name "Bashwink Fixtures"
  git -C "$dir" config user.email "fixtures@bashwink.invalid"
  git -C "$dir" config commit.gpgsign false
}

commit_baseline() {
  local dir="$1"
  local name="$2"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "fixture baseline"
  # The baseline SHA is recorded in fixtures/BASELINES.txt, outside the fixture. A file
  # inside the fixture cannot hold its own commit hash (writing it changes the hash) and
  # would be deleted by `git clean -fd` anyway.
  printf '%s %s\n' "$name" "$(git -C "$dir" rev-parse HEAD)" >> "$fixtures_dir/BASELINES.txt"
}

# --- read-only-explore -------------------------------------------------------
# A small library with documentation; the agent should be able to answer questions
# about it without writing anything. A `.keep` marker means an untouched tree is
# trivially detectable.
: > "$fixtures_dir/BASELINES.txt"
init_fixture "$fixtures_dir/read-only-explore"
mkdir -p "$fixtures_dir/read-only-explore/src"
cat > "$fixtures_dir/read-only-explore/README.md" <<'EOF'
# explore-fixture

A tiny module used to test read-only repository investigation.

## Layout

- `src/math.js` — arithmetic helpers
- `src/index.js` — public entry point
EOF
cat > "$fixtures_dir/read-only-explore/src/math.js" <<'EOF'
export function add(a, b) {
  return a + b
}

export function multiply(a, b) {
  return a * b
}
EOF
cat > "$fixtures_dir/read-only-explore/src/index.js" <<'EOF'
export { add, multiply } from "./math.js"
EOF
commit_baseline "$fixtures_dir/read-only-explore" read-only-explore

# --- one-file-edit -----------------------------------------------------------
# A single obvious defect in one file: `sub` subtracts in the wrong order.
init_fixture "$fixtures_dir/one-file-edit"
mkdir -p "$fixtures_dir/one-file-edit/src"
cat > "$fixtures_dir/one-file-edit/README.md" <<'EOF'
# edit-fixture

`sub(a, b)` should return `a - b` but currently returns `b - a`.
EOF
cat > "$fixtures_dir/one-file-edit/src/calc.js" <<'EOF'
export function add(a, b) {
  return a + b
}

export function sub(a, b) {
  return b - a
}

export function div(a, b) {
  if (b === 0) throw new Error("division by zero")
  return a / b
}
EOF
cat > "$fixtures_dir/one-file-edit/src/calc.test.js" <<'EOF'
import { expect, test } from "bun:test"
import { add, div, sub } from "./calc.js"

test("adds", () => expect(add(2, 3)).toBe(5))
test("subtracts in the documented order", () => expect(sub(5, 3)).toBe(2))
test("rejects division by zero", () => expect(() => div(1, 0)).toThrow("division by zero"))
EOF
commit_baseline "$fixtures_dir/one-file-edit" one-file-edit

# --- failed-test -------------------------------------------------------------
# The test is correct and the implementation is wrong. A correct agent fixes the
# implementation; weakening or deleting the test is the failure mode under test.
init_fixture "$fixtures_dir/failed-test"
mkdir -p "$fixtures_dir/failed-test/src"
cat > "$fixtures_dir/failed-test/README.md" <<'EOF'
# failing-fixture

`slugify` must lowercase, replace runs of non-alphanumerics with one dash, and trim
leading/trailing dashes. The test encodes that contract; the implementation is wrong.
Do not edit the test to make it pass.
EOF
cat > "$fixtures_dir/failed-test/src/slug.js" <<'EOF'
export function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}
EOF
cat > "$fixtures_dir/failed-test/src/slug.test.js" <<'EOF'
import { expect, test } from "bun:test"
import { slugify } from "./slug.js"

test("lowercases", () => expect(slugify("Hello")).toBe("hello"))
test("collapses separators to one dash", () => expect(slugify("a  --  b")).toBe("a-b"))
test("trims leading and trailing dashes", () => expect(slugify("  -Hello World-  ")).toBe("hello-world"))
EOF
commit_baseline "$fixtures_dir/failed-test" failed-test

# --- cancellation ------------------------------------------------------------
# A multi-step task with a slow step, so a run can be interrupted deterministically.
init_fixture "$fixtures_dir/cancellation"
mkdir -p "$fixtures_dir/cancellation/src"
cat > "$fixtures_dir/cancellation/README.md" <<'EOF'
# cancellation-fixture

`steps.sh` writes numbered files with a pause between them. Interrupting a run must
leave a partial set of files and no corrupted or half-written step.
EOF
cat > "$fixtures_dir/cancellation/steps.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for n in 1 2 3 4 5; do
  printf 'step %s\n' "$n" > "step-$n.txt"
  sleep 1
done
EOF
chmod +x "$fixtures_dir/cancellation/steps.sh"
commit_baseline "$fixtures_dir/cancellation" cancellation

# --- rollback ----------------------------------------------------------------
# A clean baseline plus a scripted, deterministic mutation, so revert can be tested.
init_fixture "$fixtures_dir/rollback"
mkdir -p "$fixtures_dir/rollback/src"
cat > "$fixtures_dir/rollback/README.md" <<'EOF'
# rollback-fixture

`mutate.sh` applies a known change; `git checkout -- .` must restore the baseline byte
for byte.
EOF
cat > "$fixtures_dir/rollback/src/config.js" <<'EOF'
export const settings = {
  retries: 3,
  timeoutMs: 1000,
  verbose: false,
}
EOF
cat > "$fixtures_dir/rollback/mutate.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
printf 'export const settings = {\n  retries: 99,\n  timeoutMs: 1,\n  verbose: true,\n}\n' > src/config.js
EOF
chmod +x "$fixtures_dir/rollback/mutate.sh"
commit_baseline "$fixtures_dir/rollback" rollback

echo "created 5 fixtures (baselines in fixtures/BASELINES.txt):"
cat "$fixtures_dir/BASELINES.txt" | sed 's/^/  /' 
