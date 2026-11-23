# Bashwink — Implementation Status

**Snapshot:** 2026-11-23, Phase 0 **complete and gate-passed** with real CI evidence.
**Canonical per-task register:** `BASHWINK_TASKS_90.csv`.
**The block below is generated** by `scripts/generate_status_summary.py` — do not hand-edit
it. `--check` fails if it drifts from the register.

<!-- BEGIN GENERATED:status -->

| Phase | Tasks | Done | In progress | Blocked | Not started |
| --- | ---: | ---: | ---: | ---: | ---: |
| P0 | 9 | 9 | 0 | 0 | 0 |
| P1 | 10 | 0 | 0 | 0 | 10 |
| P2 | 15 | 0 | 0 | 0 | 15 |
| P3 | 19 | 0 | 0 | 0 | 19 |
| P4 | 13 | 0 | 0 | 0 | 13 |
| P5 | 8 | 0 | 0 | 0 | 8 |
| P6 | 9 | 0 | 0 | 0 | 9 |
| P7 | 7 | 0 | 0 | 0 | 7 |
| **Total** | **90** | **9** | **0** | **0** | **81** |

<!-- END GENERATED:status -->

## Phase 0 detail

| ID | Status | What is actually true |
| --- | --- | --- |
| BW-001 | **Done** | `v2.3.2` = `c0ad18b40` pinned; MIT; Bun 1.4.4 pinned. The suite was re-run under the **exact pinned Bun 1.4.4** (47/47), closing the version-drift gap. Baseline commit exists. |
| BW-002 | **Done** | Upstream suites: **8,004 pass / 48 skip / 0 fail** with bash ≥ 4 (7,556 core + 408 CLI + 40 SDK). 198 MB binary builds and runs. The 3 initial failures were macOS `/bin/bash` 3.2.57, proven by re-running under bash 5.3.20. |
| BW-003 | **Done** | Tool lifecycle, deny path and `ctx.location.directory` proven live. Two load-bearing runtime constraints found (ADR-002). |
| BW-004 | **Done** | ADR-001 accepted; owner assigned; review decisions recorded in `DECISIONS.md`. |
| BW-005 | **Done** | Licensing resolved **by changing what ships**, not by reinterpreting a licence (ADR-009). Two models defined: PM-0 (plugin only, zero FFmpeg exposure) and PM-1 (binary built from pinned OpenTUI `v0.8.4` **without FFmpeg** — verified to build, load, pass the ABI check and render the TUI; 796 FFmpeg symbols → 0 genuine). `generate_notices.py` emits real attribution bundles per model; `check_license_scope.py --fail-on-open` exits **0**. |
| BW-006 | **Done** | **Real GitHub Actions runs on both supported platforms.** `verify.yml` green **9/9 jobs** on `ubuntu-latest` and `macos-15` at `c536466` ([45111515216](https://github.com/ALDRIN121/bashwink/actions/runs/45111515216)) — nine because the **root lint gate BW-006's acceptance required was genuinely missing** and has now been added (`bun fmt --check`, proven to fail on bad input as well as pass on the tree). Earlier green runs: [45065505536](https://github.com/ALDRIN121/bashwink/actions/runs/45065505536), [45066245596](https://github.com/ALDRIN121/bashwink/actions/runs/45066245596). `upstream-compat.yml` green on both legs including the upstream baseline — ubuntu **7,251 pass / 345 skip / 0 fail**, macos-15 **7,561 / 34 / 0** ([45066246923](https://github.com/ALDRIN121/bashwink/actions/runs/45066246923)). Two real defects were found and fixed by CI that local validation had missed (secret-scan placeholder literals; ripgrep download attempt). |
| BW-007 | **Done** | 5 fixtures, deterministic baselines, reset proven both directions, failure reproduced at baseline. **Cancellation and rollback scenarios now actually executed** (`fixtures/scenario_check.sh`, 8/8) — previously created-and-reset but never run. |
| BW-043 | **Done** | Sync report verified against real diffs; exits 1 on breaking changes; never merges. |
| BW-090 | **Done** | ADR-001…009 written with evidence; owners assigned; decisions recorded. |

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

- Windows was never exercised: neither workflow has a Windows leg.
- The no-FFmpeg native library was verified on macOS arm64 only.
- `upstream-compat` runs weekly + manually, not per-PR (deliberate cost trade-off, documented).
- The no-FFmpeg library is functionally but not byte-reproducible (Zig embeds 194 build paths).
- OpenTUI's own native test suite was not run against the no-FFmpeg build.
- No real-model agent run; all turns used the local mock provider.
- The wrapper CLI (ADR-003) does not exist.
- No legal review. The determination removes known LGPL exposure; it is not legal advice.
