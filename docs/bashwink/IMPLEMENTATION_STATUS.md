# Bashwink — Implementation Status

**Snapshot:** 2026-11-23, Phase 0 **complete and gate-passed** with real CI evidence;
Phase 1 **complete and gate-passed** — 10/10 tasks, 11/11 CI jobs green on `ubuntu-latest`
and `macos-15` at `ad9d44e` ([run 45129207277](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277)),
and **revalidated** after the silent-plugin-load investigation (ADR-010).
Phase 2 **in progress** — BW-055 done; 252 tests; local evidence on both the CLI and the real
OpenCode v2.3.2 binary. Phase 2's gate has not been evaluated.
**Canonical per-task register:** `BASHWINK_TASKS_90.csv`.
**The block below is generated** by `scripts/generate_status_summary.py` — do not hand-edit
it. `--check` fails if it drifts from the register.

<!-- BEGIN GENERATED:status -->

| Phase | Tasks | Done | In progress | Blocked | Not started |
| --- | ---: | ---: | ---: | ---: | ---: |
| P0 | 9 | 9 | 0 | 0 | 0 |
| P1 | 10 | 10 | 0 | 0 | 0 |
| P2 | 15 | 1 | 0 | 0 | 14 |
| P3 | 19 | 0 | 0 | 0 | 19 |
| P4 | 13 | 0 | 0 | 0 | 13 |
| P5 | 8 | 0 | 0 | 0 | 8 |
| P6 | 9 | 0 | 0 | 0 | 9 |
| P7 | 7 | 0 | 0 | 0 | 7 |
| **Total** | **90** | **20** | **0** | **0** | **70** |

<!-- END GENERATED:status -->

## Phase 0 detail

| ID | Status | What is actually true |
| --- | --- | --- |
| BW-001 | **Done** | `v2.3.2` = `c0ad18b40` pinned; MIT; Bun 1.4.4 pinned. The suite was re-run under the **exact pinned Bun 1.4.4** (47/47), closing the version-drift gap. Baseline commit exists. |
| BW-002 | **Done** | Upstream suites: **8,004 pass / 48 skip / 0 fail** with bash ≥ 4 (7,556 core + 408 CLI + 40 SDK). 198 MB binary builds and runs. The 3 initial failures were macOS `/bin/bash` 3.2.57, proven by re-running under bash 5.3.20. |
| BW-003 | **Done** | Tool lifecycle, deny path and `ctx.location.directory` proven live. Two load-bearing runtime constraints found (ADR-002). |
| BW-004 | **Done** | ADR-001 accepted; owner assigned; review decisions recorded in `DECISIONS.md`. |
| BW-005 | **Done** | Licensing resolved **by changing what ships**, not by reinterpreting a licence (ADR-009). Two models defined: PM-0 (plugin only, zero FFmpeg exposure) and PM-1 (binary built from pinned OpenTUI `v0.8.4` **without FFmpeg** — verified to build, load, pass the ABI check and render the TUI; 796 FFmpeg symbols → 0 genuine). `generate_notices.py` emits real attribution bundles per model; `check_license_scope.py --fail-on-open` exits **0**. |
| BW-006 | **Done** | **Real GitHub Actions runs on both supported platforms.** `verify.yml` green **9/9 jobs** on `ubuntu-latest` and `macos-15` at `bf33e20` ([45112989970](https://github.com/ALDRIN121/bashwink/actions/runs/45112989970)), including a **semantic lint gate** (`oxlint --deny-warnings`, correctness as errors, 5 files / 82 rules) with a committed negative-control fixture proving the gate can fail — and a separate formatting check. Two earlier attempts at this criterion were wrong: lint was initially absent entirely, then satisfied only by a *formatter* (`bun fmt`), which reports nothing semantic. Both corrections are recorded in TEST_EVIDENCE.md rather than re-described. `upstream-compat.yml` green on both legs including the upstream baseline — ubuntu **7,251 pass / 345 skip / 0 fail**, macos-15 **7,561 / 34 / 0** ([45113462602](https://github.com/ALDRIN121/bashwink/actions/runs/45113462602) at `bf33e20`, the lint-gate commit). Two real defects were found and fixed by CI that local validation had missed (secret-scan placeholder literals; ripgrep download attempt). |
| BW-007 | **Done** | 5 fixtures, deterministic baselines, reset proven both directions, failure reproduced at baseline. **Cancellation and rollback scenarios now actually executed** (`fixtures/scenario_check.sh`, 8/8) — previously created-and-reset but never run. |
| BW-043 | **Done** | Sync report verified against real diffs; exits 1 on breaking changes; never merges. |
| BW-090 | **Done** | ADR-001…009 written with evidence; owners assigned; decisions recorded. |

## Phase 1 detail

`packages/bw-cli` — the `bashwink` executable. 141 tests, typecheck clean, lint clean.

| ID | Status | What is actually true |
| --- | --- | --- |
| BW-008 | **Done** | `bashwink --version` / `--help` exit 0 and carry Bashwink's name (ADR-003 wrapper finally implemented). Arg passthrough verified by asserting the *documented* 127 "runtime not found" path rather than a cosmetic success. `BASHWINK_HOME` relocates all state; `OPENCODE_CONFIG_DIR` plus all four XDG roots are set for the child so a real OpenCode install is never touched. |
| BW-009 | **Done** | `doctor` runs 8 real checks and exits 1 when a precondition is missing, 0 when not. Credential reporting is present/length/fingerprint only — asserted with a planted sentinel that must not appear in stdout *or* stderr. Warns (not fails) on optional Docker and absent credentials, because a mock provider is a legitimate configuration. |
| BW-010 | **Done** | Untrusted-by-default, expressed as data (`read: allow`, `write/shell/network: deny`) so the acceptance criterion is assertable. `--by` attribution is required; an explicit `--approve` resolves a policy `ask` but can never override a hard `deny`. Sibling-directory, symlink and `..` trust-escape tests. |
| BW-011 | **Done** | `assertEditable()` is the single gate; a `draft` or `rejected` plan cannot write (asserted by unchanged file bytes, not by reading the flag). Three real git fixtures cover one-file edit, multi-file edit and cancellation; undo is byte-identical and idempotent. |
| BW-012 | **Done** | `bun:sqlite` store, no new dependency. One transaction per migration step, `SchemaTooNewError` when the file is newer than the build, and the rollback is a method exercised by a test rather than a paragraph. Plans, statuses and the full transition log survive reopen. |
| BW-013 | **Done** | Plan contract with a hand-written validator (19 tests): duplicate ids, self/unknown dependencies, cycle detection named by path, approval-without-approver, absolute and `..` file paths. `plan show` renders the graph and `--json` emits the machine schema. |
| BW-014 | **Done** | Proven against the **real** OpenCode v2.3.2 binary, not a mock of it: `before`/`after` joined on call id, `exit=0` captured, `tool=shell`, task-linked, planted secret absent, chain verifies after two runs. `fixtures/tool-lifecycle/run.sh` — 13/13. |
| BW-015 | **Done** | Export keeps `pass` / `fail` / `not_run` distinct end to end (a never-run check is never rendered as a failure), reports a `verified`-but-outstanding contradiction instead of smoothing it, and emits Markdown plus JSON. `digestFile()` exposes the raw-result digest a reviewer can recompute. |
| BW-016 | **Done** | Tool events carry `taskID` read from a durable active-task marker on every call — not captured once at plugin setup, because the plugin outlives task changes. An event with no task carries an explicit `unassignedReason` and is counted in the export. |
| BW-019 | **Done** | Real SIGKILL fixture, 10/10: the unfinished attempt survives and is reported; resume reopens to `in_progress` and never to `verified`; an abandoned attempt is not counted as applied; the identical write happens exactly once (`writes=1`, second skipped by fingerprint). |

**Phase 1 gate (release/exit criteria):**

- [x] **Run the one-file bug-fix fixture from a clean install** — `fixtures/idempotent-resume`
      and the `BW-011` git fixtures both run from a throwaway `BASHWINK_HOME` with no ambient
      state.
- [x] **Tool events have task/run identifiers, exit statuses and redacted outputs** — verified
      against the real runtime (`fixtures/tool-lifecycle`, 13/13), including a planted secret
      that must not appear.
- [x] **Killing the process does not claim an unfinished test passed or double-apply a patch** —
      real SIGKILL fixture, 10/10.
- [x] **Planning mode cannot silently perform edits, and the Git diff/undo flow is
      reproducible** — `assertEditable` plus three git fixtures.
- [x] **Demonstration end-to-end** (`doctor → plan → patch → terminate → resume → inspect
      events`) — `fixtures/phase1-demo/run.sh` runs all eight stages as **one** scripted
      walkthrough on one plan, then asserts its own claims: the after-event joins its
      before-event, `exit=0` was captured, every event is task-linked, the killed task is back
      in `in_progress` rather than `verified`, nothing was verified by the interruption, and the
      hash chain still verifies. **DEMONSTRATION PASSED (8 stages).**

## Phase 1 revalidation — the silent plugin load (2026-11-23)

Phase 1's own risk list said failing to stage the evidence plugin was silent. It was worse
than that: **staging successfully and failing to load was also silent.** Reproduced against
the pinned OpenCode v2.3.2 binary:

| Failure | Runtime exit | Evidence | Trace |
| --- | ---: | --- | --- |
| entry throws at import | 0 | empty | one `WARN failed to load plugin` in `opencode.log` |
| no resolvable server entry | 0 | empty | **nothing** |
| wrong export shape | 0 | empty | one `WARN failed to load plugin` |

The wrapper previously equated the child's 0 with success, and the only fixture that could
catch the regression **skipped in CI** for want of the runtime.

**Fixed** (ADR-010):

- `resolvePluginEntry()` mirrors `Host.resolve`; staging refuses a directory the runtime would
  drop, before the process starts.
- The plugin writes a `boot` entry after registering both hooks, keyed by `BASHWINK_RUN_ID`.
- The wrapper writes an expectation record before the run and reconciles it after; a missing
  boot entry prints the run id, entry, evidence path and runtime log path, and exits **3**.
- `BASHWINK_EVIDENCE=off` is the explicit unverified mode, recorded as `disabled`.
- `bashwink evidence status` reports per-run evidence health; `doctor` fails its last-run
  check when a run expected evidence and recorded none.
- CI job `runtime-health` installs the pinned runtime on both platforms and runs the
  four-case fixture — the guarantee is now enforced where it previously had no coverage.

**BW-014 was reopened for this** and re-closed with the new evidence. No Phase 1 acceptance
criterion is now unmet; the gate remains PASSED, with the enforcement gap closed rather than
re-described.

## Phase 2 detail

| ID | Status | What is actually true |
| --- | --- | --- |
| BW-055 | **Done** | TaskContract schema v2 (`contract`, `contract_revision`, `criterion`, `criterion_evidence`) with a tested rollback. Immutable numbered revisions; a revision that omits a criterion marks it `dropped` with a reason and `dropped_in_revision`, never deletes it, and a dropped id cannot be re-added. Criteria are tied to a plan task + declared check; `plan observe` links the observation (including its id and exit code) to every matching criterion and moves its status. `passed` cannot be set without a passing observation. Content revisions reset approval to draft. Once a contract exists, `plan task <id> in_progress` is refused unless it is approved, valid and covers that task. CLI: `contract new|show|approve|revise|status`. 45 new tests plus a 14/14 lifecycle fixture. |

## Phase 0 gate: 4 of 4 met — **PASS**

| Gate condition | State | Why |
| --- | --- | --- |
| Foundation builds on a clean supported machine | **MET** | Verified on two hosted runner images now, not only this laptop: upstream baseline green on `ubuntu-latest` (7,251 / 345 / **0 fail**) and `macos-15` (7,561 / 34 / **0 fail**). |
| Baseline tests and ≥1 controlled tool call recorded | **MET** | 8,004 pass / 0 fail; ok, fail (`exit=7`) and denial paths all captured; mock now reports failures honestly. |
| Extension seams demonstrated or limits accepted | **MET** | before/after/deny proven live; gaps accepted in ADR-002/003. |
| No unresolved distribution-blocking license/branding | **MET** | ADR-009: no LGPL obligation attaches to PM-0 or PM-1-no-FFmpeg. Release gate exits 0. |

**No blockers remain. Phase 1 may begin.** See `NEXT_STEPS.md` for the first tasks and the
risks carried forward.

## Corrections made across the two remediations

1. **Evidence recorder** — object/array payloads bounded by UTF-8 bytes; every field including
   `note` and call metadata redacted at one write boundary; degraded state surfaced. 15 new
   regression tests (47 total).
2. **CI** — `macos-14` → `macos-15` (retired 2026-11-02). Added license-scope gate, secret-scan
   positive control, scope statement, root typecheck, and cancellation/rollback scenarios.
3. **Licensing** — inventory with recorded decisions; release gate; **FFmpeg eliminated from
   the binary distribution model** by rebuilding OpenTUI without it.
4. **Dependency pinning** — exact `2.3.2`; clean registry install verified; plugin shape
   matches the real `Plugin.define`.
5. **Mock provider defect fixed** — it previously printed `exit 7` while claiming
   "printed bw-mock-ok", which made the failure path indistinguishable from success and left
   every transcript's `exit=7` unexplained. Now `--scenario ok|fail`, with the fail path
   honestly reporting the failure.
6. **Fixtures** — cancellation and rollback scenarios executed for the first time (8/8).
7. **Reproducibility** — suite re-run under pinned Bun 1.4.4.
8. **Documentation** — status block generated from the register; stale claims corrected.
9. **CI defects only CI could find** — the secret scan flagged the redaction tests' own
   placeholder literals (fixed with a runtime `credential()` helper, and the scanner's path
   exclusions were *removed* rather than relied on); `upstream-compat` failed because the
   upstream suite downloads ripgrep mid-test when `rg` is absent from `PATH` (fixed by
   installing exactly the pinned 15.1.0 with a SHA-256 check).

## What this snapshot still does not cover

- Windows was never exercised: no workflow has a Windows leg.
- The no-FFmpeg native library was verified on macOS arm64 only.
- `upstream-compat` runs weekly + manually, not per-PR (deliberate cost trade-off, documented).
- The no-FFmpeg library is functionally but not byte-reproducible (Zig embeds 194 build paths).
- OpenTUI's own native test suite was not run against the no-FFmpeg build.
- No real-model agent run; all agent turns used the local mock provider.
- No legal review. The determination removes known LGPL exposure; it is not legal advice.
- **BW-056** (interactive `contract edit`, assumption ledger, contradiction fixture) is not
  built. BW-055 ships the data plane and the commands approval/revision require.
- **BW-059** (ScopeFence) is not built: the contract gates *starting* a task, not each file or
  shell action. A running agent can still write outside `allowedPaths` until that lands.
- Evidence health is proven at plugin *startup*. A plugin that loads and then fails to write
  mid-session degrades the log from that point; the recorder reports degradation, but the boot
  entry alone cannot detect it.
- `bashwink evidence status` and the run records are local to a `BASHWINK_HOME`; they are not
  yet exported in the evidence pack (that is BW-060).
