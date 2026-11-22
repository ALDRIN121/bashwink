# Bashwink — independent Phase 0 verification and corrective-action report

**Review date:** 2026-11-23  
**Reviewed:** user-provided `BASHWINK_PHASE_0_AUDIT.zip`  
**Decision:** **PHASE 0 GATE FAIL — DO NOT BEGIN PHASE 1**

## Scope and evidence quality

I inspected the archive's audit report, 6 ADRs, status and gate files, CI workflow, source and tests, licensing/security reports, upstream baseline and test result summaries, and 61-file full-tree patch. The package manifest lists **44 files**; all 44 exist at the advertised byte sizes and SHA-256 hashes. These hashes verify package consistency, not truth of the claims or integrity against its author.

The local agent reports **8,004 upstream passing tests** (7,556 core + 408 CLI + 40 SDK; 48 skips) and **32 Bashwink evidence tests**, running on **one macOS arm64 host using Bun 1.4.5**. The package includes excerpts with hashes of full logs but not the full logs, upstream checkout, binaries, or a CI run. I did **not** independently rerun those upstream suites. The bash 3.2 versus 5.3 explanation is plausible and supported by the supplied run summaries, but not separately replicated here.

The report labels 7/9 tasks complete, BW-005 and BW-006 in progress. BW-004 and BW-090 are marked done despite missing the documented owner/signoff criterion, and BW-001 says files are committed even though the repository has **zero commits**. Treat the effective acceptance state as **7 reported done, 2 in progress, with at least 3 acceptance-criteria exceptions** until reconciled.

## Verified additional findings (not adequately reflected in the submitted audit)

### F-01 — High: obsolete GitHub Actions runner

`07_ci/verify.yml` lines **41 and 60** use `macos-14`. GitHub retired the `macos-14` label **2026-11-02**, before the workflow was authored. Replace with a supported label such as `macos-15`, and run CI for real. Official announcement: https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/

**Acceptance:** both platform jobs schedule and pass; evidence includes actual workflow URL, commit, matrix job outcomes and logs. Do not claim CI passed until that has happened.

### F-02 — High: object payloads bypass the maxText limit

`04_source/bw-evidence__recorder.ts` lines **140–150** in `normalise()` truncate long **strings** but return large **objects** unchanged: `value: typeof safe === "string" ? ... : safe`. The `truncated` flag still becomes `true`.

I executed the supplied `recorder.ts` via Node 22's TypeScript type-stripping: `normalise({nested:{message:'x'.repeat(10000)}},100)` yielded a **10,025-character serialized payload** with `truncated: true`. This is directly reproduced against the submitted code and is absent from the supplied tests (which cover only long strings).

**Fix:** serialize sanitized values to a bounded representation, or use a well-defined bounded field/summary scheme; cap bytes rather than ambiguous JS character counts if using a byte budget, then ensure hashes are calculated over the sanitized *full* value. Add nested-object, array, multibyte and large-output tests, and verify no secret is logged beyond the cap.

### F-03 — High: note fields bypass redaction

`recorder.ts` `recordTool()` lines **207–231** directly writes `fields.note`; it also exposes lower-level `record()` that accepts arbitrary payloads. I executed a test with a synthetic Bearer token in `note`; the token **survived unredacted** on disk. This contradicts the unconditional no-secrets claim in `SECURITY_REVIEW.md`. No real credential was involved or observed.

**Fix:** centralize sanitization/size enforcement at the *final write boundary*, including `note`, error objects and call metadata. Add regression tests for sensitive-note and raw-record entrypoints. Avoid claiming all secrets are impossible to log; pattern matching cannot guarantee that.

### F-04 — Medium/high: exact pinning and runtime packaging are not proven

`packages/bw-evidence/package.json` declares `@opencode/plugin: "^2.3.2"` as an optional peer, while ADR-001 calls for an **exact** OpenCode 2.3.2 pin. The registry checks only confirm that packages exist; no fresh project installed and actually invoked the published runtime/wrapper. Fix the declared version policy and run clean-install/package-resolution/wrapper passthrough tests before treating ADR-001 as validated.

### F-05 — Medium: documentation and task status contradict the tree

A root `LICENSE` exists in the patch and in the archive, yet:
- `THIRD_PARTY_NOTICES.md` line 38 says it has not been written.
- `PHASE_GATE_CHECKLIST.md` line 24 says there is no root `LICENSE`.
- `IMPLEMENTATION_STATUS.md` line 41 says no `LICENSE` and uses an outdated **8,001 pass** tally in line 39.

Use one generated canonical status summary; replace stale claims, but **keep** the genuine missing *generated dependency notice bundle* distinct from an existing project LICENSE file.

### F-06 — Medium/high: reproducibility and signoff criteria unmet

The archive reports **zero Git commits**. BW-001 specifically requires committed baseline documentation; BW-004 requires a signed-off ADR; BW-090 requires owned ADRs. ADR owners are 'unassigned'. Assign an accountable maintainer, preserve a local baseline commit, and record approval/review. This is an acceptance-gap correction, not a license gate substitute.

### F-07 — High for planned distribution: LGPL compliance needs an actual strategy

The audit identifies `@opentui/core-darwin-arm64@0.8.4`, whose metadata lists `MIT AND LGPL-2.1-or-later`, with FFmpeg in the bundled native library. This is consistent with official OpenTUI distribution guidance: https://opentui.com/docs/ship/deploy/ . FFmpeg also publishes an LGPL-compliance checklist: https://www.ffmpeg.org/legal.html .

A static distribution might require more than shipping copied notices and a generic upstream source URL: identify matching source/build configuration and the legally adequate modification/relinking route. Confirm details for the **exact shipped artifact/version**; obtain competent legal review before release. OpenTUI's *current* documentation explains separate native libraries and an FFmpeg-disabled build, but do not assume such build options work unchanged at the **pinned 0.8.4** version without testing.

**Before release:** generate license/notice distribution, inspect actual shipped dependency graph, include OpenTUI's version-matched `LICENSE-FFMPEG` and `FFMPEG-SOURCE.md` (or equivalents), and validate replacement/relinking compliance as applicable. A bare 'block all GPL/AGPL/SSPL/BUSL anywhere in node_modules' test is an incomplete substitute for distribution-specific license assessment.

### F-08 — Medium: evidence chain limitations are real

`verify()` checks hashes but a fully deleted tail or a recomputed chain can still appear valid; `resume()` accepts the last record without verifying the chain on startup; hooks suppress recorder exceptions to keep tool execution alive, potentially silently losing evidence. The project acknowledges several of these limitations. At minimum, test and report a 'logging degraded / verification unknown' state and avoid claiming a complete, immutable audit trail. Independent proof signing and multi-writer control may remain future-phase scope if the Phase 0 gate explicitly accepts those limitations.

### F-09 — Medium: CI scope is narrower than upstream results

The proposed workflow tests docs, the Bashwink evidence package, and fixture scripts, but **does not run the upstream 8,004-test suite**. Do not equate a future passing `verify.yml` with reproduced upstream baseline parity. Either add a deliberate upstream smoke lane, or specify full upstream CI as an independent periodic compatibility check.

### F-10 — Security guarantees must remain appropriately limited

No sandbox, dependency vulnerability scan, or real-model validation is present. The plugin ordering and auto-discovery hazards were correctly discovered. Treat the running agent as having the **current user's filesystem and network privileges** until an actual enforced sandbox exists; never present permission prompting as isolation.

## Corrected Phase 0 decision

| Gate | Assessment |
| --- | --- |
| Clean foundation build | **Partial evidence**: macOS arm64 only; binary/run summaries supplied, no independently executed build |
| Baseline tests + tool-call record | **Supported by summaries, not reproduced here**: reported 8,004 passes and three mock-provider lifecycle paths |
| Extension seams demonstrated/limits accepted | **Substantially supported** for before/after/deny; event subscription and permission-evaluation hooks not exercised |
| No unresolved distribution-blocking licensing/branding | **FAIL**: required compliance and installation/distribution approach not validated |
| Phase 0 overall | **FAIL** |

## Prioritized correction order for coding agent

1. **Repair the evidence logger**: object-size cap, all-field redaction, regression tests, and correct documentation. Do not weaken tests.
2. **Repair CI configuration**: replace retired `macos-14`; add root lint/typecheck; license checks; confirm on supported platforms with actual run evidence.
3. **Finish BW-005 licensing**: version-matched artifact contents and an actionable compliant distribution approach; generated notices, attribution, source/build/relinking mechanism as legally applicable. Escalate for legal confirmation.
4. **Validate packaging assumption**: clean install exact package versions from registry in a scratch environment, invoke the plugin, and verify wrapper feasibility. Use exact versions or document the deliberate choice otherwise.
5. **Repair governance**: reconcile stale docs, assign ADR owner, review and sign off, create the initial local Git commit without pushing without approval.
6. **Close BW-006 and prove CI**: actual GitHub Actions run URL or an equivalent local runner report, with clear platform limits. CI run on a hosted branch may require project owner approval to push.
7. **Reissue Phase 0 report** with real statuses, commands, exit codes, source commit hashes, license artifacts, successful CI evidence, and remaining limitations. Keep Phase 1 unstarted.

## Suggested acceptance tests

- `normalise()` must limit JSON-serialized **nested objects and arrays**, including multibyte text, not just strings.
- A realistic synthetic Bearer token in `note`, `call` metadata and error details must never be present unredacted on disk.
- Evidence logging failure should be surfaced as **unknown/degraded verification**, not silently treated as verified.
- CI runs with active runner labels and same toolchain pin; positive and negative secret-scan fixtures are tested.
- The clean consumer installation invokes the OpenCode plugin using version `2.3.2` in a new scratch directory, without resolving hidden dependencies from the local upstream checkout.
- A Git revision and signed-off ADR are traceable to every Phase 0 task marked done.

*Scope note:* this document is technical review, not legal advice. License interpretation for planned distribution requires version-specific packaging review and, if material, a qualified professional.
