# Bashwink — Implementation Status

**Snapshot:** 2026-11-23, after the final Phase 0 remediation.
**Canonical per-task register:** `BASHWINK_TASKS_90.csv`.
**The block below is generated** by `scripts/generate_status_summary.py` — do not hand-edit
it. `--check` fails if it drifts from the register.

<!-- BEGIN GENERATED:status -->

| Phase | Tasks | Done | In progress | Blocked | Not started |
| --- | ---: | ---: | ---: | ---: | ---: |
| P0 | 9 | 8 | 1 | 0 | 0 |
| P1 | 10 | 0 | 0 | 0 | 10 |
| P2 | 15 | 0 | 0 | 0 | 15 |
| P3 | 19 | 0 | 0 | 0 | 19 |
| P4 | 13 | 0 | 0 | 0 | 13 |
| P5 | 8 | 0 | 0 | 0 | 8 |
| P6 | 9 | 0 | 0 | 0 | 9 |
| P7 | 7 | 0 | 0 | 0 | 7 |
| **Total** | **90** | **8** | **1** | **0** | **81** |

<!-- END GENERATED:status -->

## Phase 0 detail

| ID | Status | What is actually true |
| --- | --- | --- |
| BW-001 | **Done** | `v2.3.2` = `c0ad18b40` pinned; MIT; Bun 1.4.4 pinned. The suite was re-run under the **exact pinned Bun 1.4.4** (47/47), closing the version-drift gap. Baseline commit exists. |
| BW-002 | **Done** | Upstream suites: **8,004 pass / 48 skip / 0 fail** with bash ≥ 4 (7,556 core + 408 CLI + 40 SDK). 198 MB binary builds and runs. The 3 initial failures were macOS `/bin/bash` 3.2.57, proven by re-running under bash 5.3.20. |
| BW-003 | **Done** | Tool lifecycle, deny path and `ctx.location.directory` proven live. Two load-bearing runtime constraints found (ADR-002). |
| BW-004 | **Done** | ADR-001 accepted; owner assigned; review decisions recorded in `DECISIONS.md`. |
| BW-005 | **Done** | Licensing resolved **by changing what ships**, not by reinterpreting a licence (ADR-009). Two models defined: PM-0 (plugin only, zero FFmpeg exposure) and PM-1 (binary built from pinned OpenTUI `v0.8.4` **without FFmpeg** — verified to build, load, pass the ABI check and render the TUI; 796 FFmpeg symbols → 0 genuine). `generate_notices.py` emits real attribution bundles per model; `check_license_scope.py --fail-on-open` exits **0**. |
| BW-006 | **In progress** | CI configuration corrected and every step **validated locally** (install, tests, typecheck, docs, license scope, fixtures, cancellation/rollback scenarios, secret scan). `macos-14` → `macos-15`. **But there is still no hosted run**: no git remote exists and `gh` is not authenticated. Acceptance ("a PR gets deterministic status") is unmet until a run exists. |
| BW-007 | **Done** | 5 fixtures, deterministic baselines, reset proven both directions, failure reproduced at baseline. **Cancellation and rollback scenarios now actually executed** (`fixtures/scenario_check.sh`, 8/8) — previously created-and-reset but never run. |
| BW-043 | **Done** | Sync report verified against real diffs; exits 1 on breaking changes; never merges. |
| BW-090 | **Done** | ADR-001…009 written with evidence; owners assigned; decisions recorded. |

## Phase 0 gate: 3 of 4 met — FAIL

| Gate condition | State | Why |
| --- | --- | --- |
| Foundation builds on a clean supported machine | **PARTIAL** | macOS arm64 verified end-to-end. A Linux leg exists only as workflow YAML and has never executed. |
| Baseline tests and ≥1 controlled tool call recorded | **MET** | 8,004 pass / 0 fail; ok, fail (`exit=7`) and denial paths all captured; mock now reports failures honestly. |
| Extension seams demonstrated or limits accepted | **MET** | before/after/deny proven live; gaps accepted in ADR-002/003. |
| No unresolved distribution-blocking license/branding | **MET** | ADR-009: no LGPL obligation attaches to PM-0 or PM-1-no-FFmpeg. Release gate exits 0. |

**The single remaining blocker is BW-006: CI has never run.**
That is a *process* blocker requiring owner action (a remote and a push), not an engineering
one. See `NEXT_STEPS.md`.

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

## What this snapshot still does not cover

- No hosted CI run of any kind. This is the only unmet gate condition.
- No Linux/Windows execution of any Bashwink command.
- The no-FFmpeg library is functionally but not byte-reproducible (Zig embeds 194 build paths).
- OpenTUI's own native test suite was not run against the no-FFmpeg build.
- No real-model agent run; all turns used the local mock provider.
- The wrapper CLI (ADR-003) does not exist.
- No legal review. The determination removes known LGPL exposure; it is not legal advice.
