# Bashwink — Phase-by-Phase Engineering Execution Plan

**Version:** 1.0 · **Prepared:** 22 November 2026 · **Status:** proposed / not started · **Sources:** Bashwink v1 implementation backlog and v2 feature backlog

> This is a sequencing and execution document, not proof that tasks were implemented. Existing ticket IDs BW-001–BW-090 are unchanged. Command names marked “proposed” must be validated against the chosen OpenCode revision during Phase 0.

## Executive direction

Bashwink is a local-first, proof-first coding agent, built with a maintainable OpenCode foundation and selectively Hermes-inspired memory / execution ideas. It must not claim a fix is verified without observable evidence. Prefer minimal fork deltas; do not merge both agent runtimes wholesale.

## Operating rules

1. **WIP:** one architecture/infrastructure change and up to two independent small changes; avoid concurrent writes to shared core modules.
2. **Definition of Done:** code + automated success/failure test + recorded actual results + documentation and a peer/self-review + no new security regression.
3. **Issue status:** `Backlog → Ready → In Progress → Review → Verified → Released`; `Blocked` must name the blocker.
4. **Evidence:** attach the base SHA, diff/PR, command and real exit code, log digest or fixture ID; no synthetic “tests passed.”
5. **Security:** approvals must be enforced in the tool/executor layer, not by prompts alone; default-deny when policy is ambiguous.
6. **Privacy:** local data and secrets are not uploaded by default; review logs/exports for credential leakage.
7. **Upstream:** pin an exact OpenCode commit, maintain delta report and keep an upstream-sync smoke gate.
8. **Measurement:** compare against the same pinned model, task and environment; report inconclusive and failed runs.
9. **Estimates:** XS = <1 day; S = 1–2 days; M = 3–5 days; L = 1–2 weeks; XL must be broken down. These are rough contributor-size categories, not delivery promises.

## Phase overview

| Phase | Milestone | Tasks | Deliverable |
|---|---|---:|---|
| 0 | Foundation gate | 9 | Foundation / fork feasibility |
| 1 | Internal CLI prototype | 10 | CLI & durable execution substrate |
| 2 | v0.1 alpha gate | 15 | Evidence-first safeguards |
| 3 | v0.2 gate | 19 | Project brain & independent QA |
| 4 | v0.3 gate | 13 | Isolated execution & multi-agent coordination |
| 5 | v0.4 gate | 8 | Benchmarks, measurement & product validation |
| 6 | v1.0 release gate | 9 | Security hardening & stable open-source release |
| 7 | Optional; independently gated | 7 | Post-v1 experiments & integrations |

## Cross-phase dependency policy

A phase may contain optional parallel work, but **the gate remains blocked** until its mandatory acceptance conditions are evidenced. Architecture investigations may be pulled earlier, but never waive prerequisites for security-sensitive checks. Some legacy milestones in v1/v2 differ; this consolidated plan intentionally places the execution-backend interface (BW-030) before independent QA (BW-062), moves the evaluation harness (BW-039) ahead of BW-085, and moves upstream sync (BW-043) into Phase 0.

### Delivery checkpoints

- **After Phase 1:** CLI prototype, not a claim of production safety.
- **After Phase 2:** first *limited* public/alpha build if security gates and documented caveats are satisfied.
- **After Phase 3:** verifier plus reviewable project memory, subject to sandbox limitations.
- **After Phase 4:** controlled two-writer delegation; review required before integration.
- **After Phase 5:** measured evidence for which differentiators are worth maintaining.
- **After Phase 6:** stable release only if security and correctness gates are satisfied.

---
# Phase 0 — Foundation / fork feasibility

**Target:** Foundation gate  
**Tasks:** 9  
**Status:** All proposed / not started

## Objective

Demonstrate a reproducible, legally reviewable OpenCode-based foundation before adding new agent behavior.

## Implementation focus

Pin an upstream commit; run unmodified build/tests; probe plugin and tool hooks; choose fork boundaries; audit licenses; set CI; install deterministic baseline fixtures; prototype an upstream update report.

## Concrete deliverables

- [ ] UPSTREAM_BASELINE.md with SHA and toolchain

- [ ] ADR-001 and ADR-002–006 (as decisions become concrete)

- [ ] THIRD_PARTY_NOTICES.md and brand audit

- [ ] Linux/macOS CI and pinned test fixture repository

- [ ] Fork-delta and upstream-sync compatibility report


## Release / exit gate

- [ ] `bashwink` foundation can build on a clean supported machine (branding is not yet required).

- [ ] Baseline tests and at least one controlled tool call have recorded outcomes.

- [ ] All required extension seams are demonstrated or core-fork limitations are explicitly accepted.

- [ ] No unresolved distribution-blocking license or branding concerns.


**Demonstration:** Clean checkout → pinned install → upstream smoke tests → fixture reset → show baseline and fork delta.

**Key risk / mitigation:** Upstream incompatibility or high fork maintenance; make an explicit stop/go decision if hooks cannot support safe execution.


## Ordered issue checklist

- [ ] **BW-001 — Inventory OpenCode v2 repository and record exact baseline** (P0, S)

- [ ] **BW-002 — Run upstream build and representative tests** (P0, M)

- [ ] **BW-003 — Research extension hooks and fork delta** (P0, M)

- [ ] **BW-004 — ADR-001: choose package/brand/fork strategy** (P0, S)

- [ ] **BW-005 — License, dependency and branding audit** (P0, M)

- [ ] **BW-006 — Establish repository, lint, typecheck and CI** (P0, M)

- [ ] **BW-007 — Produce clickable baseline QA fixtures** (P0, M)

- [ ] **BW-043 — Upstream sync automation and manual release gate** (P0, M)

- [ ] **BW-090 — ADR-002–006 plus upstream delta governance** (P0, M)


## Implementation task cards


### 01. BW-001 — Inventory OpenCode v2 repository and record exact baseline

**Priority / effort:** P0 / S  
**Dependencies:** None  
**Area/owner:** Core  
**Source:** v1


**Work package**

Clone official repo, enumerate source license locations, record tag/commit, Bun/package manager versions, build targets, current CLI entry and test commands. Write `UPSTREAM_BASELINE.md`.


**Acceptance check**

Baseline commit hash, license, tooling versions and build/test instructions are committed; a clean install is recorded on macOS arm64 or Linux x64.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-001
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-002 — Run upstream build and representative tests

**Priority / effort:** P0 / M  
**Dependencies:** BW-001  
**Area/owner:** Core  
**Source:** v1


**Work package**

Establish repeatable build, unit suite and at least one real prompt/tool integration smoke test with a controlled provider. Document test failures without patching upstream first.


**Acceptance check**

CI-capable command list, pass/fail report, artifact IDs and known flaky tests recorded.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-002
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-003 — Research extension hooks and fork delta

**Priority / effort:** P0 / M  
**Dependencies:** BW-001  
**Area/owner:** Architecture  
**Source:** v1


**Work package**

Prototype one event observer and one custom command/plugin; inspect packaging, session IDs, stream events, file tool and shell result hooks.


**Acceptance check**

Decision matrix for plugin versus core fork; each proposed module has a proven integration seam or known missing hook.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-003
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-004 — ADR-001: choose package/brand/fork strategy

**Priority / effort:** P0 / S  
**Dependencies:** BW-002, BW-003  
**Area/owner:** Architecture  
**Source:** v1


**Work package**

Record fork approach, scope, constraints, rejected direct Hermes merge, upstream sync policy and rollback option.


**Acceptance check**

Signed-off ADR with no unproven assumption presented as an existing upstream API.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-004
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-005 — License, dependency and branding audit

**Priority / effort:** P0 / M  
**Dependencies:** BW-001  
**Area/owner:** Security / Maintainer  
**Source:** v1


**Work package**

Preserve MIT notices, inventory packages/assets, scan licenses, and draft independent-brand wording. Check npm/binary/repo name availability before publication.


**Acceptance check**

`THIRD_PARTY_NOTICES.md`, attribution and flagged unresolved legal/brand items; no copying of logos/hosted credentials.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-005
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-006 — Establish repository, lint, typecheck and CI

**Priority / effort:** P0 / M  
**Dependencies:** BW-001  
**Area/owner:** Core  
**Source:** v1


**Work package**

Set branches, conventional PR checks, caching, smoke matrix, dependency locking and contribution templates.


**Acceptance check**

PR gets deterministic lint, typecheck, unit, secret scan and supported-platform smoke status.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-006
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-007 — Produce clickable baseline QA fixtures

**Priority / effort:** P0 / M  
**Dependencies:** BW-002  
**Area/owner:** QA  
**Source:** v1


**Work package**

Create small source repo fixtures with Git base commit for read-only exploration, one-file edit, failed test, cancellation and rollback.


**Acceptance check**

Fixtures reset deterministically and run in CI without external credentials except test-specific mocked provider.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-007
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-043 — Upstream sync automation and manual release gate

**Priority / effort:** P0 / M  
**Dependencies:** BW-004, BW-006  
**Area/owner:** Maintainer  
**Source:** v1


**Work package**

Script fetching upstream tag, generating diff summary, running tests, flagging breaking extension changes.


**Acceptance check**

A test upstream update produces clear conflict/compatibility report; no automated merge to release branch.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-043
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 09. BW-090 — ADR-002–006 plus upstream delta governance

**Priority / effort:** P0 / M  
**Dependencies:** BW-003, BW-004  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Document evidence-first positioning, security authority, retrieval path, verifier boundary, replay claim; maintain fork-delta dashboard.


**Acceptance check**

One owned ADR per decision and automated upstream merge smoke gate; unproven assumptions logged.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-090
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 1 — CLI & durable execution substrate

**Target:** Internal CLI prototype  
**Tasks:** 10  
**Status:** All proposed / not started

## Objective

A reliable CLI that can plan, edit, resume, and record observable tool activity while respecting the upstream session model.

## Implementation focus

Build the Bashwink executable, onboarding, workspace trust, plan/task persistence, tool lifecycle event recorder, evidence store and interrupted-session recovery.

## Concrete deliverables

- [ ] `bashwink --help`, `--version`, `doctor`

- [ ] Clean onboarding and workspace trust prompts

- [ ] Task/plan schema with migration tests

- [ ] Append-only sanitized tool event log and evidence exports

- [ ] Interrupted-session recovery fixture


## Release / exit gate

- [ ] Run the one-file bug-fix fixture from a clean install.

- [ ] Tool events have task/run identifiers, exit statuses and redacted outputs.

- [ ] Killing the process does not claim an unfinished test passed or double-apply a patch.

- [ ] Planning mode cannot silently perform edits and the Git diff/undo flow is reproducible.


**Demonstration:** `bashwink doctor` → plan → code patch → terminate mid-check → resume → inspect events.

**Key risk / mitigation:** Event-hook completeness and non-idempotent side effects; prefer explicit uncertain states over attempted automatic recovery.


## Ordered issue checklist

- [ ] **BW-008 — Create `bashwink` executable and clean branding** (P0, M)

- [ ] **BW-009 — Implement `bashwink doctor`** (P0, S)

- [ ] **BW-010 — First-run onboarding and workspace trust** (P0, M)

- [ ] **BW-011 — Preserve upstream plan/build, diff and undo flows** (P0, M)

- [ ] **BW-012 — Add task plan data model and schema migrations** (P0, M)

- [ ] **BW-013 — Define plan artifact contract** (P0, M)

- [ ] **BW-014 — Capture structured tool execution events** (P0, L)

- [ ] **BW-015 — Implement evidence storage and export** (P0, M)

- [ ] **BW-016 — Connect task lifecycle to events** (P0, M)

- [ ] **BW-019 — Session interruption and idempotent resume** (P0, M)


## Implementation task cards


### 01. BW-008 — Create `bashwink` executable and clean branding

**Priority / effort:** P0 / M  
**Dependencies:** BW-004, BW-005  
**Area/owner:** CLI  
**Source:** v1


**Work package**

Add binary alias/entrypoint, version/help, distinctive branding and consistent config/home paths while minimizing source churn.


**Acceptance check**

`bashwink --help` and `bashwink --version` work from clean install; upstream name remains only where attribution/compatibility requires it.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-008
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-009 — Implement `bashwink doctor`

**Priority / effort:** P0 / S  
**Dependencies:** BW-008  
**Area/owner:** CLI  
**Source:** v1


**Work package**

Check runtime, Git, model credentials present (not values), local DB path and optional Docker availability.


**Acceptance check**

Missing preconditions produce actionable messages and nonzero exit; no credentials printed.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-009
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-010 — First-run onboarding and workspace trust

**Priority / effort:** P0 / M  
**Dependencies:** BW-008  
**Area/owner:** CLI / Security  
**Source:** v1


**Work package**

Reuse upstream provider onboarding where viable; establish explicit repository trust and approval policy.


**Acceptance check**

Onboarding tested against clean home and untrusted project fixtures; defaults cannot silently grant dangerous shell/write actions.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-010
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-011 — Preserve upstream plan/build, diff and undo flows

**Priority / effort:** P0 / M  
**Dependencies:** BW-007, BW-008  
**Area/owner:** Core  
**Source:** v1


**Work package**

Add regression tests that build agent can edit and plan agent cannot make ordinary file edits; verify snapshot semantics.


**Acceptance check**

Code edits, diffs, undo, cancellation and session resume behave predictably across three fixtures.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-011
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-012 — Add task plan data model and schema migrations

**Priority / effort:** P0 / M  
**Dependencies:** BW-003  
**Area/owner:** Backend  
**Source:** v1


**Work package**

SQLite plan and task tables, stable IDs, state-machine validation, repo ID and atomic migrations.


**Acceptance check**

Invalid state transitions rejected; task graph survives restart; migration rollback documented.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-012
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-013 — Define plan artifact contract

**Priority / effort:** P0 / M  
**Dependencies:** BW-011, BW-012  
**Area/owner:** Product / Backend  
**Source:** v1


**Work package**

Define objective, file targets, task dependency IDs, risks, checks and approval state. Export Markdown/JSON.


**Acceptance check**

Example plan and machine schema validate; plan renders in terminal and can be inspected before editing.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-013
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-014 — Capture structured tool execution events

**Priority / effort:** P0 / L  
**Dependencies:** BW-003, BW-012  
**Area/owner:** Backend  
**Source:** v1


**Work package**

Subscribe to upstream tool lifecycle events; capture tool ID, associated task, start/end, sanitised args, result, exit code, cancellation.


**Acceptance check**

Tool sequence is complete for fixture runs; secret fixture values absent; events are append-only and survive crash.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-014
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-015 — Implement evidence storage and export

**Priority / effort:** P0 / M  
**Dependencies:** BW-014  
**Area/owner:** Backend  
**Source:** v1


**Work package**

Store digest and bounded output, referenced patch paths and test command results; export JSON and Markdown.


**Acceptance check**

Export verified against raw fixture process result, including failure and `not_run` statuses.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-015
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 09. BW-016 — Connect task lifecycle to events

**Priority / effort:** P0 / M  
**Dependencies:** BW-012, BW-014  
**Area/owner:** Backend  
**Source:** v1


**Work package**

Ensure tool calls reference task IDs and update statuses through authorized state transitions.


**Acceptance check**

All captured tool events are task-linked or explicitly marked `unassigned` with reason; interrupted state survives restart.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-016
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 10. BW-019 — Session interruption and idempotent resume

**Priority / effort:** P0 / M  
**Dependencies:** BW-012, BW-016  
**Area/owner:** Backend  
**Source:** v1


**Work package**

Track partial writes/attempts; resume tasks without repeating already-applied patches; reconcile unexpected process exit.


**Acceptance check**

Kill/restart fixture neither double-edits nor falsely verifies the abandoned check.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-019
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 2 — Evidence-first safeguards

**Target:** v0.1 alpha gate  
**Tasks:** 15  
**Status:** All proposed / not started

## Objective

No unsupported “done” claims: preserve the requested intent, protect tests and scopes, and produce inspectable evidence.

## Implementation focus

Implement TaskContract/IntentLock, immutable baseline, TestGuard, ScopeFence, TrustZones, redaction, ProofPack, ClaimGuard, BudgetPilot and no-progress stop conditions; package the first alpha only after adversarial tests.

## Concrete deliverables

- [ ] Proposed `bashwink contract show|edit|approve` UX

- [ ] Baseline snapshots and protected test inventory

- [ ] Tool-bound path/command enforcement and source trust labels

- [ ] Proof manifest and terminal evidence summary

- [ ] Budget stops, no-progress detector and 12 adversarial fixtures

- [ ] Alpha quickstart, known-limits and security notes


## Release / exit gate

- [ ] 12/12 initial fixed fixtures reach expected *states* under pinned test conditions (proposed target).

- [ ] Zero false-verified receipts, unauthorized protected-test weakening, or canary leaks in the fixture suite.

- [ ] Required unrun tests are `not_run`/`unverified`, never marked passed.

- [ ] Untrusted repository text cannot obtain elevated tool permissions.

- [ ] Alpha package installation works on advertised target environment.


**Demonstration:** Ask agent to fix a bug → malicious test deletion attempt → denied → real tests executed → proof report with hashes; force cost cap to verify stop.

**Key risk / mitigation:** Guardrails placed only in prompts can be bypassed; enforcement must be below the model in actual file/shell tool boundaries.


## Ordered issue checklist

- [ ] **BW-017 — Build proof-of-work terminal summary** (P0, M)

- [ ] **BW-018 — Protect permissions and command execution paths** (P0, L)

- [ ] **BW-055 — TaskContract schema, migrations and criterion lifecycle** (P0, M)

- [ ] **BW-056 — IntentLock command and confirmation UX** (P0, M)

- [ ] **BW-057 — Immutable baseline and protected test inventory** (P0, M)

- [ ] **BW-058 — TestGuard policy and integrity diff** (P0, L)

- [ ] **BW-059 — ScopeFence tool-bound edit/command policy** (P0, M)

- [ ] **BW-060 — ProofPack evidence manifest with content hashes** (P0, M)

- [ ] **BW-061 — ClaimGuard terminal status validator** (P0, M)

- [ ] **BW-066 — TrustZones trust/source labels in context** (P0, M)

- [ ] **BW-067 — Secrets and output redaction pipeline** (P0, L)

- [ ] **BW-075 — BudgetPilot stop conditions, estimates and controls** (P0, M)

- [ ] **BW-076 — No-progress loop detector and safe cancellation** (P0, M)

- [ ] **BW-084 — Adversarial fixture corpus v2** (P0, L)

- [ ] **BW-020 — v0.1 documentation and packaged alpha** (P0, M)


## Implementation task cards


### 01. BW-017 — Build proof-of-work terminal summary

**Priority / effort:** P0 / M  
**Dependencies:** BW-015, BW-016  
**Area/owner:** CLI / Product  
**Source:** v1


**Work package**

Render changed files, checks executed/passed/failed/not-run, remaining risk and completion state.


**Acceptance check**

Failed/missing tests cannot appear green; evidence links/IDs resolve to actual recorded events.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-017
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-018 — Protect permissions and command execution paths

**Priority / effort:** P0 / L  
**Dependencies:** BW-010, BW-014  
**Area/owner:** Security  
**Source:** v1


**Work package**

Validate shell approvals, edit scopes, external directory and policy denials; test compound commands and symlinks.


**Acceptance check**

Default prompts for risky operations; explicit deny persists; test suite catches bypass attempts in all enabled paths.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-018
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-055 — TaskContract schema, migrations and criterion lifecycle

**Priority / effort:** P0 / M  
**Dependencies:** BW-012, BW-013  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Formalize goal, constraints, path permissions, base commit, negative requirements, criteria, and contract revisions.


**Acceptance check**

Schema round-trip and invalid transitions tested; criterion statuses cannot disappear when contract revisions change.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-055
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-056 — IntentLock command and confirmation UX

**Priority / effort:** P0 / M  
**Dependencies:** BW-008, BW-055  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Implement bashwink contract show/edit/approve; require stable acceptance for nontrivial edits; use assumption ledger.


**Acceptance check**

Fixture with contradictory goal cannot claim verified without resolving mandatory constraint.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-056
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-057 — Immutable baseline and protected test inventory

**Priority / effort:** P0 / M  
**Dependencies:** BW-007, BW-014  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Snapshot Git status/base SHA, required tests and scripts, record hashes before writes, preserve dirty user work.


**Acceptance check**

Preexisting failing test distinguished from regression; user dirty work untouched.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-057
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-058 — TestGuard policy and integrity diff

**Priority / effort:** P0 / L  
**Dependencies:** BW-018, BW-057  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Detect test deletes, skip flags, weakened assertions and script removals; approval gate; hook into real tool write path.


**Acceptance check**

Agent cannot make failing fixture green by silently deleting required test; authorized test changes remain possible.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-058
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-059 — ScopeFence tool-bound edit/command policy

**Priority / effort:** P0 / M  
**Dependencies:** BW-018, BW-055  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Compile contract allowed/excluded paths and destructive command classes to execution-time policy.


**Acceptance check**

Unapproved outside-scope file write blocked even if model asks repeatedly.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-059
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-060 — ProofPack evidence manifest with content hashes

**Priority / effort:** P0 / M  
**Dependencies:** BW-015, BW-055, BW-057  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Define versioned manifest; per-criterion links to actual command/test events, patch and base digests, redacted exports.


**Acceptance check**

Every passed claim resolves to a real event with exit code and code hash; invalid receipt fails validator.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-060
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 09. BW-061 — ClaimGuard terminal status validator

**Priority / effort:** P0 / M  
**Dependencies:** BW-017, BW-060  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Validate model final statements against proof manifest; downgrade to inconclusive or done_unverified when unsupported.


**Acceptance check**

Fake “all tests pass” LLM answer cannot set verified without recorded successful test.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-061
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 10. BW-066 — TrustZones trust/source labels in context

**Priority / effort:** P0 / M  
**Dependencies:** BW-018  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Label owner instruction, repo files, PR text, MCP descriptions, retrieved results, skills, memories and child reports.


**Acceptance check**

Untrusted README instruction cannot upgrade authority to run privileged commands.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-066
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 11. BW-067 — Secrets and output redaction pipeline

**Priority / effort:** P0 / L  
**Dependencies:** BW-015, BW-066  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Redact known fake secrets, deny host credential stores, enforce export consent and artifact TTL/deletion.


**Acceptance check**

Canary keys absent from default receipts/logs; secrets inaccessible in untrusted executor.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-067
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 12. BW-075 — BudgetPilot stop conditions, estimates and controls

**Priority / effort:** P0 / M  
**Dependencies:** BW-014, BW-055  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Track per-run model calls, token/cost estimate, tool counts, elapsed time, children; policy-controlled hard stops.


**Acceptance check**

Never launch another paid model call once hard estimated cap is hit; actual billed totals labeled unknown if unavailable.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-075
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 13. BW-076 — No-progress loop detector and safe cancellation

**Priority / effort:** P0 / M  
**Dependencies:** BW-019, BW-075  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Detect repeated identical or near-identical failures; stop or require revised hypothesis; preserve partial state.


**Acceptance check**

Forced retry-loop fixture terminates under cap and reports accurate stopped status.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-076
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 14. BW-084 — Adversarial fixture corpus v2

**Priority / effort:** P0 / L  
**Dependencies:** BW-007, BW-057  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Add fake success, test deletion, poisoned README, malicious MCP, outside-scope edit, interrupted task, costly loops and stale branch.


**Acceptance check**

Fixtures reset to fixed commit; CI reports baseline failure vs Bashwink behavior per test.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-084
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 15. BW-020 — v0.1 documentation and packaged alpha

**Priority / effort:** P0 / M  
**Dependencies:** BW-008, BW-009, BW-010, BW-011, BW-012, BW-013, BW-014, BW-015, BW-016, BW-017, BW-018, BW-019  
**Area/owner:** Maintainer  
**Source:** v1


**Work package**

Quickstart, safety, supported platforms, licenses, screenshots, checksums and installer smoke; publish alpha only after gates.


**Acceptance check**

New contributor follows README to complete a small coding task; changelog lists limitations honestly.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-020
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 3 — Project brain & independent QA

**Target:** v0.2 gate  
**Tasks:** 19  
**Status:** All proposed / not started

## Objective

Make cross-session knowledge reviewable and stale-aware, and run verification that is distinct from the author.

## Implementation focus

Define repo-scoped memory and skills lifecycle, conflict and deletion controls, branch/hash provenance, lightweight ImpactMap, independent verifier and risk-tier test plans. Introduce execution backend interface ahead of Docker.

## Concrete deliverables

- [ ] Memory proposal/review/accept/delete flows

- [ ] FTS retrieval and 10-session memory quality benchmark

- [ ] Verifier report with base/candidate comparison

- [ ] ImpactMap v0 for TypeScript/Python imports and test references

- [ ] ReviewPack showing claims, test provenance and unknowns

- [ ] Skill evaluation gate and memory privacy audit


## Release / exit gate

- [ ] A stale memory is rejected/flagged after a branch/source change.

- [ ] Verifier cannot silently modify author evidence or protected baseline.

- [ ] Preexisting test failures are distinguished from newly introduced regressions.

- [ ] Unverified memory/skills never become trusted automatically.

- [ ] ImpactMap results disclose uncovered dependencies and uncertainty.


**Demonstration:** Session A fixes issue and proposes memory → approve → change branch/API → Session B flags stale note → independent QA compares tests.

**Key risk / mitigation:** Memory pollution, correlation between author and checker, retrieval staleness; use pinned provenance and separate verifier artifacts.


## Ordered issue checklist

- [ ] **BW-021 — Memory taxonomy, schema and scope resolution** (P1, M)

- [ ] **BW-022 — Candidate memory extraction** (P1, M)

- [ ] **BW-023 — Memory review UI and CLI commands** (P1, M)

- [ ] **BW-024 — SQLite FTS5 recall and injection budget** (P1, M)

- [ ] **BW-025 — Memory contradiction, expiry and source drift** (P1, L)

- [ ] **BW-026 — Skills proposal engine and diff review** (P1, L)

- [ ] **BW-027 — Skill trust and execution protections** (P1, M)

- [ ] **BW-028 — Second-session memory benchmark** (P1, M)

- [ ] **BW-029 — Memory privacy/deletion/export audit** (P1, M)

- [ ] **BW-030 — Execution backend interface** (P1, M)

- [ ] **BW-062 — Independent checker isolated from author** (P1, L)

- [ ] **BW-063 — Baseline versus candidate verifier** (P1, M)

- [ ] **BW-064 — Risk-based verification governor** (P1, M)

- [ ] **BW-065 — ReviewPack navigable change explanation** (P1, M)

- [ ] **BW-068 — Branch- and hash-aware context references** (P1, M)

- [ ] **BW-069 — ImpactMap minimal dependency and test graph** (P1, L)

- [ ] **BW-070 — Memory freshness and conflict constraints** (P1, M)

- [ ] **BW-071 — Verified failure and regression memory** (P1, M)

- [ ] **BW-077 — Skill promotion evaluation gate** (P1, L)


## Implementation task cards


### 01. BW-021 — Memory taxonomy, schema and scope resolution

**Priority / effort:** P1 / M  
**Dependencies:** BW-012  
**Area/owner:** Memory  
**Source:** v1


**Work package**

Design repo-scoped memory classes, provenance, approval/expiry/supersession states, schema migrations and worktree identity.


**Acceptance check**

Tests cover duplicate repos, renames, conflicting facts and migration handling.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-021
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-022 — Candidate memory extraction

**Priority / effort:** P1 / M  
**Dependencies:** BW-014, BW-021  
**Area/owner:** Memory  
**Source:** v1


**Work package**

Propose minimal durable lessons from successful work and verified files; require evidence reference.


**Acceptance check**

Extraction never commits durable entries directly; all candidates have sources and types.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-022
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-023 — Memory review UI and CLI commands

**Priority / effort:** P1 / M  
**Dependencies:** BW-022  
**Area/owner:** CLI / Memory  
**Source:** v1


**Work package**

Implement list/show/approve/reject/edit/delete/export; render provenance, timestamp and confidence.


**Acceptance check**

Rejected/deleted item is absent from retrieval after approval transition; tests cover editing and batch review.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-023
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-024 — SQLite FTS5 recall and injection budget

**Priority / effort:** P1 / M  
**Dependencies:** BW-021, BW-023  
**Area/owner:** Memory  
**Source:** v1


**Work package**

Index approved project entries, rank against current task and inject selected context with age/source.


**Acceptance check**

Retrieval deterministic on fixtures; no unapproved candidate enters model prompt; max context entry cap enforced.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-024
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-025 — Memory contradiction, expiry and source drift

**Priority / effort:** P1 / L  
**Dependencies:** BW-024  
**Area/owner:** Memory  
**Source:** v1


**Work package**

Detect competing values, outdated command paths, changed source files and expired entries; ask for correction.


**Acceptance check**

Old contradicted entry is not silently preferred; audit log records supersession and user decisions.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-025
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-026 — Skills proposal engine and diff review

**Priority / effort:** P1 / L  
**Dependencies:** BW-022, BW-023  
**Area/owner:** Skills  
**Source:** v1


**Work package**

Convert repeated successful procedures into proposed `SKILL.md`, provide diff/review workflow, preserve origin.


**Acceptance check**

No autonomous shared-skill overwrite; accepted skill contains precise steps, prerequisites and caveats.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-026
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-027 — Skill trust and execution protections

**Priority / effort:** P1 / M  
**Dependencies:** BW-018, BW-026  
**Area/owner:** Security  
**Source:** v1


**Work package**

Mark externally sourced and repo-local skills untrusted; gate execution and durable updates.


**Acceptance check**

Malicious skill-instruction fixture cannot bypass default shell/edit/network policy.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-027
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-028 — Second-session memory benchmark

**Priority / effort:** P1 / M  
**Dependencies:** BW-024, BW-025  
**Area/owner:** QA  
**Source:** v1


**Work package**

Build 10 multi-session cases; score retrieval precision and prevented stale conflicts.


**Acceptance check**

Publish baseline vs Bashwink comparison with identical model/config and independent ground truth.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-028
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 09. BW-029 — Memory privacy/deletion/export audit

**Priority / effort:** P1 / M  
**Dependencies:** BW-023  
**Area/owner:** Security  
**Source:** v1


**Work package**

Inspect data storage, SQLite backups, logs, exports and config for secret residue and deletion behavior.


**Acceptance check**

Delete verification includes index; exported data is explicit and scrubbed; canary secrets absent.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-029
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 10. BW-030 — Execution backend interface

**Priority / effort:** P1 / M  
**Dependencies:** BW-014, BW-018  
**Area/owner:** Runtime  
**Source:** v1


**Work package**

Specify prepare/execute/sync/cancel/dispose and environment metadata contract without duplicating upstream tool dispatch.


**Acceptance check**

Mock backend can run and be terminated; policy check occurs before backend execution.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-030
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 11. BW-062 — Independent checker isolated from author

**Priority / effort:** P1 / L  
**Dependencies:** BW-030, BW-060  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Separate role/worktree/context, independent acceptance test creation, read-only observer where possible, explicit checker cost.


**Acceptance check**

Verifier report tagged as independent and cannot edit author evidence or test baseline.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-062
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 12. BW-063 — Baseline versus candidate verifier

**Priority / effort:** P1 / M  
**Dependencies:** BW-057, BW-062  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Run pinned required tests against base and candidate; classify preexisting failures, new failures, flaky/inconclusive states.


**Acceptance check**

Fixture with preexisting failing test reported without blaming patch; newly failing test blocks verified.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-063
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 13. BW-064 — Risk-based verification governor

**Priority / effort:** P1 / M  
**Dependencies:** BW-055, BW-062  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Set evidence gates for low/medium/high risk, including auth, crypto, infra, DB migrations and permission logic.


**Acceptance check**

Auth-change fixture forces independent security review and user confirmation for destructive action.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-064
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 14. BW-065 — ReviewPack navigable change explanation

**Priority / effort:** P1 / M  
**Dependencies:** BW-060, BW-063  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Generate concise changed-behavior report, negative requirements, test integrity, proof links and unknowns.


**Acceptance check**

Every acceptance claim and critical risk can be navigated to artifact/log or explicitly marked unverified.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-065
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 15. BW-068 — Branch- and hash-aware context references

**Priority / effort:** P1 / M  
**Dependencies:** BW-021, BW-057  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Store code provenance with repo, branch, commit, path and hash; reject stale references.


**Acceptance check**

Switch branch then run retrieval: outdated snippet not treated as current code.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-068
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 16. BW-069 — ImpactMap minimal dependency and test graph

**Priority / effort:** P1 / L  
**Dependencies:** BW-068  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Start with TS/Python import and symbol index, test grep and Git diff; no mandatory graph database.


**Acceptance check**

Prepared fixture includes affected consumers/tests in report with stated uncertainty.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-069
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 17. BW-070 — Memory freshness and conflict constraints

**Priority / effort:** P1 / M  
**Dependencies:** BW-024, BW-068  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Bind memory source to path/hash and compare at insertion; expire conflict, preserve approved stable user preferences separately.


**Acceptance check**

Stale memory no longer asserted as verified after source code API change.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-070
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 18. BW-071 — Verified failure and regression memory

**Priority / effort:** P1 / M  
**Dependencies:** BW-023, BW-063  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Persist only verified root cause, diagnostic and confirmed regression commands, with expiry and review.


**Acceptance check**

Unverified assistant guess never promoted; rerun can recall known verified failure.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-071
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 19. BW-077 — Skill promotion evaluation gate

**Priority / effort:** P1 / L  
**Dependencies:** BW-026, BW-071  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Run candidate skill against gold/adversarial tasks in isolation; compare old and new quality, present diff for approval.


**Acceptance check**

Regression skill remains quarantined; previous skill and evaluation report retained.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-077
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 4 — Isolated execution & multi-agent coordination

**Target:** v0.3 gate  
**Tasks:** 13  
**Status:** All proposed / not started

## Objective

Coordinate two scoped writer agents safely, with individual worktrees, bounded capabilities and explicit merge review.

## Implementation focus

Add container adapter and sandbox threat tests, delegation envelope, worktree allocation, scheduler, child proof contract and integration coordinator; fingerprint skills/MCP and constrain child permissions.

## Concrete deliverables

- [ ] Non-root container executor with explicit mounts and network policy

- [ ] Worktree-per-writer scheduler capped at two workers initially

- [ ] Child agent capability/budget contract

- [ ] Safe integration preview and post-merge test evidence

- [ ] MCP/skill fingerprint checks and credential-exfiltration tests

- [ ] Resume handoff baton and causal debug ledger


## Release / exit gate

- [ ] Two independent tasks complete in isolated worktrees with distinct evidence.

- [ ] Conflicting patches cannot silently overwrite user work.

- [ ] Child cannot acquire parent-denied privileges.

- [ ] Network/host secret canary exfiltration fixtures are blocked in stated sandbox threat model.

- [ ] The integrated checkout is freshly tested after explicit merge approval.


**Demonstration:** Parallel docs+code task → two isolated changes → conflict or clean merge preview → approve → integration tests → consolidated ProofPack.

**Key risk / mitigation:** The installed helper and its kernel policy vary by platform. Prove the runtime boundary and report unsupported features before advertising native execution.


## Ordered issue checklist

- [ ] **BW-031 — Native sandbox adapter** (P1, L)

- [ ] **BW-032 — Sandbox threat and adversarial tests** (P1, L)

- [ ] **BW-033 — Child-task envelope and budget policy** (P1, M)

- [ ] **BW-034 — Worktree per writer and branch naming** (P1, L)

- [ ] **BW-035 — Coordinator scheduler (maximum two writers)** (P1, L)

- [ ] **BW-036 — Child artifact and evidence contract** (P1, M)

- [ ] **BW-037 — Integration/merge coordinator** (P1, L)

- [ ] **BW-038 — Multi-agent task fixture suite** (P1, M)

- [ ] **BW-072 — MCP/skill fingerprint and trust audit** (P1, M)

- [ ] **BW-073 — Child-agent capability subset contracts** (P1, M)

- [ ] **BW-074 — Sandbox network and credential test suite** (P1, L)

- [ ] **BW-078 — Machine-readable session handoff baton** (P1, M)

- [ ] **BW-079 — Causal debug mode hypothesis ledger** (P1, M)


## Implementation task cards


### 01. BW-031 — Native sandbox adapter

**Priority / effort:** P1 / L  
**Dependencies:** BW-030  
**Area/owner:** Runtime / Security  
**Source:** v1


**Work package**

Qualify Seatbelt and unprivileged Bubblewrap for the entire pinned runtime. Enforce scoped filesystem paths, runtime privileges, network policy, resource limits and cleanup. Keep Docker optional.


**Acceptance check**

Installed Docker-free runtime fixtures show allowed edits, OS denials, limits, cleanup, exit propagation and host secret protection. Native failure refuses dispatch. See [BW-031 plan](BW-031_IMPLEMENTATION_PLAN.md).


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-031
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-032 — Sandbox threat and adversarial tests

**Priority / effort:** P1 / L  
**Dependencies:** BW-031  
**Area/owner:** Security  
**Source:** v1


**Work package**

Exercise clean native installs, scope and links, synthetic secrets, subprocesses, approvals, network, real-provider turns, session recovery and shutdown.


**Acceptance check**

All advertised backend and platform combinations pass their applicable [qualification controls](BW-032_PLATFORM_QUALIFICATION.md). Report uncovered threats and unsupported hosts.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-032
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-033 — Child-task envelope and budget policy

**Priority / effort:** P1 / M  
**Dependencies:** BW-013, BW-018  
**Area/owner:** Orchestration  
**Source:** v1


**Work package**

Define child goal, path scopes, test checks, model, budget, steps, cancellation and deliverable schema.


**Acceptance check**

Invalid privilege escalation and exhausted budget requests rejected before spawn.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-033
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-034 — Worktree per writer and branch naming

**Priority / effort:** P1 / L  
**Dependencies:** BW-033  
**Area/owner:** Orchestration  
**Source:** v1


**Work package**

Allocate distinct Git worktree/branch per edit child; manage base commit and cleanup safely.


**Acceptance check**

Two child writers cannot share same writable checkout; fixture cleans branches on failure with user data safeguards.


**Attach proof:** End-to-end fixture with policy decisions, child run IDs, isolated commits and resulting evidence.


- [ ] Implement BW-034
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-035 — Coordinator scheduler (maximum two writers)

**Priority / effort:** P1 / L  
**Dependencies:** BW-016, BW-034  
**Area/owner:** Orchestration  
**Source:** v1


**Work package**

Schedule task DAG and child sessions, enforce timeout/step/cost, report progress, support stop and failure propagation.


**Acceptance check**

2 independent tasks execute with complete status; dependency ordering and kill/restart policy tested.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-035
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-036 — Child artifact and evidence contract

**Priority / effort:** P1 / M  
**Dependencies:** BW-015, BW-035  
**Area/owner:** Orchestration  
**Source:** v1


**Work package**

Require changed path listing, patch/commit ID, test exit code and known risks; reject unsupported “done” claim.


**Acceptance check**

Child with false success statement fails gate if tests fail or missing evidence.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-036
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-037 — Integration/merge coordinator

**Priority / effort:** P1 / L  
**Dependencies:** BW-034, BW-036  
**Area/owner:** Orchestration  
**Source:** v1


**Work package**

Show proposed patch merge, detect conflicts, require developer approval and rerun tests in integrated checkout.


**Acceptance check**

Conflicting worktrees do not overwrite each other; final result includes fresh integration test evidence.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-037
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-038 — Multi-agent task fixture suite

**Priority / effort:** P1 / M  
**Dependencies:** BW-037  
**Area/owner:** QA  
**Source:** v1


**Work package**

Create independent-file, same-file conflict, provider timeout, budget exhaustion and one child failure scenarios.


**Acceptance check**

Deterministic outcomes, correct status and no unauthorized pushes/deploys.


**Attach proof:** End-to-end fixture with policy decisions, child run IDs, isolated commits and resulting evidence.


- [ ] Implement BW-038
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 09. BW-072 — MCP/skill fingerprint and trust audit

**Priority / effort:** P1 / M  
**Dependencies:** BW-027, BW-066  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Hash tool descriptions, skill files and capabilities; detect updates, prompt injection indicators, explicit reapproval.


**Acceptance check**

Changed MCP tool definition triggers quarantine; no silent expanded privilege.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-072
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 10. BW-073 — Child-agent capability subset contracts

**Priority / effort:** P1 / M  
**Dependencies:** BW-033, BW-066  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Implement subset-of-parent tool, path, credential, network and budget policy; verifiable delegation envelope.


**Acceptance check**

Child cannot acquire permission denied to parent; unauthorized call rejected by executor.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-073
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 11. BW-074 — Sandbox network and credential test suite

**Priority / effort:** P1 / L  
**Dependencies:** BW-031, BW-073  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Docker/OS hard restrictions, resources, no host mount by default, safe network policy, fake-secret exfiltration fixtures.


**Acceptance check**

Untrusted task cannot read host credential canary or write outside scoped mount.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-074
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 12. BW-078 — Machine-readable session handoff baton

**Priority / effort:** P1 / M  
**Dependencies:** BW-019, BW-068  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Include active intent, code hashes, outstanding checks, decisions and uncertain side effects in resume envelope.


**Acceptance check**

Process restart after partial shell failure does not double-apply mutation or misstate completion.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-078
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 13. BW-079 — Causal debug mode hypothesis ledger

**Priority / effort:** P1 / M  
**Dependencies:** BW-055, BW-076  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

For repeated failures require hypothesis, probe, observed result, alternative before patch/retry.


**Acceptance check**

Loop fixture shifts to diagnostic or stops, not repeated blind code changes.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-079
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 5 — Benchmarks, measurement & product validation

**Target:** v0.4 gate  
**Tasks:** 8  
**Status:** All proposed / not started

## Objective

Measure whether Bashwink improves accepted changes and review confidence instead of only adding complexity and cost.

## Implementation focus

Develop evaluation corpus, quality drift and API compatibility studies, cost-per-accepted-patch metrics, model/provider comparison and a blinded OpenCode-baseline A/B test.

## Concrete deliverables

- [ ] Reproducible 30-task+ baseline evaluation suite, extended by track

- [ ] Security, correctness, review-time and cost scorecards

- [ ] Frozen held-out tests and versioned environment metadata

- [ ] A/B comparison with pinned upstream/model/task settings

- [ ] Startup/memory performance and schema-compatibility reports


## Release / exit gate

- [ ] Publish results with denominators, model/commit, run settings and failures.

- [ ] False-verified results and test-integrity events are reported separately from task success.

- [ ] A/B report includes human review minutes when observed and clearly labels missing data.

- [ ] Defer speculative features if no measurable gain versus implementation/maintenance cost.


**Demonstration:** Run selected frozen fixture suite on OpenCode and Bashwink; compare accepted patch rate, false claims, review time, cost.

**Key risk / mitigation:** Benchmark overfitting and misleading comparisons; maintain frozen held-out tasks and publicly describe failures.


## Ordered issue checklist

- [ ] **BW-039 — Full golden-task evaluation harness** (P1, L)

- [ ] **BW-041 — Startup and resource budget** (P1, M)

- [ ] **BW-082 — API and schema compatibility guard prototype** (P2, L)

- [ ] **BW-085 — Evaluation metrics and scorecards** (P1, M)

- [ ] **BW-080 — Quality Drift Watch research prototype** (P2, L)

- [ ] **BW-083 — Private multi-model comparison harness** (P2, L)

- [ ] **BW-086 — Cost per accepted patch telemetry** (P1, M)

- [ ] **BW-087 — Blinded A/B study with OpenCode baseline** (P1, L)


## Implementation task cards


### 01. BW-039 — Full golden-task evaluation harness

**Priority / effort:** P1 / L  
**Dependencies:** BW-020, BW-028, BW-038  
**Area/owner:** QA  
**Source:** v1


**Work package**

Build 30-task suite, stable fixtures and reports, matched model/provider comparisons.


**Acceptance check**

Reproducible result with environment, model and baseline identified; safety mistakes separately counted.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-039
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-041 — Startup and resource budget

**Priority / effort:** P1 / M  
**Dependencies:** BW-020, BW-024  
**Area/owner:** Performance  
**Source:** v1


**Work package**

Time warm/cold CLI startup and memory retrieval on small/large test repositories.


**Acceptance check**

Results and bottlenecks published; avoid expensive always-on services.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-041
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-082 — API and schema compatibility guard prototype

**Priority / effort:** P2 / L  
**Dependencies:** BW-064, BW-069  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Inspect OpenAPI/JSON Schema/types/public exports and compare base vs patch with consumer fixtures.


**Acceptance check**

Breaking public method or request field appears as review-blocking difference in supported languages.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-082
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-085 — Evaluation metrics and scorecards

**Priority / effort:** P1 / M  
**Dependencies:** BW-039, BW-084  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Record accepted/verified/false-verified, review minutes, hidden test pass, budget, security, context precision and CI cost.


**Acceptance check**

Report can compare baseline and latest runs without mixing different model settings or task oracles.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-085
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-080 — Quality Drift Watch research prototype

**Priority / effort:** P2 / L  
**Dependencies:** BW-069, BW-085  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Compare duplication, complexity, API growth, incremental regression and architectural constraints over milestone chain.


**Acceptance check**

Produces correct trends on at least five hand-constructed successive changes; avoids scoring value judgments as facts.


**Attach proof:** Pinned test corpus, observed pass/fail outcomes, environment/model metadata and comparator where needed.


- [ ] Implement BW-080
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-083 — Private multi-model comparison harness

**Priority / effort:** P2 / L  
**Dependencies:** BW-085  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Run identical tasks on selected providers with independent evaluator; collect runtime, review minutes and cost.


**Acceptance check**

Comparison has source code/ref, run settings, repeat counts and limitations, no fabricated billing.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-083
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-086 — Cost per accepted patch telemetry

**Priority / effort:** P1 / M  
**Dependencies:** BW-075, BW-085  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

User opt-in time annotations, API cost estimates and review outcomes with no cloud telemetry by default.


**Acceptance check**

Export distinguishes unknown user review time from zero; no private code transmitted.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-086
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-087 — Blinded A/B study with OpenCode baseline

**Priority / effort:** P1 / L  
**Dependencies:** BW-085, BW-086  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Frozen task set and model with Bashwink guards on/off; independent labels, at least 3 runs per condition.


**Acceptance check**

Publish win/loss/cost and qualitative failure narratives; remove features with no measured gain.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-087
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 6 — Security hardening & stable open-source release

**Target:** v1.0 release gate  
**Tasks:** 9  
**Status:** All proposed / not started

## Objective

Ship a reproducible and maintainable public release with clear compatibility, privacy and security boundaries.

## Implementation focus

Finalize privacy/no-telemetry defaults, migration tests, plugin contract, artifacts/checksums, contributor docs, red-team review, held-out release gate and optional CI attestation.

## Concrete deliverables

- [ ] Supported platform binaries/tarballs with hashes

- [ ] Migration and rollback CI

- [ ] Extension example and compatibility promise

- [ ] CONTRIBUTING, SECURITY, license attribution, changelog and support matrix

- [ ] Red-team findings, residual risks and release scorecard

- [ ] Optional checksummed proof export / CI adapter


## Release / exit gate

- [ ] No unresolved critical/high security bugs in defined fixture scope.

- [ ] Reproducible installation, upgrades, migration and rollback path on supported systems.

- [ ] Every advertised core capability has a passing test or transparent limitation.

- [ ] Release tag maps to the published source and downloadable artifact hashes.


**Demonstration:** Clean install → onboarding → scoped fix → proof+QA → export → upgrade/migrate → verify source and artifact hashes.

**Key risk / mitigation:** Premature v1 promises and supply-chain issues; release only with traceable source, limitations and incident reporting process.


## Ordered issue checklist

- [ ] **BW-040 — Telemetry/privacy strategy and audit** (P0, S)

- [ ] **BW-042 — Upgrade and schema migration suite** (P0, M)

- [ ] **BW-044 — Extension SDK contract and example** (P1, L)

- [ ] **BW-045 — Packaging matrix and signed checksums** (P0, M)

- [ ] **BW-046 — Contributor and support documentation** (P1, M)

- [ ] **BW-047 — Security review and release red-team pass** (P0, L)

- [ ] **BW-088 — Optional evidence attestation and CI adapter** (P2, L)

- [ ] **BW-089 — Release gate suite: security, quality, real repos** (P1, L)

- [ ] **BW-048 — First stable public release and release notes** (P0, M)


## Implementation task cards


### 01. BW-040 — Telemetry/privacy strategy and audit

**Priority / effort:** P0 / S  
**Dependencies:** BW-020  
**Area/owner:** Security  
**Source:** v1


**Work package**

Default-off decision, list captured local events, permissions and deletion/export controls.


**Acceptance check**

No background network telemetry in default clean-install network test.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-040
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-042 — Upgrade and schema migration suite

**Priority / effort:** P0 / M  
**Dependencies:** BW-025, BW-037  
**Area/owner:** Backend  
**Source:** v1


**Work package**

Verify upgrading several known schema versions, interrupted migrations and rollback strategy.


**Acceptance check**

No silent loss of approved memory, tasks or evidence on migration fixtures.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-042
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-044 — Extension SDK contract and example

**Priority / effort:** P1 / L  
**Dependencies:** BW-003, BW-030  
**Area/owner:** Extensibility  
**Source:** v1


**Work package**

Decide documented extension hooks and a safe example plugin; avoid promising full upstream plugin compatibility prematurely.


**Acceptance check**

Sample plugin works against supported Bashwink version; compatibility caveats documented.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-044
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-045 — Packaging matrix and signed checksums

**Priority / effort:** P0 / M  
**Dependencies:** BW-020, BW-043  
**Area/owner:** Release  
**Source:** v1


**Work package**

Reproducible builds, release artifact checksums and clean install smoke on advertised OS/arch.


**Acceptance check**

Release page includes exact binaries/source refs and SHA-256; clean-machine smoke passes.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-045
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-046 — Contributor and support documentation

**Priority / effort:** P1 / M  
**Dependencies:** BW-005, BW-020  
**Area/owner:** Community  
**Source:** v1


**Work package**

Complete `CONTRIBUTING`, `SECURITY`, code of conduct, labels, templates and good-first-issues.


**Acceptance check**

A new contributor can run one fixture and open a PR without private instructions.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-046
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-047 — Security review and release red-team pass

**Priority / effort:** P0 / L  
**Dependencies:** BW-032, BW-038, BW-040  
**Area/owner:** Security  
**Source:** v1


**Work package**

Walk all critical tool/secret/path trust boundaries and execute seeded adversarial fixtures.


**Acceptance check**

No unresolved critical/high issues; every accepted residual risk is documented.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-047
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-088 — Optional evidence attestation and CI adapter

**Priority / effort:** P2 / L  
**Dependencies:** BW-045, BW-060  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Generate optional checksummed/signed proof record for GitHub CI; no auto merge or remote secrets by default.


**Acceptance check**

Replaying tampered receipt or wrong commit hash fails verification; unsigned mode labeled.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-088
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 08. BW-089 — Release gate suite: security, quality, real repos

**Priority / effort:** P1 / L  
**Dependencies:** BW-047, BW-084, BW-085  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Integrate held-out regression suite, adversarial fixtures, docs accuracy and reviewable proof into release workflow.


**Acceptance check**

Release blocked on critical wrong-success, test tamper, credential leak, unauthorized scope or repeat-loop failures.


**Attach proof:** Denied/allowed adversarial fixture results, sanitized event trace and threat-model notes.


- [ ] Implement BW-089
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 09. BW-048 — First stable public release and release notes

**Priority / effort:** P0 / M  
**Dependencies:** BW-039, BW-040, BW-041, BW-042, BW-043, BW-044, BW-045, BW-046, BW-047  
**Area/owner:** Maintainer  
**Source:** v1


**Work package**

Final tag, changelog, website/repo README, demo, license review and known-limits statement.


**Acceptance check**

Advertised features each have test/eval evidence; installation works and notice text is correct.


**Attach proof:** Approved decision/checklist with pinned source links and risk owner.


- [ ] Implement BW-048
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---
# Phase 7 — Post-v1 experiments & integrations

**Target:** Optional; independently gated  
**Tasks:** 7  
**Status:** All proposed / not started

## Objective

Evaluate advanced expansion without destabilizing the reliable local-first agent core.

## Implementation focus

Research remote execution, IDE/desktop UI, consented recurring jobs, optional semantic retrieval, configurable model-routing, CI/GitHub review and sanitized record/replay labs.

## Concrete deliverables

- [ ] One-page feasibility ADR and threat model per initiative

- [ ] Prototype behind explicit feature flag

- [ ] Independent benchmarks against core and upstream features

- [ ] Maintenance owner and rollback plan


## Release / exit gate

- [ ] Prove a distinct user benefit and defined security boundary before public enablement.

- [ ] Avoid duplicating upstream UX or adding always-on services without demand.

- [ ] Each experimental capability has opt-out/deletion and failure-path tests.


**Demonstration:** Optional plugin or flagged feature prototype with supported rollback and test report.

**Key risk / mitigation:** Scope creep; keep experimental integrations separate from default install.


## Ordered issue checklist

- [ ] **BW-049 — Remote SSH/cloud execution backends** (P2, XL)

- [ ] **BW-050 — IDE/desktop surface integration** (P2, XL)

- [ ] **BW-051 — Autonomous background jobs and resilient queue** (P2, XL)

- [ ] **BW-052 — Optional semantic memory index** (P2, M)

- [ ] **BW-053 — User-configured role/model routing** (P2, M)

- [ ] **BW-054 — CI/GitHub review integration** (P2, L)

- [ ] **BW-081 — Record/replay Lab research spike** (P2, L)


## Implementation task cards


### 01. BW-049 — Remote SSH/cloud execution backends

**Priority / effort:** P2 / XL  
**Dependencies:** BW-030, BW-047  
**Area/owner:** Runtime  
**Source:** v1


**Work package**

Add backend interface implementations and explicit remote credential isolation.


**Acceptance check**

Split into backend-specific issues with independent threat models and integration tests.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-049
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 02. BW-050 — IDE/desktop surface integration

**Priority / effort:** P2 / XL  
**Dependencies:** BW-048  
**Area/owner:** UX  
**Source:** v1


**Work package**

Evaluate ACP/SDK and existing upstream surfaces before building UI.


**Acceptance check**

Decision record demonstrates a unique benefit rather than duplicate upstream UI.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-050
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 03. BW-051 — Autonomous background jobs and resilient queue

**Priority / effort:** P2 / XL  
**Dependencies:** BW-035, BW-047  
**Area/owner:** Runtime  
**Source:** v1


**Work package**

Persist queue and leased jobs across process restarts with explicit user consent and resource limits.


**Acceptance check**

No “task running” ghost state after crash; pause/stop/review work reliably.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-051
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 04. BW-052 — Optional semantic memory index

**Priority / effort:** P2 / M  
**Dependencies:** BW-028  
**Area/owner:** Memory  
**Source:** v1


**Work package**

Evaluate whether embeddings beat FTS5 enough to justify latency/cost/complexity.


**Acceptance check**

Opt-in and benchmarked; not required to run Bashwink.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-052
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 05. BW-053 — User-configured role/model routing

**Priority / effort:** P2 / M  
**Dependencies:** BW-038  
**Area/owner:** Models  
**Source:** v1


**Work package**

Policies for expensive architecture review versus cheaper retrieval worker, with fallback approval.


**Acceptance check**

Hard cost caps and user-configured provider allowlist always respected.


**Attach proof:** Versioned fixture, before/after memory snapshot, conflict and privacy tests.


- [ ] Implement BW-053
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 06. BW-054 — CI/GitHub review integration

**Priority / effort:** P2 / L  
**Dependencies:** BW-048  
**Area/owner:** Ecosystem  
**Source:** v1


**Work package**

Headless review agent with minimal repo credentials and branch-only permissions.


**Acceptance check**

Never pushes or merges without explicit CI policy; output links to evidence artifacts.


**Attach proof:** Clean-machine CI logs, checksums, commit SHA and reproducible steps.


- [ ] Implement BW-054
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


### 07. BW-081 — Record/replay Lab research spike

**Priority / effort:** P2 / L  
**Dependencies:** BW-014, BW-078  
**Area/owner:** TBD (assign at planning)  
**Source:** v2


**Work package**

Capture sanitized model/tool boundaries and simulate deterministic cut-point replay without calling providers.


**Acceptance check**

Recorded fixture replay uses zero model calls; docs explicitly disclaim live-model determinism.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [ ] Implement BW-081
- [ ] Run success and negative-path checks
- [ ] Attach verifiable evidence and update issue status


## Phase sign-off template

- Base commit: `__________`
- Build/test environment: `__________`
- Fixture results: `__________`
- Open security defects: `__________`
- Open release blockers: `__________`
- Decision: `[ ] Advance  [ ] Repeat  [ ] Reduce scope`


---

## Global traceability and release claims

- 90 original IDs are included exactly once; none silently dropped or renumbered.
- Original implementation wording and original acceptance criteria are copied from the prior backlogs; new phase gates and proof hints are planning additions.
- Dependency graph and per-phase sequencing are machine-checked; no ticket depends on an item planned in a later phase.
- All tasks are **not started**. Target versions are planning labels, not shipped releases.
- Any release claim must be backed by actual CI fixtures, the pinned upstream baseline and a real artifact SHA.

## Suggested GitHub project fields

`ID`, `Title`, `Phase`, `Release`, `Priority`, `Size`, `Area/Owner`, `Status`, `Dependencies`, `Acceptance`, `Proof link`, `Risk owner`, `Blocked reason`.

## References within the existing planning package

- `BASHWINK_PRODUCT_REQUIREMENTS.md` (v1 product requirements)
- `BASHWINK_V2_PRD_ADDENDUM.md` (v2 functional requirements)
- `COMPETITIVE_GAP_RESEARCH.md` (capability research)
- `EXPERIMENTS_AND_EVALUATIONS.md` (fixtures and evaluation definitions)
- `ADR-001-FOUNDATION-AND-FORK.md` (fork decision)
