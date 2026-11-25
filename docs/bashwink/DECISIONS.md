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
| 2026-11-25 | ADR-013 | Standard native mode is the default; the isolated VM is optional and fails closed; distribution is a private npm tarball with exact-pinned runtimes | installed-package harness on macOS, Ubuntu and Windows runners; `STANDARD_PACKAGE_LICENSING.md` | Accepted (owner direction) | Aldrin Joseph |
| 2026-11-25 | ADR-014 | Keep future engines and a later Rust port possible; build neither now | measured seams and code sizes recorded in the ADR | Accepted as direction only | Aldrin Joseph |

Full text: `ADR-001` … `ADR-014` in this directory.

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

## VM reviewed-apply recovery and baseline

An early apply journal with no recorded staging identity cannot authorize deletion of
whatever now occupies the staging path. Recovery verifies the enrolled host base,
publishes a durable abandoned receipt and leaves that path untouched for inspection.
The journal is cleared only after the receipt is durable. A changed host base or an
ambiguous existing record retains the journal.

On a later project open with no pending apply journal, checksum-validated committed
receipts update the saved baseline for their approved files. Receipt identities and
before/after revisions must form a valid chain, final bytes must match the saved guest
snapshot, and the processed receipt list is stored atomically with the checkpoint.
Missing or malformed receipts fail closed. The scheme preserves per-file recovery;
it does not make the multi-file apply atomic.

## ADR-013 — v0.1.0-alpha.1: macOS-only scope, secure default and release build

- **Date / owner:** 2026-11-24, Aldrin Joseph.
- **Problem and context:** A fresh development installation lacked VM assets and an ordinary
  launch could select host execution, so the strongest evidence (live VM coding, recovery,
  reviewed export) did not describe what a first-time user would actually run.
- **Scope decision (recorded explicitly).** The v0.1.0-alpha.1 candidate advertises macOS on
  Apple Silicon only, and only macOS builds named in `release/qualified-hosts.json` (currently
  27.0.1, build 26A434, tier "engineering-host"). Linux, Windows and Intel Macs are
  unsupported for this candidate. **This narrows what the candidate advertises. It does not
  complete BW-031 or BW-032 and removes none of their requirements:** the Ubuntu x86-64 rows,
  the clean Docker-free host qualification, hosted CI for the exact candidate and the
  remaining controls stay open in `BW-032_PLATFORM_QUALIFICATION.md`, and both tasks stay
  `In progress` in the register.
- **Decision.**
  1. A release bundle is compiled with `__BASHWINK_RELEASE__`. No variable, flag or file turns
     a development bundle into a release bundle or back. Release bundles ignore
     `BASHWINK_BACKEND`, `BASHWINK_VM_PROVIDER` and `BASHWINK_OPENCODE_BIN`.
  2. Bare `bashwink`, `--continue` and `--session` run in the VM or stop. A launch that cannot
     start the VM stops before any model request or tool dispatch, prints a cause and a fix,
     and appends to `startup-failures.jsonl`. There is no automatic host fallback.
  3. Host execution is `--unsafe-local` only, after a typed phrase on an interactive terminal,
     every time. Existing approvals and hard denials are unchanged. Mode is shown before the
     UI, inside it (a 20-second TUI toast, not a persistent indicator), in `doctor` and in run
     records (`execution.backend.mode`).
  4. The CLI embeds the SHA-256 of the VM asset manifest and the qualified macOS builds. Every
     launch re-hashes the kernel, initramfs and VM owner against that manifest.
  5. The relay provider is the owner of the model chosen with `bashwink model use`. First
     launch in a project asks for workspace approval, recorded in the existing trust store.
  6. The VM session deadline is 30 minutes (owner cap 60). The guest ends at 29 minutes and
     saves; a host-side kill discards unsaved work, so the guest limit must stay lower.
  7. A release build removes the stage directory after its checkpoint is committed.
  8. The release archive ships stock upstream OpenCode binaries. They embed LGPL FFmpeg
     (ADR-009), so giving the archive to anyone else needs the owner's sign-off or a
     rebuilt no-FFmpeg library. This candidate is not distributed.
- **Evidence:** `releases/v0.1.0-alpha.1/QUALIFICATION_RESULTS.md`, `TEST_EVIDENCE.md`.
- **Consequences and reversal conditions:** Unqualified macOS builds are refused until added to
  the list with evidence. The list is compiled in, so extending it needs a new build. Reverse
  decision 3 only with a persistent indicator and a new review.
- **Status:** Accepted for the candidate; external distribution not approved.

## ADR-014 — RC2 stabilization: stage ownership, approval detection, persistent mode indicator

- **Date / owner:** 2026-11-25, Aldrin Joseph.
- **Problem and context:** Three defects survived RC1: the uninstaller deleted every
  `/private/tmp/bashwink-vm-*` directory the user owned; a security-sensitive boundary fixture
  failed intermittently with no known cause; and the execution mode was visible only as a short
  notice. RC1 also left the licensing and clean-host questions open.
- **Decisions.**
  1. **Stage ownership.** Each stage directory is registered under the creating installation's data
     directory and carries an ownership marker with the same random nonce. Cleanup
     (`bashwink sandbox stages [--purge]`, used by `uninstall.sh --purge-state`) removes a stage only
     if the registry entry parses, the path is directly under the stage root with the expected name
     shape, a real directory (never a symlink) of this user's with the recorded device and inode
     is there, the marker matches, the recorded process is gone and nothing has the disk open.
     Everything else is kept and reported. Unregistered directories (older builds, other
     installations, other tools) are never examined for deletion. The uninstaller no longer contains
     a glob delete. Negative regression tests include the old logic as a control.
  2. **Approval detection in PTY fixtures.** Permission dialogs are counted from OpenCode's own state
     events (`OSC 7501 state=blocked:kind=permission`), not from words on the screen. Root cause of the
     intermittent failure: the terminal renderer repaints only changed cells, so a second dialog
     with the same option row leaves no new "Allow once" in the byte stream, the fixture waited for
     it, never approved, and the guest's own deadline ended the session with the tool never run.
     It was a harness observation defect, not an isolation defect: no tool ran in the failing runs,
     so no isolation assertion was evaluated, and no assertion was weakened or removed.
  3. **Persistent indicator.** The evidence plugin's TUI entry claims the supported
     `home.footer` and `prompt.footer.status` slots with `[SANDBOXED VM]` or `[UNSAFE LOCAL MODE]`,
     keeping the start-up notice. Wording and the "unknown is never shown as isolated" rule live in a
     type-checked, unit-tested module; only JSX glue is untyped. No TUI fork.
  4. **Manifest.** Intentional documentation edits are recorded with
     `scripts/refresh_docs_manifest.py --write`, which updates existing entries only and prints every
     change. The strict check is unchanged.
- **Consequences:** Stages created by RC1 and earlier are unregistered, so they are never deleted
  automatically. Registration happens before anything is written to a stage.
- **Status:** Accepted.

## ADR-015 — Standard native mode is the default; sandbox mode is optional

- **Date / owner:** 2026-11-25, Aldrin Joseph (owner direction). **Supersedes** the parts of ADR-013 that made the
  VM the default and macOS the only target. ADR-013's mechanisms (qualified-host list, asset pinning, stage
  ownership from ADR-014) remain correct for the optional sandbox artifact.
- **Problem:** A mandatory VM brought platform and distribution complexity (a Linux guest image, a Swift helper,
  Apple-only virtualization) that a conventional coding CLI does not need, and blocked Windows entirely.
- **Decision.**
  1. `bashwink` runs **standard mode**: native on the host OS, permission-controlled, no VM, Docker or WSL.
  2. `bashwink --sandbox` selects the retained VM backend. It is explicit, fails closed, never falls back to
     native execution, and reports its mode accurately. It is **not** part of the standard npm package. Until it is
     separately qualified it is neither distributed nor advertised.
  3. The VM engineering (relay, stage registry, assets, harnesses, ADR-013/014) is preserved, not deleted.
- **What standard mode provides** (enforced in runtime code, not prompts): workspace trust per resolved path
  (untrusted: write, shell, network, web, sub-agent and automation denied); shell and network ask; restricted
  TaskContracts deny shell they cannot constrain; edits limited to the contract's or workspace's allowed paths;
  denials are applied after user rules and survive `--auto`; evidence on by default; the private server and plugin
  policy must be acknowledged before any prompt; a failure to establish policy stops the launch.
- **What it does not provide:** an operating-system sandbox. Approved commands run as the user and can read any file,
  use the network and read credentials in the environment. Approval prompts, trust and path checks are guard rails.
  A prompt-injected instruction the user approves runs with the user's access. Documentation and the in-TUI label
  must say so and must never use the word "sandbox" for this mode.
- **Original sandbox milestones still unfinished:** BW-031 (including Linux/Windows backends) and BW-032 (clean-host
  qualification, hosted CI, live qualification, notarization, licensing) stay `In progress`. Passing alpha with
  standard mode does not complete either.
- **Status:** Accepted. Implementation tracked in `ALPHA_RELEASE_PROGRESS.md`.

## ADR-016 — Future engine architecture (direction only; nothing here is implemented)

- **Date / owner:** 2026-11-25, Aldrin Joseph.
- **Direction:** a modular monolith of cooperating in-process engines with explicit, versioned, serializable
  contracts: Orchestration, Inference, Chat Memory, Context, Execution, Security, Evidence, Evaluation, Planning,
  Skill, Retrieval, Budget. Prefer in-process calls; allow meaningful dependencies; avoid cycles, access to another
  engine's internal state, duplicated sources of truth, hidden side effects and needless network hops. Chat Memory
  (cross-session retrieval, evidence-backed outcomes, privacy controls, invalidation) is the 2.0 flagship.
  Performance-critical parts (launcher, execution backend, process lifecycle, filesystem, evidence storage,
  retrieval, security enforcement) may migrate to Rust incrementally.
- **What the alpha preserves without building it:** today's boundaries already map to engines (policy and trust =
  Security; the evidence package = Evidence; the execution backend interface = Execution; provider/model config and
  the OpenCode runtime = Inference; the plan/contract store = Planning). Contracts that cross them stay plain JSON
  (evidence entries, task contracts, run records, provider usage records, the stage registry). Acceptance tests
  stay language-independent (PTY and process-level fixtures).
- **Explicitly not now:** the Chat Memory Engine, further engines, advanced orchestration, a Rust migration, repository
  reorganization.
- **Status:** Accepted as direction.
