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
