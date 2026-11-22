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
