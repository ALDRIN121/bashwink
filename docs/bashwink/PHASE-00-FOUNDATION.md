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
