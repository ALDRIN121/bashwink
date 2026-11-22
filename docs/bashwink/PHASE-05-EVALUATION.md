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
