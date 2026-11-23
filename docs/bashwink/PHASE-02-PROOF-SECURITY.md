# Phase 2 — Evidence-first safeguards

**Target:** v0.1 alpha gate  
**Tasks:** 15  
**Status:** In progress — **1 of 15 implemented (BW-055)**; gate NOT evaluated. Phase 2 began only after the Phase 1 revalidation in ADR-010.

## Objective

No unsupported “done” claims: preserve the requested intent, protect tests and scopes, and produce inspectable evidence.

## Implementation focus

Implement TaskContract/IntentLock, immutable baseline, TestGuard, ScopeFence, TrustZones, redaction, ProofPack, ClaimGuard, BudgetPilot and no-progress stop conditions; package the first alpha only after adversarial tests.

## Concrete deliverables

- [~] `bashwink contract new|show|approve|revise|status` shipped with BW-055; interactive `edit`, assumption ledger and the contradictory-goal fixture remain BW-056

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

- [x] **BW-055 — TaskContract schema, migrations and criterion lifecycle** (P0, M) — Done, local evidence; CI pending the commit

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
**Area/owner:** Aldrin Joseph  
**Source:** v2


**Work package**

Formalize goal, constraints, path permissions, base commit, negative requirements, criteria, and contract revisions.


**Acceptance check**

Schema round-trip and invalid transitions tested; criterion statuses cannot disappear when contract revisions change.


**Attach proof:** PR with automated fixture/log, reproducible command, expected/actual output and failure-path test.


- [x] Implement BW-055 — schema v2 + `contract` CLI data plane (ADR-010)
- [x] Run success and negative-path checks — 37 unit/integration tests, `fixtures/contract` 14/14
- [x] Attach verifiable evidence and update issue status — `TEST_EVIDENCE.md` § Phase 2, CSV status Done
- [ ] CI verification — pending the commit/push for this increment


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
