# Bashwink — Architecture Decision Log

**Owner of record:** Aldrin Joseph (`@aldrinjoseph`), acting as Bashwink maintainer.
Assigned 2026-11-23 to close independent-review finding **F-06**, which correctly observed
that six ADRs naming "Bashwink maintainer (unassigned)" satisfied no sign-off criterion.

**Review record.** ADRs 001–006 were reviewed on 2026-11-23 in response to
`BASHWINK_INDEPENDENT_PHASE0_REVIEW.md`. That review was technical, not a formal governance
sign-off, and is recorded as such — treating a code review as an approval would repeat the
defect the review itself flagged.

| Date | ID | Decision | Evidence | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| 2026-11-22 | ADR-001 | Depend on pinned OpenCode (exact version) + plugins + wrapper CLI; no vendored fork | Clean install, 198 MB build, plugin lifecycle proven live; registry install re-verified 2026-11-23 | Accepted | Aldrin Joseph |
| 2026-11-22 | ADR-002 | All behaviour ships as plugins; evidence plugin must register before any policy plugin | Deny probe prevented execution; ordering swap erased the evidence record | Accepted | Aldrin Joseph |
| 2026-11-22 | ADR-003 | Branding via a companion wrapper CLI, not an in-process rename | No plugin seam for binary name/version; built binary reports `opencode …` | Accepted | Aldrin Joseph |
| 2026-11-22 | ADR-004 | Evidence format: append-only JSONL with a SHA-256 hash chain | 47 tests incl. edit/delete/reorder/truncate detection; live captures | Accepted | Aldrin Joseph |
| 2026-11-22 | ADR-005 | Upstream sync is a report plus a human gate; never an automated merge | `LOW_RISK` on `v2.3.1`, `REVIEW_REQUIRED` (18 declarations) on `v2.2.7` | Accepted | Aldrin Joseph |
| 2026-11-22 | ADR-006 | Deterministic Git fixtures + local mock provider, no real model calls in the gate | 5 fixtures reset deterministically; live tool call and `exit=7` captured | Accepted | Aldrin Joseph |
| 2026-11-23 | ADR-007 | Evidence recorder bounds serialised bytes, sanitises at one write boundary, reports degraded state | 15 new regression tests reproducing review findings F-02/F-03/F-08 | Accepted | Aldrin Joseph |
| 2026-11-23 | ADR-008 | Licensing governed by per-package recorded decisions, not a blanket GPL scan | `DEPENDENCY_LICENSES.json` + `check_license_scope.py`; 48/48 decided, 1 OPEN blocking | Accepted | Aldrin Joseph |
| 2026-11-23 | ADR-009 | Two distribution models (PM-0 plugin-only, PM-1 no-FFmpeg binary); stock LGPL binary is not a release artifact | No-FFmpeg OpenTUI build verified (796 FFmpeg symbols → 0 genuine), ABI + TUI render, `check_license_scope.py --fail-on-open` exit 0 | Accepted | Aldrin Joseph |
| 2026-11-23 | ADR-010 | Evidence health is proven per run (boot entry + run record + exit 3); staging mirrors runtime resolution; TaskContract is an execution gate with non-deletable criteria | `fixtures/runtime-health` 17/17 on the real binary; `fixtures/contract` 14/14; 252 unit/integration tests | Accepted | Aldrin Joseph |

Full text: `ADR-001` … `ADR-010` in this directory.

## Review decisions on the independent review's findings

Each finding is **fixed in code**, **fixed in governance**, or **explicitly accepted with a
stated limitation**. None is silently dropped.

| Finding | Decision | Where |
| --- | --- | --- |
| F-01 retired `macos-14` runner | **Fixed** — replaced with `macos-15`; retirement confirmed from GitHub's changelog | `.github/workflows/verify.yml` |
| F-02 object/array payload bypass | **Fixed** — bounded on the serialised form, in UTF-8 bytes | ADR-007, `recorder.ts` |
| F-03 `note`/raw-payload redaction bypass | **Fixed** — sanitisation moved to one write boundary covering every field | ADR-007, `recorder.ts` |
| F-04 caret peer + unvalidated packaging | **Fixed** — exact `2.3.2`; clean registry install and plugin load verified | `packages/bw-evidence/package.json`, `TEST_EVIDENCE.md` |
| F-05 stale docs and test totals | **Fixed** — status block generated from the register; stale claims replaced | `IMPLEMENTATION_STATUS.md`, generator script |
| F-06 no commits, no ADR owner | **Fixed** — owner assigned; baseline commit created; review recorded here | this file, git history |
| F-07 LGPL needs a real strategy | **Partially fixed** — assessment and per-package decisions recorded, release gate enforced; notices bundle and legal review still open | ADR-008, `DEPENDENCY_LICENSES.json` |
| F-08 evidence chain limitations | **Fixed as far as a hash chain can be** — resume verifies, degradation surfaced, limitations reported by `verify()`. Tail truncation and absent signing are accepted limitations | ADR-004/007 |
| F-09 CI narrower than upstream | **Accepted and stated** — a `scope` job names exactly what CI does and does not prove; upstream parity tracked separately | `verify.yml`, `NEXT_STEPS.md` |
| F-10 security guarantees limited | **Accepted and stated** — no sandbox; the agent runs with the user's privileges | `SECURITY_REVIEW.md`, gate checklist |

## Accepted limitations (not Phase 0 defects)

1. **Tail truncation is undetectable** by a hash chain. Mitigation (publishing a head hash per
   session) is deferred; `verify()` reports the limitation on every success so no caller can
   present a valid prefix as a complete record.
2. **No signing.** Anyone with write access can recompute a consistent chain. Phase 6.
3. **No sandbox.** The agent inherits the invoking user's filesystem and network privileges.
   Phase 4 scope.
4. **Redaction is pattern-based.** An unrecognised credential format under an innocuous key
   can still be stored. Documented; not claimed otherwise.

## Superseded

- **ADR-001 (draft — "Proposed / spike required", shallow fork preferred)** — superseded
  2026-11-22. The spike showed a pinned dependency plus a wrapper CLI achieves the same
  branding outcome without the rebase burden.

## Alpha baseline and sandbox disposition (2026-11-23)

- **Accepted alpha operating decision from the handoff.** Keep the existing Ubuntu and macOS
  matrix. Use the verified `b38dd51` runtime code for supervised internal alpha, with the newer
  hosted results credited per executed job. External alpha remains on hold.
  [CI reconciliation](CI_BASELINE_RECONCILIATION.md) · [Readiness](INTERNAL_ALPHA_READINESS.md).
- **Historical BW-031 recommendation.** The 2026-11-23 review prioritized Docker and
  established the need to confine the pinned runtime with its descendants. The native-first
  decision below supersedes its backend choice.

## Local execution foundation (2026-11-23)

Require an owned OpenCode server for normal Bashwink launches, keep one scope document per
run, and require the installed policy plugin. Ask again for risky tool approvals, keep native
denials, and disable a general shell when a contract requires a narrower scope. The local
backend uses direct host execution. OS isolation remains a separate release requirement.
[BW-018 report](BW-018_IMPLEMENTATION_REPORT.md) · [BW-030 design](BW-030_EXECUTION_BACKEND_DESIGN.md).

## Private runtime admission

The local backend gates client launch on the required plugin in its own server. The release
gate still requires the broader evidence and test-integrity criteria.
[ADR-012](ADR-012-PRIVATE-RUNTIME-READINESS.md).

## Native execution without a container daemon (2026-11-24)

The standard coding workflow must work without Docker, Podman or a VM. BW-031 will
qualify whole-runtime native confinement using Seatbelt on macOS and unprivileged
Bubblewrap on Linux. Both OpenCode processes stay in scope. Host provider authentication,
evidence and export use narrow, separately audited interfaces. Native startup failure
ends the run. An explicitly acknowledged, permission-controlled local run is a separate
choice. Docker remains optional. This decision changes the roadmap and leaves the
implementation and qualification tasks open.
[Feasibility](BW-031-SANDBOX-PROPOSAL.md) · [BW-032](BW-032_PLATFORM_QUALIFICATION.md).

## Native offline recovery profile (2026-11-24)

A disowned process survived ordinary TUI and server shutdown in the shell-enabled
fixture. Saved-stage reopening and host export therefore require the file-only profile.
Seatbelt denies process creation and shell execution for that profile. Only the staged
text file can leave through a separate host preview and approval. An abandoned
activation marker remains a refusal condition until the host proves quiescence.
Admission requires both pinned OpenCode processes to hold an inherited kernel lock
under a no-fork Seatbelt profile. Stale retirement requires independent exclusive
acquisition and a matching prior writer proof. An ambiguous activation or export
stays quarantined. Shell-capable native startup is disabled pending demonstrated
whole-workload supervision.
[Milestone report](BW-031_IMPLEMENTATION_REPORT.md) · [Qualification](BW-032_QUALIFICATION_RESULTS.md).

## macOS shell boundary (2026-11-24)

Evaluate a signed Apple Virtualization.framework helper for an explicit shell-capable
profile. Keep the normal workflow Docker-free and free of user-managed VMs and daemons.
Whole-guest stop is the candidate lifetime boundary. The existing file-only Seatbelt
profile remains available, and native shell admission stays disabled pending installed
OpenCode, stage retirement and platform qualification. Optional Docker remains separate.
[Feasibility and alternatives](BW-031_IMPLEMENTATION_REPORT.md).

## v0.1.0-alpha platform scope (2026-11-24)

The v0.1.0-alpha scope is macOS Apple Silicon only. The alpha gate uses its own
release-tier overlay in the native matrix and requires all existing macOS and
Ubuntu regression CI jobs at the candidate SHA. The broader BW-032 matrix retains
its original platform requirements. [Release checklist](ALPHA_RELEASE_CHECKLIST.md)

## Persistent VM project checkpoints and apply

The offline project profile keeps the last stopped, verified VM checkpoint under
the checkout identity and exact asset profile. Each restart seeds a fresh NIC-free
guest disk. The VM owner inherits the host project lock so review stays unavailable
through launcher death until the workload has stopped. Corrupt checkpoints and
foreign session IDs are refused.

Approval binds a selected text diff to per-file identities and hashes. Host
application uses directory-relative filesystem operations, a durable progress
journal, and committed receipts. Visibility is per file. Recovery resumes only
an approved batch whose observed filesystem state matches its journal. Independent
test verification copies the current host sources and original protected test
bytes into a fresh VM. It records the test and source hashes, Git revision and
actual exit. [Test evidence](TEST_EVIDENCE.md)

## Decision template

### ADR-XXX — Decision title

- **Date / owner:**
- **Problem and context:**
- **Options compared:**
- **Decision / constraints:**
- **Source commit or experimental evidence:**
- **Consequences and reversal conditions:**
- **Status:** Proposed / Accepted / Superseded
