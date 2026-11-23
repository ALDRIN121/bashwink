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
