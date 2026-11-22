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
