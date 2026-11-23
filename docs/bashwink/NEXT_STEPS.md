# Bashwink — Next Steps

**Where we are:** **Phase 0 complete and gate-passed**, and **Phase 1 complete and gate-passed**.
10 of 10 Phase 1 tasks Done, 188 tests passing on Linux and macOS, and **11/11 CI jobs green on
both supported platforms** at HEAD `ad9d44e`
([run 45129207277](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277)).

**Phase 2 has not been started.** The Phase 1 gate is where work stopped, deliberately.

## Phase 1 closed with CI evidence

| Workflow | Run | Commit | Result |
| --- | --- | --- | --- |
| `verify` | [45118931489](https://github.com/ALDRIN121/bashwink/actions/runs/45118931489) | `ee4652f` | **failure** — `cli` job, in the *workflow* not the code |
| `verify` | [45119233542](https://github.com/ALDRIN121/bashwink/actions/runs/45119233542) | `f753920` | **success — 11/11 jobs, both platforms** |
| `verify` | [45129207277](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277) | `ad9d44e` | **success — 11/11 jobs, both platforms, 0 failure annotations** |

### The CI failure, and why it was worth having

The first Phase 1 run failed on both platforms — but the 141 CLI tests and the 10/10 SIGKILL
fixture had **already passed**. The failure was in the smoke step I wrote:

- `test -d "$BASHWINK_HOME"` after `--version`. `--version` is handled by the wrapper and
  deliberately never touches the filesystem, so that assertion could only ever fail.
- `doctor || true` discarded the exit code — which *is* the BW-009 acceptance criterion. A step
  that ignores the thing it is testing can only report green.

Both fixed in `f753920`. This is the same class of error as the `bun fmt`-as-lint mistake in
Phase 0: a check that looked like verification and verified nothing.

### Two green-but-red signals, removed in `ad9d44e`

Neither was a test or product defect; both made a passing pipeline report something untrue.

1. **`fixtures` carried a red failure annotation while every step exited 0.** `bun test` sees
   `GITHUB_ACTIONS=true` and emits assertion failures as `::error::` workflow commands. The
   `failed-test` fixture must fail — that is the assertion — so the UI showed
   `Expected: "hello-world" / Received: "-hello-world-"` as a failed check on a green job. Fixed by
   scoping the variable off that one command; the exit code is still the signal.
2. **Every job ran on the deprecated Node 20 shim.** `checkout@v4` / `setup-python@v5` declare
   `node20`; bumped to `checkout@v5` / `setup-python@v6`, confirmed per tag from `action.yml`.

### What the Linux leg actually settled

Three risks were flagged before pushing, and all three held:

1. **`bun:sqlite`** — migrations, durability and attempt-tracking suites all pass on
   `ubuntu-latest`. The WAL single-writer assumption holds there too.
2. **Symlinked plugin staging** — no failure on Linux.
3. **Git subprocess fixtures** — passed on `git 2.56.1` as well as Apple Git 2.54.0. This one
   had already bitten once, when `git --no-color diff` produced empty output rather than an
   error.

## Phase 1 — what was built

| Task | What was built |
| --- | --- |
| BW-008 | `bashwink` wrapper: own `--version`/`--help`, arg passthrough, `BASHWINK_HOME`, XDG isolation |
| BW-009 | `doctor`: 8 checks, nonzero exit on a missing precondition, credential fingerprints only |
| BW-010 | Workspace trust: untrusted denies write/shell/network by construction; `--by` required |
| BW-011 | `assertEditable` edit gate + three real git fixtures for diff/undo/cancel |
| BW-012 | SQLite plan/task store: atomic migrations, schema-version refusal, exercised rollback |
| BW-013 | Plan contract + hand-written validator (cycles, unknown deps, approval attribution) |
| BW-014 | Tool lifecycle against the **real** runtime: joined `before`/`after`, `exit=0`, task-linked |
| BW-015 | Export keeping `pass`/`fail`/`not_run` distinct, plus md/json and a raw-result digest |
| BW-016 | `taskID` on every event from a durable marker; explicit `unassignedReason` otherwise |
| BW-019 | Real SIGKILL fixture: `writes=1`, resume reopens to `in_progress`, never `verified` |

## Known risks carried into Phase 2 (none gate-blocking)

1. **The evidence plugin must be staged or nothing is recorded — and failing to stage it is
   silent.** `main.ts` now calls `stagePlugins` before every runtime invocation, and the
   end-to-end fixture is the only thing that catches a regression here. Every unit test passed
   while the real runtime recorded nothing.
2. **Staged plugins are symlinks into this repository.** Fine for a working copy; a real
   distribution must copy or resolve them, and that is a PM-1 packaging question (ADR-009).
3. **No-FFmpeg native library is not byte-reproducible** (Zig embeds build paths). A PM-1
   release must assert a symbol profile, not a digest.
4. **No legal review.** ADR-009 removes known LGPL exposure by construction; it is not advice.
5. **`DEPENDENCY_LICENSES.json` was regenerated for Phase 1** — `oxlint` (1.94.0) and
   `@opencode/plugin` (2.3.2, a root devDependency so staged plugins can resolve it) are now in
   the inventory, both verified MIT from the packages themselves, and the release gate still
   exits 0. It remains a **snapshot**: `upstream_sync.py` does not regenerate it, so it must be
   refreshed every time a dependency is added.
6. **`bun audit`** has never been run.
7. **The doctor's `docker` check only tests presence on `PATH`** — it does not verify the
   daemon answers.
8. **`bun:sqlite` is a single-writer assumption.** Parallel agents are Phase 4 (ADR-004).
9. **`upstream-compat` is weekly + manual**, deliberately: a 2.7 GB install and ~5 min suite
   per PR is too expensive.

## Phase 2 — first tasks

1. **Concurrency control for the evidence log** (ADR-004) before Phase 4's parallel worktrees.
2. **Publish a per-session head hash** so tail truncation becomes detectable (ADR-007).
3. **`bashwink plan observe` from a real check runner** — the CLI records observations, but
   nothing yet *executes* a plan's declared `command` and records the exit code itself. Today
   the caller supplies the outcome, which is a trust boundary worth closing.
4. **Persist the plan in one place.** `current-plan.json` and the SQLite store are written
   together by the CLI but are two sources of truth; a crash between them could desynchronise
   them. A phase-2 refactor should make the store authoritative.

## Housekeeping

- Remote: `https://github.com/ALDRIN121/bashwink`, branch `main`.
- The pinned OpenCode clone lives outside this repository, so ~2.7 GB of dependencies never
  enter Git.
- The 3 upstream bash-3.2 failures stay unpatched by design (BW-002). CI must have bash >= 4.
- The real OpenCode runtime used for the end-to-end evidence was installed to a scratch
  directory (`@opencode/cli@2.3.2`, ~225 MB platform package) and is **not** a repository
  dependency. `BASHWINK_OPENCODE_BIN` points at it.
