# Bashwink — Implementation Backlog

**Backlog version:** 1.0 | **Date:** 22 Nov 2026 | **PRD:** `BASHWINK_PRODUCT_REQUIREMENTS.md`

The list is written as GitHub-issue-ready work items. **Status: all proposed/not started.** The approximate sizes refer to one experienced contributor: XS = less than a day, S = 1-2 days, M = 3-5 days, L = 1-2 weeks, XL = split before implementation. Actual effort depends on fork APIs, tests and review cycles. Dependencies name issue IDs, not calendar dates.

## Global engineering rules

- Do not merge work without a visible acceptance test/result.
- Do not claim commands passed unless their actual exit codes are recorded.
- All new data stores need documented schema/versioning and a deletion path.
- Treat security-sensitive failure as release blocking regardless of task size.
- Maintain separate **Product** (what a user sees) and **Infrastructure** (internal support) labels in GitHub.
- Keep `upstream-track` pinned and maintain an explicit fork delta record.

## S0 — Fork and feasibility (release gate: pinned fork starts cleanly)

### BW-001 — Inventory OpenCode v2 repository and record exact baseline
**Priority:** P0 | **Size:** S | **Depends:** none | **Owner:** Core  
**Work:** Clone official repo, enumerate source license locations, record tag/commit, Bun/package manager versions, build targets, current CLI entry and test commands. Write `UPSTREAM_BASELINE.md`.  
**Acceptance:** Baseline commit hash, license, tooling versions and build/test instructions are committed; a clean install is recorded on macOS arm64 or Linux x64.

### BW-002 — Run upstream build and representative tests
**Priority:** P0 | **Size:** M | **Depends:** BW-001 | **Owner:** Core  
**Work:** Establish repeatable build, unit suite and at least one real prompt/tool integration smoke test with a controlled provider. Document test failures without patching upstream first.  
**Acceptance:** CI-capable command list, pass/fail report, artifact IDs and known flaky tests recorded.

### BW-003 — Research extension hooks and fork delta
**Priority:** P0 | **Size:** M | **Depends:** BW-001 | **Owner:** Architecture  
**Work:** Prototype one event observer and one custom command/plugin; inspect packaging, session IDs, stream events, file tool and shell result hooks.  
**Acceptance:** Decision matrix for plugin versus core fork; each proposed module has a proven integration seam or known missing hook.

### BW-004 — ADR-001: choose package/brand/fork strategy
**Priority:** P0 | **Size:** S | **Depends:** BW-002, BW-003 | **Owner:** Architecture  
**Work:** Record fork approach, scope, constraints, rejected direct Hermes merge, upstream sync policy and rollback option.  
**Acceptance:** Signed-off ADR with no unproven assumption presented as an existing upstream API.

### BW-005 — License, dependency and branding audit
**Priority:** P0 | **Size:** M | **Depends:** BW-001 | **Owner:** Security / Maintainer  
**Work:** Preserve MIT notices, inventory packages/assets, scan licenses, and draft independent-brand wording. Check npm/binary/repo name availability before publication.  
**Acceptance:** `THIRD_PARTY_NOTICES.md`, attribution and flagged unresolved legal/brand items; no copying of logos/hosted credentials.

### BW-006 — Establish repository, lint, typecheck and CI
**Priority:** P0 | **Size:** M | **Depends:** BW-001 | **Owner:** Core  
**Work:** Set branches, conventional PR checks, caching, smoke matrix, dependency locking and contribution templates.  
**Acceptance:** PR gets deterministic lint, typecheck, unit, secret scan and supported-platform smoke status.

### BW-007 — Produce clickable baseline QA fixtures
**Priority:** P0 | **Size:** M | **Depends:** BW-002 | **Owner:** QA  
**Work:** Create small source repo fixtures with Git base commit for read-only exploration, one-file edit, failed test, cancellation and rollback.  
**Acceptance:** Fixtures reset deterministically and run in CI without external credentials except test-specific mocked provider.

## S1 — v0.1: reliable Bashwink CLI (gate: actual code patch and evidence)

### BW-008 — Create `bashwink` executable and clean branding
**Priority:** P0 | **Size:** M | **Depends:** BW-004, BW-005 | **Owner:** CLI  
**Work:** Add binary alias/entrypoint, version/help, distinctive branding and consistent config/home paths while minimizing source churn.  
**Acceptance:** `bashwink --help` and `bashwink --version` work from clean install; upstream name remains only where attribution/compatibility requires it.

### BW-009 — Implement `bashwink doctor`
**Priority:** P0 | **Size:** S | **Depends:** BW-008 | **Owner:** CLI  
**Work:** Check runtime, Git, model credentials present (not values), local DB path and optional Docker availability.  
**Acceptance:** Missing preconditions produce actionable messages and nonzero exit; no credentials printed.

### BW-010 — First-run onboarding and workspace trust
**Priority:** P0 | **Size:** M | **Depends:** BW-008 | **Owner:** CLI / Security  
**Work:** Reuse upstream provider onboarding where viable; establish explicit repository trust and approval policy.  
**Acceptance:** Onboarding tested against clean home and untrusted project fixtures; defaults cannot silently grant dangerous shell/write actions.

### BW-011 — Preserve upstream plan/build, diff and undo flows
**Priority:** P0 | **Size:** M | **Depends:** BW-008, BW-007 | **Owner:** Core  
**Work:** Add regression tests that build agent can edit and plan agent cannot make ordinary file edits; verify snapshot semantics.  
**Acceptance:** Code edits, diffs, undo, cancellation and session resume behave predictably across three fixtures.

### BW-012 — Add task plan data model and schema migrations
**Priority:** P0 | **Size:** M | **Depends:** BW-003 | **Owner:** Backend  
**Work:** SQLite plan and task tables, stable IDs, state-machine validation, repo ID and atomic migrations.  
**Acceptance:** Invalid state transitions rejected; task graph survives restart; migration rollback documented.

### BW-013 — Define plan artifact contract
**Priority:** P0 | **Size:** M | **Depends:** BW-012, BW-011 | **Owner:** Product / Backend  
**Work:** Define objective, file targets, task dependency IDs, risks, checks and approval state. Export Markdown/JSON.  
**Acceptance:** Example plan and machine schema validate; plan renders in terminal and can be inspected before editing.

### BW-014 — Capture structured tool execution events
**Priority:** P0 | **Size:** L | **Depends:** BW-003, BW-012 | **Owner:** Backend  
**Work:** Subscribe to upstream tool lifecycle events; capture tool ID, associated task, start/end, sanitised args, result, exit code, cancellation.  
**Acceptance:** Tool sequence is complete for fixture runs; secret fixture values absent; events are append-only and survive crash.

### BW-015 — Implement evidence storage and export
**Priority:** P0 | **Size:** M | **Depends:** BW-014 | **Owner:** Backend  
**Work:** Store digest and bounded output, referenced patch paths and test command results; export JSON and Markdown.  
**Acceptance:** Export verified against raw fixture process result, including failure and `not_run` statuses.

### BW-016 — Connect task lifecycle to events
**Priority:** P0 | **Size:** M | **Depends:** BW-012, BW-014 | **Owner:** Backend  
**Work:** Ensure tool calls reference task IDs and update statuses through authorized state transitions.  
**Acceptance:** All captured tool events are task-linked or explicitly marked `unassigned` with reason; interrupted state survives restart.

### BW-017 — Build proof-of-work terminal summary
**Priority:** P0 | **Size:** M | **Depends:** BW-015, BW-016 | **Owner:** CLI / Product  
**Work:** Render changed files, checks executed/passed/failed/not-run, remaining risk and completion state.  
**Acceptance:** Failed/missing tests cannot appear green; evidence links/IDs resolve to actual recorded events.

### BW-018 — Protect permissions and command execution paths
**Priority:** P0 | **Size:** L | **Depends:** BW-010, BW-014 | **Owner:** Security  
**Work:** Validate shell approvals, edit scopes, external directory and policy denials; test compound commands and symlinks.  
**Acceptance:** Default prompts for risky operations; explicit deny persists; test suite catches bypass attempts in all enabled paths.

### BW-019 — Session interruption and idempotent resume
**Priority:** P0 | **Size:** M | **Depends:** BW-012, BW-016 | **Owner:** Backend  
**Work:** Track partial writes/attempts; resume tasks without repeating already-applied patches; reconcile unexpected process exit.  
**Acceptance:** Kill/restart fixture neither double-edits nor falsely verifies the abandoned check.

### BW-020 — v0.1 documentation and packaged alpha
**Priority:** P0 | **Size:** M | **Depends:** BW-008 through BW-019 | **Owner:** Maintainer  
**Work:** Quickstart, safety, supported platforms, licenses, screenshots, checksums and installer smoke; publish alpha only after gates.  
**Acceptance:** New contributor follows README to complete a small coding task; changelog lists limitations honestly.

## S2 — v0.2: project brain and learning (gate: reviewable cross-session recall)

### BW-021 — Memory taxonomy, schema and scope resolution
**Priority:** P1 | **Size:** M | **Depends:** BW-012 | **Owner:** Memory  
**Work:** Design repo-scoped memory classes, provenance, approval/expiry/supersession states, schema migrations and worktree identity.  
**Acceptance:** Tests cover duplicate repos, renames, conflicting facts and migration handling.

### BW-022 — Candidate memory extraction
**Priority:** P1 | **Size:** M | **Depends:** BW-021, BW-014 | **Owner:** Memory  
**Work:** Propose minimal durable lessons from successful work and verified files; require evidence reference.  
**Acceptance:** Extraction never commits durable entries directly; all candidates have sources and types.

### BW-023 — Memory review UI and CLI commands
**Priority:** P1 | **Size:** M | **Depends:** BW-022 | **Owner:** CLI / Memory  
**Work:** Implement list/show/approve/reject/edit/delete/export; render provenance, timestamp and confidence.  
**Acceptance:** Rejected/deleted item is absent from retrieval after approval transition; tests cover editing and batch review.

### BW-024 — SQLite FTS5 recall and injection budget
**Priority:** P1 | **Size:** M | **Depends:** BW-021, BW-023 | **Owner:** Memory  
**Work:** Index approved project entries, rank against current task and inject selected context with age/source.  
**Acceptance:** Retrieval deterministic on fixtures; no unapproved candidate enters model prompt; max context entry cap enforced.

### BW-025 — Memory contradiction, expiry and source drift
**Priority:** P1 | **Size:** L | **Depends:** BW-024 | **Owner:** Memory  
**Work:** Detect competing values, outdated command paths, changed source files and expired entries; ask for correction.  
**Acceptance:** Old contradicted entry is not silently preferred; audit log records supersession and user decisions.

### BW-026 — Skills proposal engine and diff review
**Priority:** P1 | **Size:** L | **Depends:** BW-022, BW-023 | **Owner:** Skills  
**Work:** Convert repeated successful procedures into proposed `SKILL.md`, provide diff/review workflow, preserve origin.  
**Acceptance:** No autonomous shared-skill overwrite; accepted skill contains precise steps, prerequisites and caveats.

### BW-027 — Skill trust and execution protections
**Priority:** P1 | **Size:** M | **Depends:** BW-026, BW-018 | **Owner:** Security  
**Work:** Mark externally sourced and repo-local skills untrusted; gate execution and durable updates.  
**Acceptance:** Malicious skill-instruction fixture cannot bypass default shell/edit/network policy.

### BW-028 — Second-session memory benchmark
**Priority:** P1 | **Size:** M | **Depends:** BW-024, BW-025 | **Owner:** QA  
**Work:** Build 10 multi-session cases; score retrieval precision and prevented stale conflicts.  
**Acceptance:** Publish baseline vs Bashwink comparison with identical model/config and independent ground truth.

### BW-029 — Memory privacy/deletion/export audit
**Priority:** P1 | **Size:** M | **Depends:** BW-023 | **Owner:** Security  
**Work:** Inspect data storage, SQLite backups, logs, exports and config for secret residue and deletion behavior.  
**Acceptance:** Delete verification includes index; exported data is explicit and scrubbed; canary secrets absent.

## S3 — v0.3: safe execution and controlled delegation (gate: isolated parallel task)

### BW-030 — Execution backend interface
**Priority:** P1 | **Size:** M | **Depends:** BW-018, BW-014 | **Owner:** Runtime  
**Work:** Specify prepare/execute/sync/cancel/dispose and environment metadata contract without duplicating upstream tool dispatch.  
**Acceptance:** Mock backend can run and be terminated; policy check occurs before backend execution.

### BW-031 — Docker sandbox adapter
**Priority:** P1 | **Size:** L | **Depends:** BW-030 | **Owner:** Runtime / Security  
**Work:** Explicit mount, scoped path, non-root container, CPU/mem/time quota, network control and cleanup.  
**Acceptance:** Unit/integration fixtures show cleanup, limits, exit propagation and no host secret mount by default.

### BW-032 — Sandbox threat and adversarial tests
**Priority:** P1 | **Size:** L | **Depends:** BW-031 | **Owner:** Security  
**Work:** Path traversal, symlinks, `~/.ssh`, `.env`, malicious commands, network egress, denied escape and cancellation.  
**Acceptance:** All enabled backends pass; documented threats not fully mitigated are disclosed as limits.

### BW-033 — Child-task envelope and budget policy
**Priority:** P1 | **Size:** M | **Depends:** BW-013, BW-018 | **Owner:** Orchestration  
**Work:** Define child goal, path scopes, test checks, model, budget, steps, cancellation and deliverable schema.  
**Acceptance:** Invalid privilege escalation and exhausted budget requests rejected before spawn.

### BW-034 — Worktree per writer and branch naming
**Priority:** P1 | **Size:** L | **Depends:** BW-033 | **Owner:** Orchestration  
**Work:** Allocate distinct Git worktree/branch per edit child; manage base commit and cleanup safely.  
**Acceptance:** Two child writers cannot share same writable checkout; fixture cleans branches on failure with user data safeguards.

### BW-035 — Coordinator scheduler (maximum two writers)
**Priority:** P1 | **Size:** L | **Depends:** BW-034, BW-016 | **Owner:** Orchestration  
**Work:** Schedule task DAG and child sessions, enforce timeout/step/cost, report progress, support stop and failure propagation.  
**Acceptance:** 2 independent tasks execute with complete status; dependency ordering and kill/restart policy tested.

### BW-036 — Child artifact and evidence contract
**Priority:** P1 | **Size:** M | **Depends:** BW-035, BW-015 | **Owner:** Orchestration  
**Work:** Require changed path listing, patch/commit ID, test exit code and known risks; reject unsupported “done” claim.  
**Acceptance:** Child with false success statement fails gate if tests fail or missing evidence.

### BW-037 — Integration/merge coordinator
**Priority:** P1 | **Size:** L | **Depends:** BW-034, BW-036 | **Owner:** Orchestration  
**Work:** Show proposed patch merge, detect conflicts, require developer approval and rerun tests in integrated checkout.  
**Acceptance:** Conflicting worktrees do not overwrite each other; final result includes fresh integration test evidence.

### BW-038 — Multi-agent task fixture suite
**Priority:** P1 | **Size:** M | **Depends:** BW-037 | **Owner:** QA  
**Work:** Create independent-file, same-file conflict, provider timeout, budget exhaustion and one child failure scenarios.  
**Acceptance:** Deterministic outcomes, correct status and no unauthorized pushes/deploys.

## S4 — Hardening, ecosystem and public readiness

### BW-039 — Full golden-task evaluation harness
**Priority:** P1 | **Size:** L | **Depends:** BW-020, BW-028, BW-038 | **Owner:** QA  
**Work:** Build 30-task suite, stable fixtures and reports, matched model/provider comparisons.  
**Acceptance:** Reproducible result with environment, model and baseline identified; safety mistakes separately counted.

### BW-040 — Telemetry/privacy strategy and audit
**Priority:** P0 | **Size:** S | **Depends:** BW-020 | **Owner:** Security  
**Work:** Default-off decision, list captured local events, permissions and deletion/export controls.  
**Acceptance:** No background network telemetry in default clean-install network test.

### BW-041 — Startup and resource budget
**Priority:** P1 | **Size:** M | **Depends:** BW-024, BW-020 | **Owner:** Performance  
**Work:** Time warm/cold CLI startup and memory retrieval on small/large test repositories.  
**Acceptance:** Results and bottlenecks published; avoid expensive always-on services.

### BW-042 — Upgrade and schema migration suite
**Priority:** P0 | **Size:** M | **Depends:** BW-025, BW-037 | **Owner:** Backend  
**Work:** Verify upgrading several known schema versions, interrupted migrations and rollback strategy.  
**Acceptance:** No silent loss of approved memory, tasks or evidence on migration fixtures.

### BW-043 — Upstream sync automation and manual release gate
**Priority:** P0 | **Size:** M | **Depends:** BW-006, BW-004 | **Owner:** Maintainer  
**Work:** Script fetching upstream tag, generating diff summary, running tests, flagging breaking extension changes.  
**Acceptance:** A test upstream update produces clear conflict/compatibility report; no automated merge to release branch.

### BW-044 — Extension SDK contract and example
**Priority:** P1 | **Size:** L | **Depends:** BW-003, BW-030 | **Owner:** Extensibility  
**Work:** Decide documented extension hooks and a safe example plugin; avoid promising full upstream plugin compatibility prematurely.  
**Acceptance:** Sample plugin works against supported Bashwink version; compatibility caveats documented.

### BW-045 — Packaging matrix and signed checksums
**Priority:** P0 | **Size:** M | **Depends:** BW-020, BW-043 | **Owner:** Release  
**Work:** Reproducible builds, release artifact checksums and clean install smoke on advertised OS/arch.  
**Acceptance:** Release page includes exact binaries/source refs and SHA-256; clean-machine smoke passes.

### BW-046 — Contributor and support documentation
**Priority:** P1 | **Size:** M | **Depends:** BW-005, BW-020 | **Owner:** Community  
**Work:** Complete `CONTRIBUTING`, `SECURITY`, code of conduct, labels, templates and good-first-issues.  
**Acceptance:** A new contributor can run one fixture and open a PR without private instructions.

### BW-047 — Security review and release red-team pass
**Priority:** P0 | **Size:** L | **Depends:** BW-032, BW-038, BW-040 | **Owner:** Security  
**Work:** Walk all critical tool/secret/path trust boundaries and execute seeded adversarial fixtures.  
**Acceptance:** No unresolved critical/high issues; every accepted residual risk is documented.

### BW-048 — First stable public release and release notes
**Priority:** P0 | **Size:** M | **Depends:** BW-039 through BW-047 | **Owner:** Maintainer  
**Work:** Final tag, changelog, website/repo README, demo, license review and known-limits statement.  
**Acceptance:** Advertised features each have test/eval evidence; installation works and notice text is correct.

## Optional post-v1 backlog (do not start before stable release)

### BW-049 — Remote SSH/cloud execution backends
**Priority:** P2 | **Size:** XL | **Depends:** BW-030, BW-047 | **Owner:** Runtime  
**Work:** Add backend interface implementations and explicit remote credential isolation.  
**Acceptance:** Split into backend-specific issues with independent threat models and integration tests.

### BW-050 — IDE/desktop surface integration
**Priority:** P2 | **Size:** XL | **Depends:** BW-048 | **Owner:** UX  
**Work:** Evaluate ACP/SDK and existing upstream surfaces before building UI.  
**Acceptance:** Decision record demonstrates a unique benefit rather than duplicate upstream UI.

### BW-051 — Autonomous background jobs and resilient queue
**Priority:** P2 | **Size:** XL | **Depends:** BW-035, BW-047 | **Owner:** Runtime  
**Work:** Persist queue and leased jobs across process restarts with explicit user consent and resource limits.  
**Acceptance:** No “task running” ghost state after crash; pause/stop/review work reliably.

### BW-052 — Optional semantic memory index
**Priority:** P2 | **Size:** M | **Depends:** BW-028 | **Owner:** Memory  
**Work:** Evaluate whether embeddings beat FTS5 enough to justify latency/cost/complexity.  
**Acceptance:** Opt-in and benchmarked; not required to run Bashwink.

### BW-053 — User-configured role/model routing
**Priority:** P2 | **Size:** M | **Depends:** BW-038 | **Owner:** Models  
**Work:** Policies for expensive architecture review versus cheaper retrieval worker, with fallback approval.  
**Acceptance:** Hard cost caps and user-configured provider allowlist always respected.

### BW-054 — CI/GitHub review integration
**Priority:** P2 | **Size:** L | **Depends:** BW-048 | **Owner:** Ecosystem  
**Work:** Headless review agent with minimal repo credentials and branch-only permissions.  
**Acceptance:** Never pushes or merges without explicit CI policy; output links to evidence artifacts.

## Suggested GitHub project fields

**Status:** Backlog / Ready / In Progress / In Review / Blocked / Verified / Released  
**Stage:** S0 / S1 / S2 / S3 / S4 / Post-v1  
**Priority:** P0 / P1 / P2  
**Size:** XS / S / M / L / XL  
**Area:** Core / CLI / Security / Memory / Skills / Orchestration / QA / Release  
**Dependencies:** comma-delimited BW IDs  
**Milestone:** v0.1 / v0.2 / v0.3 / v0.4 / v1.0

## Critical path

```text
BW-001 -> BW-002 / BW-003 -> BW-004 -> BW-008 -> BW-011
                                      -> BW-012 -> BW-014 -> BW-015
                                                           -> BW-017 -> BW-020
BW-018 (permissions) -------------------------------/            |
                                                              v0.1
BW-021 -> BW-022 -> BW-023 -> BW-024 -> BW-028 (v0.2)
BW-030 -> BW-031 -> BW-032 -----> BW-047
BW-033 -> BW-034 -> BW-035 -> BW-036 -> BW-037 -> BW-038 -> BW-039
BW-043 + BW-045 + BW-046 + BW-047 -> BW-048 (stable)
```

## Release gates by milestone

**v0.1:** BW-001 to BW-020 closed with evidence; missing optional credentials handled; CLI runnable on clean target machine.  
**v0.2:** BW-021 to BW-029 closed; candidate memory never silently becomes approved; can inspect and delete.  
**v0.3:** BW-030 to BW-038 closed; Docker safety tests pass and parallel code edits have worktree/merge gates.  
**v1.0:** BW-039 to BW-048 closed; public evaluation, upgrade path and independent branding complete.
