# Bashwink — Next Steps

**Where we are:** **Phase 0 complete. Gate PASSED.** 9 of 9 tasks Done, 4 of 4 conditions met,
verified by real GitHub Actions runs on both supported platforms.

**Phase 1 may begin.**

## Phase 0 closed with CI evidence

| Workflow | Run | Commit | Result |
| --- | --- | --- | --- |
| `verify` | [45064795624](https://github.com/ALDRIN121/bashwink/actions/runs/45064795624) | `437c742` | failure — 7/8 jobs (secret scan) |
| `verify` | [45065505536](https://github.com/ALDRIN121/bashwink/actions/runs/45065505536) | `9b95d37` | **success — 8/8 jobs** |
| `verify` | [45066245596](https://github.com/ALDRIN121/bashwink/actions/runs/45066245596) | `0b09620` | **success — 8/8 jobs** |
| `verify` | [45067382809](https://github.com/ALDRIN121/bashwink/actions/runs/45067382809) | `8a3286c` | **success — 8/8 jobs** |
| `verify` | [45111515216](https://github.com/ALDRIN121/bashwink/actions/runs/45111515216) | `c536466` | **success — 9/9 jobs** (format-only gate) |
| `verify` | [45112004423](https://github.com/ALDRIN121/bashwink/actions/runs/45112004423) | `0c299df` | **success — 9/9 jobs** |
| `verify` | [45112152598](https://github.com/ALDRIN121/bashwink/actions/runs/45112152598) | `a86de7a` | **success — 9/9 jobs** |
| `verify` | [45112989970](https://github.com/ALDRIN121/bashwink/actions/runs/45112989970) | `bf33e20` | **success — 9/9 jobs, semantic lint + gate self-test** |
| `upstream-compat` | [45065638555](https://github.com/ALDRIN121/bashwink/actions/runs/45065638555) | `9b95d37` | failure — 28 `Ripgrep` tests/platform |
| `upstream-compat` | [45066246923](https://github.com/ALDRIN121/bashwink/actions/runs/45066246923) | `0b09620` | **success — both platforms** |
| `upstream-compat` | [45110993064](https://github.com/ALDRIN121/bashwink/actions/runs/45110993064) | `8a3286c` | **success — both legs** |
| `upstream-compat` | [45112577853](https://github.com/ALDRIN121/bashwink/actions/runs/45112577853) | `8a3286c` | cancelled — superseded |
| `upstream-compat` | [45113462602](https://github.com/ALDRIN121/bashwink/actions/runs/45113462602) | `bf33e20` | **success — both legs at the lint-gate commit** |

### The two defects CI found that local validation could not

1. **Secret scan** flagged the redaction tests' own placeholder inputs. My earlier "local
   validation" had only checked the scanner's *logic*, never run it against the tree. Fixed by
   assembling fixtures at runtime via a `credential()` helper; the `--exclude='*.md'` and
   `--exclude='mock_provider.py'` workarounds were removed rather than relied on.
2. **`upstream-compat`** failed because the upstream suite shell-outs to `rg` and tries to
   **download** it mid-test when absent — which the effect harness forbids. Invisible locally
   because Homebrew's `rg` 15.1.0 was already on `PATH`. Fixed by installing exactly the pinned
   version with a SHA-256 check.

### A third gap was found by re-reading the acceptance criterion, not by CI

BW-006's acceptance requires **"deterministic lint"**, and the independent review asked for a
root lint gate. Typecheck existed; **lint did not** — no config, no script, no CI step — so
BW-006 was Done with a genuinely unmet criterion.

The first fix was also wrong: `bun fmt --check` was added and called the lint gate. `bun fmt` is
a **formatter** — it rewrites whitespace and reports nothing about unused bindings, unreachable
code or `debugger` statements. Real lint is now `oxlint` 1.94.0 (pinned exactly), run as
`oxlint --deny-warnings packages` with `categories.correctness: error`. Formatting is kept as a
separate `bun fmt --check` step; it is no longer presented as lint.

`scripts/check_lint_gate.sh` proves the gate works in both directions and guards against the
three ways a lint gate silently passes without linting anything: it asserts the tree is clean,
that the scope contained **>0 files** (oxlint exits 0 on "No files found"), that a committed
violation fixture is rejected, and that the rejection names both expected rules rather than
coming from a crash. Green in CI: **9/9 jobs** in run 45112989970.

## Known risks carried into Phase 1 (none gate-blocking)

1. **No-FFmpeg native library is not byte-reproducible.** Two clean builds differ in hash
   (Zig embeds 194 absolute build paths); size and symbol profile identical. A PM-1 release
   must ship the recipe plus a symbol-profile assertion, not a digest.
2. **OpenTUI's own native test suite** was not run against the no-FFmpeg build — TUI smoke test
   only.
3. **No legal review.** ADR-009 removes known LGPL exposure from the artifact by construction;
   it is not legal advice.
4. **`bun audit`** has never been run.
5. **`DEPENDENCY_LICENSES.json`** is a snapshot; `upstream_sync.py` does not regenerate it, so
   the newly added `oxlint` dependency is not yet in the inventory. Regenerate before release.
6. **`oxlint` scope is `packages/`** (5 files) — the same scope typecheck and tests use. It does
   not lint `scripts/*.py` or the docs. Widening it is a Phase 1 decision, not a gate item.
7. **`upstream-compat` is weekly + manual**, not per-PR — deliberate (a 2.7 GB install and a
   ~5 min suite per PR is too expensive), and stated in the workflow.
8. **PM-1 is unimplemented.** The wrapper CLI (ADR-003) does not exist; only PM-0 is real today.

## Phase 1 — first tasks

1. **The wrapper CLI (ADR-003).** Own `--version`/`--help`, forward everything else, set
   `OPENCODE_CONFIG_DIR`, stage the plugin directory contents explicitly (config alone does not
   control loading), exec and propagate exit codes.
2. **Task/run taxonomy on evidence entries** — Phase 1 requires task and run identifiers;
   entries currently carry only call/session IDs.
3. **Concurrency control for the evidence log** (ADR-004) before Phase 4's parallel worktrees.
4. **Publish a per-session head hash** so tail truncation becomes detectable (ADR-007).

## Housekeeping

- Remote: `https://github.com/ALDRIN121/bashwink`, branch `main`, HEAD `0b09620` or later.
- The pinned OpenCode clone lives at `~/Developer/bashwink-upstream/opencode`, outside this
  repository — deliberate, so 2.7 GB of dependencies never enter Git.
- The 3 upstream bash-3.2 failures stay unpatched by design (BW-002). CI must have bash >= 4.
