# Bashwink — Implementation Status

**Snapshot:** 2026-11-23, after the independent Phase 0 review remediation.
**Canonical per-task register:** `BASHWINK_TASKS_90.csv`.
**The block below is generated** by `scripts/generate_status_summary.py` — do not hand-edit
it. `--check` fails if it drifts from the register.

<!-- BEGIN GENERATED:status -->

| Phase | Tasks | Done | In progress | Blocked | Not started |
| --- | ---: | ---: | ---: | ---: | ---: |
| P0 | 9 | 7 | 2 | 0 | 0 |
| P1 | 10 | 0 | 0 | 0 | 10 |
| P2 | 15 | 0 | 0 | 0 | 15 |
| P3 | 19 | 0 | 0 | 0 | 19 |
| P4 | 13 | 0 | 0 | 0 | 13 |
| P5 | 8 | 0 | 0 | 0 | 8 |
| P6 | 9 | 0 | 0 | 0 | 9 |
| P7 | 7 | 0 | 0 | 0 | 7 |
| **Total** | **90** | **7** | **2** | **0** | **81** |

<!-- END GENERATED:status -->

## Phase 0 detail

| ID | Status | What is actually true |
| --- | --- | --- |
| BW-001 | **Done** | `v2.3.2` = `c0ad18b40` pinned; MIT; Bun 1.4.4 pinned (host runs 1.4.5). **Baseline commit created in this remediation** — the criterion had been claimed while the repository still had zero commits. |
| BW-002 | **Done** | Upstream suites: **8,004 pass / 48 skip / 0 fail** with bash ≥ 4 (7,556 core + 408 CLI + 40 SDK). 198 MB binary builds and runs. The 3 initial failures were macOS `/bin/bash` 3.2.57, proven by re-running the identical suite under bash 5.3.20. |
| BW-003 | **Done** | Tool lifecycle, deny path and `ctx.location.directory` proven live. Two load-bearing runtime constraints found (ADR-002). |
| BW-004 | **Done** | ADR-001 accepted. Owner assigned and review recorded in `DECISIONS.md` during this remediation. |
| BW-005 | **In progress** | Licensing *assessment* complete: 1,641 packages inventoried, all 48 copyleft/unresolved entries carry a recorded decision, machine-checked by `scripts/check_license_scope.py`. **Not done:** the generated notices bundle, the OpenTUI/FFmpeg distribution artifacts, legal sign-off. The one release-blocking item (`@opentui/core-darwin-arm64`, FFmpeg) is still `OPEN`. |
| BW-006 | **In progress** | CI configuration corrected — retired `macos-14` replaced with `macos-15`, license-scope and secret-scan positive-control jobs added. The workflow has still **never run on a hosted runner**, so "a PR gets deterministic status" remains unmet. |
| BW-007 | **Done** | 5 fixtures, deterministic baselines, reset proven both directions, failure reproduced at baseline. |
| BW-043 | **Done** | Sync report verified against real diffs; exits 1 on breaking changes; never merges. |
| BW-090 | **Done** | ADR-001…006 written with evidence; owners assigned and decisions recorded. |

## Phase 0 gate: still FAIL

| Gate condition | State | Why |
| --- | --- | --- |
| Foundation builds on a clean supported machine | **PARTIAL** | macOS arm64 verified. A Linux leg is configured in CI and has never executed. |
| Baseline tests and ≥1 controlled tool call recorded | **MET** | 8,004 pass / 0 fail; success, failure and denial paths all captured. |
| Extension seams demonstrated or limits accepted | **MET** | before/after/deny proven live; gaps accepted in ADR-002/003. |
| No unresolved distribution-blocking license/branding | **NOT MET** | FFmpeg/LGPL compliance artifacts do not exist; that decision is legitimately `OPEN`. |

**Do not begin Phase 1.** See `NEXT_STEPS.md`.

## Corrections made in this remediation

1. **Evidence recorder** — object/array payloads bounded by UTF-8 bytes; every payload field
   including `note` and call metadata redacted at one write boundary; degraded state surfaced
   instead of swallowed. 15 new regression tests (47 total).
2. **CI** — `macos-14` → `macos-15` (the former was retired 2026-11-02). License-scope gate,
   secret-scan positive control, scope-statement job and root typecheck added.
3. **Licensing** — machine-readable inventory (`DEPENDENCY_LICENSES.json`), a recorded
   decision per package, `check_license_scope.py` enforcing them, `--fail-on-open` for release
   gating.
4. **Dependency pinning** — `@opencode/plugin` caret replaced by exact `2.3.2`; a clean
   registry install in a scratch directory verified the plugin loads and typechecks against
   the real published package.
5. **Documentation** — status block generated from the register; stale `LICENSE` and test
   tally claims corrected.
6. **Git baseline** — initial commit created; nothing pushed.

## What this snapshot still does not cover

- No Linux/Windows execution of any Bashwink command (CI configured, not run).
- No hosted CI run of any kind.
- No real-model agent run; all turns used the local mock provider.
- The wrapper CLI (ADR-003) does not exist.
- No legal review of the FFmpeg position.
