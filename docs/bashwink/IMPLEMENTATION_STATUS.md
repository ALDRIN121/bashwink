# Bashwink — Implementation Status

**Snapshot:** 2026-11-23, Phase 0 **complete and gate-passed** with real CI evidence;
Phase 1 **complete and gate-passed** — 10/10 tasks, 11/11 CI jobs green on `ubuntu-latest`
and `macos-15` at `ad9d44e` ([run 45129207277](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277)),
and **revalidated** after the silent-plugin-load investigation (ADR-010).
Phase 2 **in progress** — BW-055, BW-059 and BW-091 done (3 of 16). The independent baseline audit ran **369 tests** under Bun 1.4.4. The
runtime-health job runs on the real OpenCode binary on both platforms. Phase 2's gate has
**not** been evaluated.
**BW-091 was added to the register during alpha stabilization**, so the provider/model work now has a task
of its own instead of living in prose. The register is 91 tasks; earlier increments referenced
90, which is a register growth, not a reassignment.
**Internal alpha CONDITIONAL. External alpha FAIL.** See [readiness](INTERNAL_ALPHA_READINESS.md) and [CI reconciliation](CI_BASELINE_RECONCILIATION.md).

**Canonical per-task register:** `BASHWINK_TASKS_90.csv`.
**The block below is generated** by `scripts/generate_status_summary.py` — do not hand-edit
it. `--check` fails if it drifts from the register.

<!-- BEGIN GENERATED:status -->

| Phase | Tasks | Done | In progress | Blocked | Not started |
| --- | ---: | ---: | ---: | ---: | ---: |
| P0 | 9 | 9 | 0 | 0 | 0 |
| P1 | 10 | 10 | 0 | 0 | 0 |
| P2 | 16 | 3 | 3 | 0 | 10 |
| P3 | 19 | 0 | 1 | 0 | 18 |
| P4 | 13 | 0 | 2 | 0 | 11 |
| P5 | 8 | 0 | 0 | 0 | 8 |
| P6 | 9 | 0 | 0 | 0 | 9 |
| P7 | 7 | 0 | 0 | 0 | 7 |
| **Total** | **91** | **22** | **6** | **0** | **63** |

<!-- END GENERATED:status -->

## Direction change (2026-11-25)

Standard native mode is now the default product and the VM is the optional sandbox ([ADR-015](DECISIONS.md)). RC2 (`20c8473b`) is the
optional-sandbox macOS artifact: qualified on the engineering host, not on a clean host. Progress and next actions:
[ALPHA_RELEASE_PROGRESS.md](ALPHA_RELEASE_PROGRESS.md). Task register unchanged (22 Done, 4 In progress, 65 Not started).

## v0.1.0-alpha.1 release candidate RC1 — gate evaluated, external alpha FAIL

Feature work is frozen. The candidate (`13f003d`) adds a release build whose default is the
isolated VM with no host fallback, a separate acknowledged unrestricted mode, pinned VM asset and
host checks, first-run workspace approval, a self-contained archive with installer and
uninstaller, and release harnesses. It does **not** complete BW-031 or BW-032 (both `In progress`).
The macOS-only scope is a narrowing of what the candidate advertises, recorded in ADR-013.
Verified on an engineering host: 493 unit and integration tests, installed PTY flows, release-image
acceptance and egress probe. **Not** verified: clean host, live coding, hosted CI, licensing
sign-off. [Gate report](releases/v0.1.0-alpha.1/RELEASE_GATE_REPORT.md) ·
[qualification](releases/v0.1.0-alpha.1/QUALIFICATION_RESULTS.md) ·
[performance](releases/v0.1.0-alpha.1/PERFORMANCE.md).

## VM provider relay milestone — PARTIAL

The host relay accepts a per-run capability over a private VM socket, selects a fixed
provider route and configured model, and supplies the provider credential only on the
host. An isolated OpenCode PTY completed a scripted synthetic-provider coding task,
resume, reviewed export and protected tests. This fixture does not qualify a paid
provider. A bounded live CommandCode coding task has since passed. Broader provider error and cancellation handling remain unverified. Later
fixture observations cover a model switch and two live cancellation controls. Authentication and rate-limit statuses have synthetic controls. Other upstream failures
currently become a generic relay failure. External alpha remains blocked. See [test evidence](TEST_EVIDENCE.md).

## Permission and backend foundation

**BW-018 and BW-030 remain In progress.** Hosted macOS runtime checks and both CLI jobs passed.
The Ubuntu real-runtime readiness fixture failed, and further hosted execution is paused.
The private server validates
policy readiness before prompt admission. The local backend owns client and server and reports
cancellation, deadlines, exits and readiness failures. Phase 2 has **3/16 Done** and Phase 3
remains open. The ordinary local backend still runs commands with the user's host access.
[BW-018 implementation](BW-018_IMPLEMENTATION_REPORT.md) · [BW-030 design](BW-030_EXECUTION_BACKEND_DESIGN.md) · [Test evidence](TEST_EVIDENCE.md).

**BW-031 and BW-032 remain In progress (PARTIAL).** The experimental macOS file-only
offline profile has tested Seatbelt confinement and stage protection through launcher
SIGKILL. Shell-capable startup is disabled after the detached-writer failure.
File-only Seatbelt export has interruption reconciliation. The locally provisioned
Apple Silicon VM profile persists bounded Git project files and OpenCode sessions
after clean shutdown. Host review supports selected additions, edits and deletions.
The per-file journal and receipts support interrupted apply, and protected tests
run in a fresh VM against bytes independently captured from the host. The wider
release workspace workflow and platform qualification remain open.
[Mac-only alpha scope](releases/v0.1.0-alpha/RELEASE_READINESS.md)
Ubuntu qualification, live provider connectivity, and external alpha remain blocked.
[Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## LLM integration (BW-091)

Real-model coding works end to end through the pinned runtime. What Bashwink adds is narrow
and load-bearing: provider configuration without storing a key, model selection and switching,
and per-call model attribution in the evidence chain.

BW-091 (register task, Done):

| Capability | State | Where |
| --- | --- | --- |
| Configure an OpenAI/Anthropic-compatible provider without persisting a key | **Done, tested** | `auth add`, `providers.ts` |
| Per-model wire protocol on a mixed provider | **Done, tested** | `--model id:protocol` |
| Credential status with no value disclosed | **Done, tested** | `auth status`, `auth check` |
| Model list / default selection / refusal of unknown models | **Done, tested** | `model list\|use\|current` |
| Pre-flight credential failure naming the variable | **Done, tested** | `main.ts` pre-flight |
| Model attribution per tool call, per session | **Done, tested on the real binary** | `bw-evidence` plugin |
| Model usage table in the export | **Done, tested** | `evidence export` |
| Clean install outside the checkout | **Done, verified** | `scripts/build_alpha.sh` |
| A second independently credentialed provider | **NOT verified — BLOCKED** | see TEST_EVIDENCE matrix |

## BW-059 ScopeFence — enforced (Done)

`allowedPaths` is now compiled into an execution-time policy and enforced in the plugin's
`execute.before` hook, the one tool hook whose failure rejects a call before the tool body runs.
The wrapper writes the policy per run from the approved contract; the plugin reads it once at
setup, so a mid-run write cannot change its own fence.

Verified with a live model (`fixtures/scope-fence/run.sh`, 10/10):

| Attack | Outcome |
| --- | --- |
| `../bw-scope-outside/pwned.txt` | refused, file absent |
| `/tmp/bw-scope-outside/absolute.txt` | refused, file absent |
| symlink `link -> /etc` then `link/passwd` | refused (containment on `realpath`) |
| shell `workdir` outside the readable roots | refused |
| in-scope edit of `src/calc.py` | applied, tests pass |
| edit of the test file | refused, hash unchanged |

**Scope of the guarantee.** The loaded evidence plugin checks recognized file tool calls and
rejects recognized shell calls with disallowed working directories or evident out-of-scope
paths. Allowed shell calls are recorded as `unconstrained` and run with the user’s access.
The loaded hook refuses malformed and unclassified requests. The owned-server readiness gate
is covered by the real-runtime fixture. BW-059 remains recorded Done for its narrower policy seam.

Also corrected this increment: **workspace trust is now enforced.** It was recorded and shown by
`doctor` as "denied by default" while `evaluateCall` was never called, so the claim was false. With the policy loaded, an
untrusted workspace now refuses recognized writes and shell calls.

**Remaining alpha risk:** there is still no OS-level sandbox (BW-031), so shell remains an escape
hatch. For a small supervised alpha that is acceptable and documented; for unattended use it is
not.

The revised architecture makes native Seatbelt and Bubblewrap the preferred isolation
paths and keeps Docker optional. The starting proof covers narrow macOS primitives.
Full native policy, provider transport, platform qualification and descendant cleanup
remain open. **BW-031 and BW-032 are In progress.** The installed macOS probe passed six controls.
The installed offline TUI completed a real mock coding turn inside Seatbelt. The separate
file-only profile reopens saved sessions and applies an explicitly approved single-file
export. Detached cleanup failed under the shell-enabled fixture. General native admission
and platform qualification remain open.
[Implementation milestone](BW-031_IMPLEMENTATION_REPORT.md) · [Qualification results](BW-032_QUALIFICATION_RESULTS.md).
[Feasibility](BW-031-SANDBOX-PROPOSAL.md) · [Implementation plan](BW-031_IMPLEMENTATION_PLAN.md).

The interactive TUI was smoke-tested with a real coding task and a session restart; that run
found two defects, both fixed (an unattributable refusal, and "may have done real work" reported
for a process that never started). The TUI's own in-session model picker was **not** exercised.

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
- Earlier releases recorded explicit evidence-off runs as `disabled`. Current launches require readiness.
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
- The original foundation suite used the mock provider. Later CommandCode coding and OpenCode gateway evidence is documented above.
- No legal review. The determination removes known LGPL exposure; it is not legal advice.
- **BW-056** (interactive `contract edit`, assumption ledger, contradiction fixture) is not
  built. BW-055 ships the data plane and the commands approval/revision require.
- **BW-059** covers recognized tool calls under an active policy. A permitted shell still has the user’s OS access.
- Evidence health is proven at plugin *startup*. A plugin that loads and then fails to write
  mid-session degrades the log from that point; the recorder reports degradation, but the boot
  entry alone cannot detect it.
- `bashwink evidence status` and the run records are local to a `BASHWINK_HOME`; they are not
  yet exported in the evidence pack (that is BW-060).


## Live CommandCode VM observation

The installed VM fixture completed a live CommandCode coding task, approved guest
tests, resumed the session, and applied reviewed edits in a disposable checkout.
The provider credential was absent from inspected saved guest state. The narrow test
does not close BW-031 or BW-032. See [test evidence](TEST_EVIDENCE.md).


## Milestone 5 stabilization

The VM apply path now records and safely abandons an interrupted early journal while
retaining unidentified staging. Committed receipts refresh the project baseline on
reopen, including older sequential receipts. The installed fixture exercised SIGKILL,
review, repeated recovery, resume after an applied batch and protected tests. Live
CommandCode tests switched Claude to GPT in one session. Qualification, the
distributable VM installation, and the external-alpha gate remain open.

## 2026-11-25: private alpha, standard (native) npm package

Implemented and verified on macOS arm64: standard build flavor, mode label, fail-closed `--sandbox`, first-run trust offer,
standard help, Node launcher, deterministic tarball builder with a content audit, plugin staging by copy under
`node_modules` and on Windows, `USERPROFILE` home fallback, portable install check, PTY smoke. Written but never run:
`npm-package` and `windows-full-suite` CI jobs. Not implemented: bounded retries, cost/request cap and display. Not
verified: any live model session, Windows, Linux, macOS Intel. See `FINAL_ALPHA_RELEASE_REPORT.md`.

## 2026-11-25: final alpha qualification (standard npm package, candidate `npm-rc2`)

Implemented and verified locally (macOS arm64): usage safeguards (`usage-guard.ts`: bounded retries, request/token/cost limits, summary, exit 4; price declaration `auth add --price`),
credential containment (provider variables removed from shell environments, literal values masked in evidence), changed-test disclosure (`test-changes.ts`), Windows-correct path and PATH handling,
bundled-licence notices enforced by the builder, the installed-package harness (`npm_qual.py`, `script_provider.py`) and the live script (`npm_live.py`, never run live), the Windows tester kit.
**BW-075 and BW-076 are now In progress**: the minimum for the standard alpha exists and is tested; BW-075's acceptance ("never launch another paid model call once the cap is hit") is **not met** (a request in flight is not
recalled) and BW-076's no-progress detector is not built. BW-031 and BW-032 remain In progress. Not done: any live-model result, a Windows 11 run, hosted CI on the candidate (billing block), legal sign-off.
Documents: `FINAL_ALPHA_QUALIFICATION_REPORT.md`, `FINAL_ALPHA_AUDIT.md`, `STANDARD_PACKAGE_LICENSING.md`, `SUPPORTED_PLATFORMS.md`, `SUPPORTED_PROVIDERS.md`, ADR-013, ADR-014.
