# Bashwink — Next Steps

**Where we are:** **Phase 0 complete and gate-passed** with hosted CI evidence on both
platforms. **Phase 1 implemented**: 10 of 10 tasks Done, 188 tests passing, and the Phase 1
exit demonstration runs as one scripted walkthrough in
`fixtures/phase1-demo/run.sh` — **DEMONSTRATION PASSED (8 stages)**.

**Phase 2 must not start until the Phase 1 hosted CI run is collected.** See "The one open
item" below.

## The one open item: Phase 1 has no hosted CI run

Every Phase 1 claim in `TEST_EVIDENCE.md` is a **local macOS arm64** result. The `cli` job was
added to `verify.yml` with a `[ubuntu-latest, macos-15]` matrix, but it has not executed yet.
That matters for three specific reasons, not as a formality:

1. `bun:sqlite` — the store is the backbone of BW-012/016/019 and has only ever run on Darwin.
2. **Plugin staging uses a symlink.** `stagePlugins` symlinks the real package into
   `OPENCODE_CONFIG_DIR/plugin/`. Symlink resolution differs across filesystems, and the
   absolute-`exports` and cross-`/tmp`-symlink variants of this already failed *silently* twice
   on macOS. A Linux runner is where the next variant would surface.
3. **Git subprocess fixtures** assert on diff/undo output; `git --no-color diff` was already
   wrong once in a way that produced empty output rather than an error.

To collect it: push and read `gh run view` for the `cli` job on both legs. If it is red, that is
a Phase 1 defect to fix, not a CI problem to work around.

## Phase 1 — done, with the evidence

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
5. **`DEPENDENCY_LICENSES.json` is stale.** `oxlint` (1.94.0) and `@opencode/plugin` (2.3.2,
   now a root devDependency so staged plugins can resolve it) are not in the inventory.
   Regenerate before any release.
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
