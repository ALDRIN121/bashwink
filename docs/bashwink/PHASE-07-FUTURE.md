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
