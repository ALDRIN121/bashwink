# Bashwink

## Complete engineering specification and execution backlog

**Build. Verify. Remember.**

*Research and planning baseline — 22 November 2026*

**Contents**

- Part I: Product requirements, research, architecture, security, evaluation and release strategy
- Part II: 54 scoped implementation tasks with acceptance criteria and dependencies
- Appendix: Source and licensing references

---

# Bashwink — AI Coding Agent
## End-to-End Product Requirements, Technical Architecture, and Delivery Strategy

**Document ID:** BW-PRD-001  
**Version:** 1.0 (planning baseline)  
**Research cutoff:** 22 November 2026  
**Status:** Proposed; not implemented  
**Product category:** Open-source, local-first, terminal-first AI coding agent  
**Upstream inspiration:** OpenCode (Anomaly) and Hermes Agent (Nous Research)  
**License target:** MIT, subject to a dependency and asset audit  

> **Executive decision.** Start from a pinned OpenCode 2.x fork and keep modifications as an isolated Bashwink extension layer. Study Hermes' learning, memory, sandbox and autonomous-work patterns; port concepts selectively rather than transplanting its Python runtime. Establish a working coding CLI before investing in differentiated memory, sandboxes, or multi-agent execution.

---

# 1. Executive summary

**Product statement.** Bashwink is a local-first, open-source coding agent that can understand a repository, produce a verifiable change plan, implement changes safely, run tests in a controlled environment, and retain *reviewable* engineering knowledge across sessions.

**Tagline (working):** *Build. Verify. Remember.*

**Why it should exist.** Models have become capable coding collaborators, but the developer still spends time explaining the same repository conventions, checking whether claimed tests actually ran, untangling parallel changes, and controlling risky execution. Bashwink should reduce those recurring costs while keeping the developer in control. It must not be marketed as a superior model; the harness, developer experience, audit trail and execution discipline are the product.

**Primary user.** An individual developer working daily across one or more Git repositories, comfortable with a terminal and Git, who may use different model providers. Secondary users are small engineering teams and developers running controlled CI or remote jobs.

**Distinctive promise, measured rather than asserted:**
1. **Project brain with provenance:** recall conventions and architectural decisions without silently writing unreliable memories.
2. **Proof of work:** final claims cite actual executed commands, test exits, diffs and worktree/commit identifiers.
3. **Isolation-first delegation:** independent subagents use bounded context, permissions, budgets and isolated branches/worktrees.
4. **Plan-to-implementation continuity:** approved plan items map to observable work and test results.
5. **Model freedom with control:** provider switching, cost visibility, explicit permission and privacy settings.

**Delivery principle.** Publish a useful v0.1 before expanding breadth. A maintainable fork plus two excellent differentiators beats copying every feature from two mature agents.

# 2. Research: what makes the reference projects special?

The following is a feature/architecture comparison from official sources, *not* a claim that either product lacks every unmentioned feature. The references were checked at the research cutoff; both upstream projects evolve rapidly. Sources are documented in section 18.

## 2.1 OpenCode — strengths worth preserving

| Strength | Evidence-backed description | Bashwink action |
|---|---|---|
| Coding-oriented workflows | Build and plan agents, code exploration, editing, command execution, model tools | Keep upstream workflow intact; do not reimplement core edits [S1, S2] |
| Rich developer interfaces | Terminal, desktop, web and SDK surfaces | Ship CLI first; inherit or defer other surfaces [S1, S3] |
| Extensible architecture | Plugins, custom agents, commands, MCP servers, configuration | Implement additions through official extension surfaces where possible [S2, S4] |
| Session/event architecture | Typed client/embedded host, events and streaming APIs | Use existing events for audit and verification [S5] |
| Permissions and policy controls | Ordered allow/ask/deny permission rules and hard-deny policies | Reuse policy infrastructure; add safer Bashwink defaults [S6] |
| Diff and rollback ergonomics | Reviewable edits and snapshot-backed undo/redo | Preserve upstream semantics; test thoroughly [S7] |
| Independent work | Background subagents and scripted Git worktrees in 2026 releases | Extend with bounded delegation, merge gating and evidence [S3, S8] |
| Provider choice | Multiple model/providers and SDK integrations | Avoid creating a separate model abstraction initially [S1, S5] |

**Important correction to an easy assumption:** OpenCode already has background subagents, skills, worktrees, plugins, permissions, and snapshots. These cannot themselves be advertised as unique Bashwink innovations. Build *quality-of-execution* improvements on top of them, not duplicate modules.

## 2.2 Hermes Agent — strengths worth selectively adapting

| Strength | Evidence-backed description | Bashwink action |
|---|---|---|
| Learning loop | Agent can propose/create/update procedural skills from repeated work | Add a reviewed, versioned skill-learning workflow [S9] |
| Persistent memory | Curated memory and cross-session search | Build a code/project-specific memory store with provenance [S10] |
| Pluggable execution environments | Local, Docker, SSH and multiple cloud backends | Start with Docker, then a backend interface [S11] |
| Delegation | Child agents get independent conversations and terminal sessions | Add child execution contracts and budgets [S12] |
| Tool registry and hooks | Central registry, toolsets, pre/post hooks | Borrow interface lessons; use OpenCode plugin system rather than porting Python registry [S13] |
| Agent internals | Agent loop has prompt assembly, dispatch, failure recovery, compression, provider resolution | Learn from reliability design, but avoid a second agent loop [S14] |
| Remote / gateway operation | Agent available beyond the terminal, including messaging and autonomous tasks | Post-v1 consideration; coding product first [S15] |

**Technical reality.** Hermes has a Python-centered `AIAgent` orchestration runtime, whereas the chosen OpenCode baseline offers TypeScript/JavaScript SDK and extension surfaces. A direct two-way code merge would introduce duplicated session, provider, policy and tool systems. It increases maintenance risk without guaranteeing product improvement [S5, S14].

## 2.3 Capability mapping: inherit, adapt, build, defer

| Capability | OpenCode | Hermes | Bashwink decision | Release |
|---|---|---|---|---|
| Terminal UI, editor diff, file tools | Core strength | Available | **Inherit OpenCode** | v0.1 |
| Model/provider management | Core | Broad | **Inherit; test** | v0.1 |
| Permissions, approvals | Core | Has safety checks | **Inherit + stricter defaults** | v0.1 |
| Plan/build workflow | Built-in | Tasks/todos | **Extend with explicit task contracts** | v0.1/v0.2 |
| Session restore, undo | Built-in | Checkpoints | **Inherit; verify** | v0.1 |
| Skills | Built-in | Self-created/updatable | **Extend with human review, provenance** | v0.2 |
| Cross-session memory | Existing ecosystem / integrations | Curated memory | **Own project-brain extension** | v0.2 |
| Subagents | Background | Parallel delegation | **Add execution/merge gates** | v0.3 |
| Git worktrees | Available | Delegation patterns | **Use for conflict isolation** | v0.3 |
| Sandboxed shell | Existing execution paths | Pluggable backends | **Own Docker adapter; preserve permissions** | v0.3 |
| IDE, desktop, mobile | Multiple surfaces | Desktop/ACP | **Avoid for MVP** | Later |
| Chat messaging gateway | Not a coding CLI priority | Major strength | **Out of scope initially** | Later |
| Autonomous cron and bot workflows | Some automation surfaces | Major strength | **Defer** | Later |

# 3. Goals, non-goals and product principles

## 3.1 Goals

**G1** Deliver a dependable `bashwink` command that can be installed, configured, launched inside a Git repository and used for normal coding tasks.  
**G2** Preserve compatibility with common upstream coding workflows; measure fork drift.  
**G3** Create a transparent plan/task/evidence lifecycle rather than unconstrained “agent says done.”  
**G4** Improve second-session usefulness through correct, reviewable project knowledge.  
**G5** Introduce safe command execution and isolated multi-agent work without making setup difficult.  
**G6** Publish with accurate attribution, reproducible builds, tests and contributor onboarding.

## 3.2 Non-goals before v1

- Training a proprietary foundation model or promising better reasoning than upstream models.
- Recreating the entire OpenCode desktop, web, mobile and provider stack.
- Reimplementing Hermes' Python agent loop inside the TypeScript engine.
- Running unapproved shell commands on a developer's host in an “autonomous” setting.
- Secretly collecting source code, prompts, tokens or telemetry.
- Building a hosted SaaS, billing service, messaging bot or multi-tenant cloud control plane.
- Fully autonomous PR merging or deployments in the first stable release.
- Guaranteed bug-free code or guaranteed savings on token costs.

## 3.3 Principles

1. **Local first; cloud optional.** User owns code and data.
2. **Explainable actions.** Every consequential tool call, edit and test can be inspected.
3. **No false success.** A failed or unrun test is never reported as passing.
4. **Least privilege.** Separate read, edit, shell, network and secret privileges.
5. **Upstream-friendly fork.** Prefer plugins/adapters; document unavoidable core diffs.
6. **Explicit learning.** Proposed memories and skills require defined approval policies.
7. **Fast startup and small footprint.** Avoid heavyweight local vector infrastructure by default.
8. **Reversible by default.** Prefer new worktree/branch and explicit checkpoints.

# 4. Users and primary workflows

## 4.1 Personas

**P1 — Daily developer:** “Fix this FastAPI bug, run focused tests, show me the patch.” Needs fast setup, accurate edits and confidence.  
**P2 — Repository maintainer:** “Explain this project, align to its conventions, make a small release.” Needs repository history, consistent behavior and test evidence.  
**P3 — Advanced agent builder:** “Delegate investigation, implementation and review to different models.” Needs extensible orchestration and budgets.  
**P4 — Security-sensitive developer:** “Work inside this checkout but do not access home secrets or push code.” Needs isolation and policy enforcement.

## 4.2 Golden paths

**Journey A: first run**: install → `bashwink doctor` → model auth/config → enter repo → `bashwink` → ask for read-only explanation → request change → see plan/permissions → approve edits → inspect diff → run tests → verify result.

**Journey B: multi-session project understanding**: scan allowlisted project metadata → user confirms project conventions → next session prompts referencing conventions → memory shows source, timestamp and confidence → user can edit/forget memory.

**Journey C: verified code change**: user asks bug fix → build task list with acceptance tests → record baseline → apply patch → run tests → classify fail/pass/skipped → produce evidence summary with test command and exit code → user accepts or rolls back.

**Journey D: parallel feature**: user approves plan → coordinator creates two independent child tasks in worktrees → read/edit policy inherited or narrowed → workers return structured changes → coordinator verifies integration/tests → user chooses merge/apply.

# 5. Functional requirements

Priorities: **P0** required for usable first release; **P1** important differentiator; **P2** later enhancement. IDs are stable and correspond to implementation tasks.

## 5.1 CLI and developer experience

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-001 | P0 | `bashwink --version`, `--help`, `doctor`, `init`, `run` work on macOS and Linux; errors have nonzero exit codes. |
| FR-002 | P0 | Interactive TUI streams assistant output, tools and approval prompts without losing cancellation. |
| FR-003 | P0 | Resume an existing session across process restart; do not conflate repositories. |
| FR-004 | P0 | Show Git-aware diffs before accepting changes; support undo/redo or equivalent safe restore. |
| FR-005 | P0 | Support `plan` and `build` modes with materially different write permissions. |
| FR-006 | P0 | Clear onboarding for model provider, credentials, workspace trust and privacy. |
| FR-007 | P1 | `/status`, `/plan`, `/tasks`, `/evidence`, `/memory`, `/learn`, `/sandbox`, `/budget` commands. |
| FR-008 | P1 | Export run summary as Markdown and machine-readable JSON. |

## 5.2 Coding engine and model orchestration

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-009 | P0 | Read/search/edit/patch/shell tools function via tested upstream contracts. |
| FR-010 | P0 | Provider selection and BYOK configuration work without sending credentials to logs. |
| FR-011 | P0 | Cancellation terminates active task safely and records partial state. |
| FR-012 | P0 | Context compaction preserves current objective, files, key decisions, safety rules and task state. |
| FR-013 | P1 | Per-task model choice subject to explicit policy; never silently switch to a chargeable provider. |
| FR-014 | P1 | Track token usage/cost estimates per model, session and task; distinguish estimate from billed amount. |
| FR-015 | P2 | Fallback model routing for retriable provider errors with per-task budget ceilings. |

## 5.3 Plan and execution contracts

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-016 | P0 | Plan artifact includes objective, changed files, risks, task dependencies and acceptance tests. |
| FR-017 | P0 | Tasks have stable IDs and states: `queued`, `running`, `blocked`, `failed`, `verified`, `cancelled`. |
| FR-018 | P0 | Edits and test events link to the task that caused them. |
| FR-019 | P1 | User can approve/modify plan before material file edits for nontrivial requests. |
| FR-020 | P1 | Dependencies prevent a task from starting prematurely. |
| FR-021 | P1 | Resume after interruption without double-applying completed patches. |

## 5.4 Verification and proof of work

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-022 | P0 | Record attempted test commands, exit codes, duration, relevant output, timestamp and execution environment. |
| FR-023 | P0 | Distinguish `passed`, `failed`, `not_run`, `inconclusive` rather than inferring results from model text. |
| FR-024 | P0 | Final response references actual patch/diff identifiers and test events. |
| FR-025 | P1 | Verification policy maps file changes to relevant checks, plus a user-configured required test command. |
| FR-026 | P1 | Generate a concise evidence manifest; never include secrets/raw sensitive output by default. |
| FR-027 | P2 | Independent reviewer agent flags correctness/security risks with file/line evidence. |

## 5.5 Project brain and skill learning

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-028 | P1 | Per-repository memory backed by SQLite and SQLite FTS5, with no cloud dependency. |
| FR-029 | P1 | Memory types: convention, architecture decision, preference, verified command, known pitfall; each includes source, scope, timestamp and status. |
| FR-030 | P1 | Candidate memories are proposed at task end and approved/rejected by user, unless narrower preapproved policy exists. |
| FR-031 | P1 | Retrieval uses lexical search first; only selected, relevant memories enter model context. |
| FR-032 | P1 | `/memory list|show|approve|reject|edit|delete|export` works; deletion removes stored entry and prevents future retrieval. |
| FR-033 | P1 | Contradictory memories are flagged; stale knowledge can be expired and confirmed. |
| FR-034 | P1 | `/learn` proposes a skill document; user reviews diff before persistence, with provenance. |
| FR-035 | P2 | Optional embedding/semantic retrieval adapter without requiring an external vector database. |

## 5.6 Isolation, subagents and automation

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-036 | P1 | Optional Docker executor accepts explicit workspace mount, CPU/memory/time/network policy; works without host secrets. |
| FR-037 | P1 | Untrusted/high-autonomy jobs require an isolated executor, not default host shell privileges. |
| FR-038 | P1 | A sandbox task receives only scoped files and approved credentials; cleanup is reliable. |
| FR-039 | P1 | Coordinator assigns read-only/executor roles, budgets, max steps and stop conditions to child jobs. |
| FR-040 | P1 | Concurrent writers use distinct worktrees/branches; conflicting edits are surfaced for review. |
| FR-041 | P1 | Child completion requires artifact paths and actual test evidence, not just a success claim. |
| FR-042 | P2 | Backend adapter supports future SSH/cloud sandboxes without changes to agent planning logic. |
| FR-043 | P2 | CI headless JSON output and resumable batch runs with explicit permissions. |

## 5.7 Ecosystem and maintainability

| ID | Priority | Requirement / measurable acceptance |
|---|---|---|
| FR-044 | P0 | Preserve a documented list of retained upstream behavior and compatibility exceptions. |
| FR-045 | P0 | License and attribution preserved; legal audit of bundled assets and third-party dependencies. |
| FR-046 | P0 | CI runs lint, typecheck, tests, smoke install, license and secret scanning. |
| FR-047 | P1 | Extension API versioning and sample plugin; compatibility tests for selected upstream plugins. |
| FR-048 | P1 | `CONTRIBUTING.md`, code of conduct, security disclosure instructions and issue templates. |
| FR-049 | P1 | Upstream sync process with changelog, compatibility matrix and automated regression run. |

# 6. Proposed technical architecture

## 6.1 Architecture decision

**Baseline:** pin the OpenCode v2 development line to a *tested release tag/commit* during Stage 0; OpenCode's official product page listed v2.3.2 dated 18 November 2026 at this research cutoff [S3]. Pin the exact verified Git commit in an ADR; do not code against a floating `dev` branch. Verify the repository state, package licenses and published binaries before releasing Bashwink.

**Language and runtime:** TypeScript/Bun on the adopted core; SQLite for local metadata. Python may be useful for optional external tools or eval harnesses, but not as a second core. The baseline choice is proposed until the 2-day architecture spike validates actual extension seams.

## 6.2 Logical topology

```text
Developer / Terminal
        |
     Bashwink CLI + TUI  ---- configuration / auth / approval UI
        |
  OpenCode-derived session host and events
        |
        +---- Existing provider + model routing
        +---- Existing code tools (read/search/edit/shell)
        +---- Existing agents + plugins + MCP
        |
   Bashwink extension services
        +---- Plan & task coordinator
        +---- Evidence / verification ledger
        +---- Project brain (SQLite + FTS5)
        +---- Skills proposal & review
        +---- Budget / policy middleware
        +---- Execution backend interface
                    +---- Local (trusted, permission-gated)
                    +---- Docker (isolated, opt-in for v0.3)
                    +---- SSH/cloud backends (post-v1)
        |
  Git checkout / worktree / source tree
        |
  tests + evidence report + reviewed patch
```

## 6.3 Proposed module boundaries

| Component | Responsibility | Key interfaces |
|---|---|---|
| `bashwink-cli` | Branding, commands, onboarding, error handling | CLI command registration |
| `bashwink-plan` | Persist objective, task DAG, state transitions | `createPlan`, `transitionTask`, `resumePlan` |
| `bashwink-evidence` | Append-only tool/test evidence, manifest generation | `recordEvent`, `verifyRequirement`, `exportRun` |
| `bashwink-brain` | Scoped project facts, retrieval, approval, deletion | `proposeMemory`, `searchMemory`, `approveMemory` |
| `bashwink-skills` | Skill extraction, validation, review, versioning | `proposeSkill`, `diffSkill`, `applySkill` |
| `bashwink-sandbox` | Backend negotiation and constrained execution | `prepare`, `exec`, `sync`, `dispose` |
| `bashwink-orchestrator` | Delegate task scopes, worktrees, budgets and merge gate | `spawn`, `monitor`, `collect`, `integrate` |
| `bashwink-policy` | Extra high-level guardrails, secret redaction, audit | `authorize`, `redact`, `budgetCheck` |
| `bashwink-tests` | Golden tasks, replay/evaluation harness | `runFixture`, `score`, `compare` |

**Extension rule:** Prefer an OpenCode plugin or companion package over editing its agent loop, provider implementations or session storage. Any upstream core patch requires a documented reason, automated test, owner and rebase plan.

## 6.4 State model (normative)

```text
Plan(id, repository_id, objective, status, created_at, approved_at)
Task(id, plan_id, title, status, dependency_ids, assignee, worktree, budget)
ToolEvent(id, task_id, call_id, tool, sanitized_args, started_at, ended_at, exit_code)
Evidence(id, task_id, kind, command, status, output_digest, artifact_path, source_event_id)
Memory(id, repository_id, scope, type, content, source, confidence,
       status, created_at, verified_at, expires_at, supersedes_id)
SkillProposal(id, repository_id, name, source_task_id, diff, status, created_at)
Run(id, plan_id, session_id, model, provider, estimated_cost, status)
```

IDs should be opaque; schema migrations must be versioned. **Do not duplicate every upstream session message.** Keep only Bashwink task/evidence and memory metadata with stable references to upstream IDs.

## 6.5 Suggested repository layout

```text
bashwink/
  LICENSE
  THIRD_PARTY_NOTICES.md
  README.md
  CONTRIBUTING.md
  SECURITY.md
  packages/                  # inherited OpenCode packages, kept upstream-aligned
  extensions/
    bashwink-cli/
    bashwink-plan/
    bashwink-evidence/
    bashwink-brain/
    bashwink-skills/
    bashwink-policy/
    bashwink-sandbox/
    bashwink-orchestrator/
  tests/
    fixtures/
    golden-tasks/
    integration/
    security/
  docs/
    architecture/
      ADR-001-upstream.md
    product/
      PRD.md
      ROADMAP.md
      BACKLOG.md
  scripts/
    upstream-sync.sh
    check-attribution.sh
```

This is a *target* layout; validate real OpenCode v2 monorepo conventions before creating packages. Do not make the initial release dependent on a large directory refactor.

# 7. Core execution contracts and algorithms

## 7.1 User-request lifecycle

```text
Request
  -> Repository + policy scope
  -> Interpret + explore
  -> Build task plan + proposed tests
  -> Approval gate (if risk/size requires)
  -> Execute task(s) with event capture
  -> Run validation commands and classify outcomes
  -> Present diff + evidence + unresolved risks
  -> User accept / revise / rollback
  -> Propose memory/skill (review required)
```

**Task state invariants:** A task may become `verified` only if the configured criteria are observed; model assertions cannot change it to verified. An execution failure records an event even if the model later recovers. A cancelled run keeps its partial artifacts attributable and reversible.

## 7.2 Verification policy

- Default tests derived from repository project files are **suggestions**, never falsely marked mandatory if undetected.
- Support project `required_checks` explicitly in `bashwink.jsonc`.
- Verification result categories: `passed`, `failed`, `not_run`, `inconclusive`.
- Capture time, environment fingerprint, command, exit code and bounded/log-redacted output.
- If tests are not available or permission denied, report `not_run` and reasons.
- Distinguish static checks, unit tests, integration tests, and manual review; do not combine them into one generic “tests passed.”
- Only include positive claims in the final summary that have a specific evidence reference.

## 7.3 Project memory pipeline

```text
Potential durable lesson
 -> extract minimal candidate
 -> classify (preference / decision / convention / command / pitfall)
 -> attach repo + source + provenance + timestamp
 -> redact sensitive material
 -> detect duplicate / conflict / expiry
 -> show user review (or apply preapproved narrow rule)
 -> store in SQLite with searchable index
 -> retrieve only if current task relevant
 -> user can inspect, edit, revoke or export
```

**Anti-hallucination rule:** Never turn unverified assistant guesses into lasting architectural facts. Commands are marked `verified` only when actually executed successfully in the stated environment. A memory is not automatically trusted merely because it came from a README; record it as a repository-source claim.

**Context budget:** inject a small selected set (configurable) of memory entries; include provenance and age in the hidden input to the model. Avoid long memory dumps that harm prompt caching.

## 7.4 Multi-agent execution protocol

Each child gets a structured `TaskEnvelope`:

```json
{
  "taskId": "T-012",
  "goal": "Implement isolated parser change",
  "worktree": "/workspace/.worktrees/task-012",
  "allowedPaths": ["src/parser/**", "tests/parser/**"],
  "requiredChecks": ["npm test -- parser"],
  "maxModelSteps": 30,
  "budgetUsd": 2.0,
  "permissions": {"network": false, "shell": "ask", "gitPush": false},
  "deliverables": ["patch", "test evidence", "risk summary"]
}
```

**Important:** The example is a product-specific contract proposal, not an existing OpenCode or Hermes API.

- Coordinator must validate child scopes against parent policy. A child can receive less privilege, never more.
- Default maximum concurrent worker agents: **2** for v0.3; configurable hard cap after stability tests.
- Parallel edits to the same target file are prohibited in the initial multi-agent implementation.
- Children cannot push, deploy or merge automatically without a separate user approval.
- Results must include changed paths, base revision, validation exit codes, unresolved conflicts and artifact provenance.
- Coordinator re-runs relevant tests in the integration worktree after applying changes.
- No nested delegation in v0.3. Durable orchestration across process restart is a later feature.

# 8. Security, privacy and threat model

**Threats to design for:** malicious repository instructions, prompt injection in tool/web results, destructive shell commands, secrets in `.env` or home directories, unexpected network egress, malicious MCP/plugins, symlink/path traversal attacks, worktree/branch confusion, command injection, output leakage through logs and untrusted model-generated scripts.

**Minimum controls (shipping gates):**
1. Use upstream permission/policy checks for file, shell, external-directory and tool access; do not replace their security role with a custom prompt.
2. Deny destructive operations and Git push/deploy by default; ask for explicit authorization where supported.
3. Never treat a model-generated shell string as already safe. Scan and enforce policy at execution time.
4. Treat repository files, external docs, MCP output and agent-produced skills as untrusted instructions.
5. Do not mount `$HOME`, SSH keys or cloud credentials into sandboxes unless the user explicitly selects a narrowly scoped source.
6. Docker executor supports network off by default for suitable tasks; use resource/timeout limits, read-only mounts where feasible, non-root user, and explicit workspace write scope.
7. Sandbox is not a perfect security boundary; document Docker daemon privileges and host-mount risks.
8. Encrypt secrets using OS keychain/approved upstream credential mechanism where supported; never store in task/memory tables.
9. Redact tokens, auth headers and common secret patterns before persistent audit logs and exports.
10. Self-learning skills remain untrusted until reviewed, versioned and approved. Disallow silent updates to shared project skills.
11. CI security suite includes symlink escapes, path traversal, shell injection, malicious `AGENTS.md`, plugin hooks, and exfiltration test fixtures.
12. Default telemetry: **off**. Provide opt-in, exact disclosure, export and deletion behavior if ever added.

**Risk note:** Hermes' documentation describes container isolation but also warns that forwarded environment variables can be exposed to commands inside the container [S11]. OpenCode explicitly distinguishes user permission controls from policy enforcement [S6]. Bashwink should combine these concerns, not conflate user approvals with hard isolation.

# 9. Non-functional requirements and acceptance targets

These are **targets to be validated on actual hardware**, not current achieved performance.

| Area | Proposed target | Measurement |
|---|---|---|
| Platforms | macOS arm64/x64 and Linux x64 first; Windows later | Clean install matrix |
| CLI startup | Median under 2 seconds on a warm local run (excluding provider latency) | 20-run startup benchmark |
| Single-run reliability | 95%+ fixture runs produce a valid terminal status, even on failures | Fault-injection suite |
| Resume | Session survives restart without losing task/event association | Restart integration tests |
| Evidence fidelity | 100% terminal test claims correlate with recorded tool exit event | Golden evaluator |
| Memory safety | 0 unapproved durable writes in default policy tests | Memory policy tests |
| Secret exposure | 0 seeded fixture secrets in emitted logs or exports | Canary scanning |
| Workspace isolation | 0 writes outside allowed paths in adversarial sandbox fixtures | Path/permission tests |
| Cost budget | Stop new model calls at configured ceiling; explicit notice to user | Budget tests |
| Resource use | SQLite-only memory mode works without vector DB / daemon | Minimal install smoke |
| Compatibility | All declared upstream preserved-path tests pass against pin | Regression suite |
| Accessibility | TUI usable with keyboard; contrast and non-color statuses | Manual terminal review |

## 9.1 Evaluation datasets

Create a reproducible local suite with at least 30 tasks before claiming performance gains: 10 code exploration tasks, 10 targeted bug fixes (small Python/TypeScript repos), 5 refactors, 5 adversarial/safety tasks. Each fixture has a clean base commit, expected tests, budget, allowed paths and review rubric.

Measure success rate, tests actually passed, time-to-first-action, wall time, median cost estimate, tokens, number of unapproved actions, memory-precision@5 (human adjudicated), conflicting edits, and reviewer findings. Compare **same model/config/seed where possible** between Bashwink and pinned OpenCode; report uncertainty rather than grand benchmark claims.

# 10. Detailed delivery strategy

## 10.1 Stage gates

| Stage | Build objective | Exit gate | Rough solo-effort planning band* |
|---|---|---|---|
| S0 Research & fork spike | Baseline, licenses, architecture, CLI rename feasibility | Fork boots; upstream test suite known; ADR approved | 1-2 weeks |
| S1 v0.1 coding CLI | Branding, `doctor`, safe coding flow, plan tasks, evidence | Three end-to-end Git fixture tasks succeed | 3-5 weeks |
| S2 v0.2 project brain | Memory proposals/review, FTS retrieval, skill draft/review | Second-session recall improves without unsafe writes | 3-5 weeks |
| S3 v0.3 controlled autonomy | Docker backend, child contracts, worktrees and integration checks | Isolation and conflict tests pass | 4-7 weeks |
| S4 v0.4 hardening | Performance, docs, eval suite, packaging, plugin contracts | Release candidate passes quality/security bar | 3-5 weeks |
| S5 v1.0 stable | Stabilization, upgrade/migration, support policy | 30-task evaluation + public release checklist | Depends on defects |

*Bands assume one experienced developer working part time with AI coding help; they are planning ranges, not promises. Fork changes and OpenCode evolution may significantly change estimates. Complete S0 before committing calendar dates.

## 10.2 MVP definition (the smallest publishable release)

**Must ship:** executable `bashwink`, BYOK provider config, plan/build modes, read/edit/test flow, permission prompts, session resumption, diff/undo preservation, task IDs, evidence summary, README, license notices, CI and install instructions.

**Must not block v0.1:** automatic learning, remote gateways, multi-agent parallelism, cloud sandboxes, local embeddings, desktop UI, full extension marketplace, self-hosted model server.

**Public launch promise:** “An open-source coding CLI that makes plans and test evidence explicit.” It is defensible, limited and measurable.

# 11. Release and operational plan

**Branch discipline:** `main` reflects released Bashwink; `develop` optional; `upstream-track` tracks pinned OpenCode; features in small PRs. Tag each upstream baseline and publish a fork-delta report.

**Versioning:** semantic versioning for Bashwink; version string includes upstream baseline in build metadata/documentation. Changes in upstream extension APIs may require minor/major Bashwink increments.

**Distribution:** begin with source install and one tested macOS arm64 binary (or package) after architecture validation, then Linux and additional systems. Never copy OpenCode release assets or branding without reviewing their rights and compatibility. Prefer reproducible GitHub Actions builds and checksums.

**Docs:** quickstart, safety model, provider credentials, memory controls, sandbox setup, supported upstream features, known incompatibilities, troubleshooting, contribution guide, changelog.

**Community:** GitHub discussions, good-first-issue labels, issue/PR templates, releases with compatibility notes, threat disclosure workflow and realistic roadmap. Do not advertise production safety without testing.

**Maintenance budget:** reserve at least 20-30% of development time for upstream sync, tests, dependencies, issues and documentation. The fork is an ongoing maintenance commitment.

# 12. Risk register and decisions

| Risk | Impact | Mitigation / trigger |
|---|---|---|
| Upstream OpenCode API churn | High | Pin version; extensions first; baseline regression matrix; ADR for core patches |
| Fork becomes unmergeable | High | Keep fork delta small; monthly upstream diff review; stop and reconsider after repeated large conflicts |
| Feature parity arms race | High | Differentiate on verified execution + project brain; defer UI/gateway breadth |
| Memory misinformation | High | Candidate/provenance/review/TTL; no self-certifying fact writes |
| Secrets leaked in sandbox or logs | Critical | Least-privilege mounts, redaction, canary security tests |
| Multi-agent edit collisions | High | Distinct worktrees, path ownership and integration re-test |
| Cost runaway | High | Per-run budgets and step limits; visible cost estimates and explicit fallback approval |
| Overly slow startup / high RAM | Medium | SQLite FTS5, lazy extensions, no mandatory Python/vector server |
| Trademark confusion | Medium | Own Bashwink brand; prominent attribution and non-affiliation notice |
| License/asset compliance | High | Keep MIT texts; dependency SBOM; review fonts, images, screenshots and package licenses |
| Windows support burden | Medium | Limit initial platform matrix; announce support accurately |
| Too much scope for solo contributor | High | Stage-gate roadmap; publish v0.1 before S2/S3 |

## 12.1 Fork / plugin go-no-go decision

At S0, test three approaches on the same tiny feature: (A) upstream-compatible plugin, (B) shallow OpenCode fork with plugin, (C) deeper fork. Score ease of onboarding, plugin hooks, required patches, packaging, upstream sync, and custom CLI naming. **Default to B**, unless A yields equivalent UX with much lower maintenance. Do *not* attempt a Hermes code merge in any variant.

## 12.2 Legal/brand checkpoint

Both root repositories currently show MIT licenses [S16, S17], which generally permit modifying and distributing code with preservation of copyright/license notices. **This does not grant trademarks, brand assets, proprietary service credentials, hosted endpoints or every transitive dependency.** Audit each copied subtree and third-party license. Add `THIRD_PARTY_NOTICES.md`, preserve original copyright and add “Bashwink is independent; not affiliated with Anomaly/OpenCode or Nous Research/Hermes Agent.” Review naming conflicts before public launch. This is engineering compliance guidance, not legal clearance.

# 13. Backlog governance

Implementation-ready issues are in the companion file `IMPLEMENTATION_BACKLOG.md`. Each item includes a stable issue ID, stage, size, owner role, dependencies, task and acceptance criteria. Do not start S2/S3 work while v0.1 release gates remain open.

**Task priority policy:** P0 core correctness/safety > P1 distinguishing functionality > P2 ecosystem/breadth. If a defect threatens data loss or secrets, it blocks release independent of its nominal priority.

**Definition of done (for every code issue):** tests added/updated, docs updated, adequate logging without secrets, error/cancellation behavior defined, code review completed, no regression to approved upstream behavior, and changelog when user-visible.

# 14. Example Bashwink CLI experience (proposed syntax)

```bash
# Initial verification and setup
bashwink doctor
bashwink init

# Interactive coding session in current repo
bashwink

# Headless bounded run
bashwink run "Fix broken parser validation" --mode plan --json

# Review durable project knowledge
bashwink memory list
bashwink memory review

# Optional Docker execution after v0.3
bashwink run "Fix test failures" --sandbox docker --budget-usd 3

# Inspect an execution report
bashwink evidence export --session <session-id> --format md
```

The syntax is a product proposal and **must be reconciled against OpenCode's actual command parser** during S0. A command appearing in this document does not mean it already exists.

## 14.1 Proposed configuration

```jsonc
{
  "$schema": "https://example.org/bashwink/config.schema.json",
  "project": { "trust": "ask" },
  "approval": { "shell": "ask", "edit": "ask", "gitPush": "deny" },
  "plan": { "approvalForMultiFile": true },
  "verification": { "requiredChecks": ["npm test"] },
  "memory": { "enabled": true, "durableWrite": "review", "maxInjectedEntries": 6 },
  "execution": { "backend": "local", "network": "ask" },
  "orchestration": { "maxParallel": 2, "nestedDelegation": false },
  "budget": { "maxUsdPerRun": 3.0 },
  "telemetry": { "enabled": false }
}
```

This is an illustrative *target config*, not the existing OpenCode schema. The real implementation should avoid storing duplicate settings that conflict with upstream permissions and policy.

# 15. Open questions that do not block S0

1. Can branding and CLI alias be achieved entirely by packaging/config, or will it require core changes?
2. Which OpenCode v2 extension hooks reliably expose full test stdout, command exit and file edit events?
3. How stable are worktree APIs across OpenCode v2 releases?
4. Should the task/evidence storage share a SQLite database with sessions or stay in its own DB? Default: separate, referenced by IDs.
5. How will repo identity behave with renamed directories, remote URLs, nested repos and worktrees?
6. How do we handle organization policies and upstream provider integrations in a modified distribution?
7. Is automatic project scanning opt-in, and should the first run show a scope preview?
8. What constitutes a “verified” memory with only source files but no executable proof?
9. What threat model applies to remote Docker daemons and macOS Docker Desktop?
10. At what fork-delta threshold should Bashwink revert to a plugin-only extension strategy?

# 16. Next 10 working sessions — recommended execution order

1. Clone OpenCode official repository, record tested commit and release; run baseline build/tests.
2. Inspect CLI command registration, package structure and plugin hooks; write ADR-001.
3. Prototype `bashwink` command in a scratch branch; preserve upstream behavior.
4. Create baseline CLI fixture: explain a repo; edit one file; run tests; undo.
5. Hook into session/tool events and emit a safe JSONL evidence trace.
6. Add an evidence report with real exit-code-based `passed/failed/not_run` statuses.
7. Add `Plan` and `Task` persistence and link tool events to task IDs.
8. Implement approval and destructive-command regression fixtures.
9. Prepare CI, legal notices, README and source install instructions.
10. Run three independent end-to-end coding fixtures; fix defects and cut `v0.1.0-alpha.1`.

# 17. Release acceptance checklist

- [ ] Fresh install works on all *advertised* platforms.
- [ ] Exact upstream pin, license files and notices are committed.
- [ ] Model auth works; secrets do not appear in logs, exports or memory.
- [ ] CLI plan/build flows, diff and restart work.
- [ ] Cancel/timeout do not misreport success.
- [ ] All P0 functional requirements have linked tests.
- [ ] Evidence manifest matches actual commands and exit codes.
- [ ] Denied/asked command policies cannot be bypassed by child or plugin paths.
- [ ] No unapproved durable memory writes.
- [ ] Security and path-isolation test fixtures pass for enabled execution backend.
- [ ] Evaluation results are published with model/version caveats.
- [ ] Supported/unsupported features are documented; upstream claims not overstated.
- [ ] Release binary checksums and provenance are published.
- [ ] Public roadmap and contribution/security channels are ready.

# 18. Sources and verification ledger

Sources accessed 22 November 2026. These links are primary project documentation/repositories. The product proposal and roadmap are Bashwink design recommendations, **not** features asserted to already exist.

- **[S1]** OpenCode official introduction: https://opencode.ai/docs/
- **[S2]** OpenCode agents: https://opencode.ai/docs/agents/
- **[S3]** OpenCode product, release dates and platform inventory: https://opencode.ai/press
- **[S4]** OpenCode plugins: https://opencode.ai/docs/plugins/
- **[S5]** OpenCode embedded SDK: https://opencode.ai/docs/build/sdk
- **[S6]** OpenCode permissions and policies: https://opencode.ai/docs/permissions/ and https://opencode.ai/docs/policies
- **[S7]** OpenCode snapshots: https://opencode.ai/docs/snapshots/
- **[S8]** OpenCode 2026 change log, worktree release: https://opencode.ai/changelog
- **[S9]** Hermes skills system: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- **[S10]** Hermes persistent memory: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- **[S11]** Hermes terminal backends and security: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools and https://hermes-agent.nousresearch.com/docs/user-guide/security
- **[S12]** Hermes delegation guide: https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns
- **[S13]** Hermes tool runtime: https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime
- **[S14]** Hermes architecture/agent loop: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture and https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop
- **[S15]** Hermes official introduction: https://hermes-agent.nousresearch.com/docs
- **[S16]** OpenCode root MIT license: https://github.com/anomalyco/opencode/blob/dev/LICENSE
- **[S17]** Hermes root MIT license: https://github.com/NousResearch/hermes-agent/blob/main/LICENSE
- **[S18]** OpenCode repository and independent-project naming guidance: https://github.com/anomalyco/opencode

---

**Status at issuance:** Research and planning only. No Bashwink codebase, fork, test run, release or trademark clearance is implied by this document.


---

# Part II — Actionable implementation backlog

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

### BW-031 — Native sandbox adapter
**Priority:** P1 | **Size:** L | **Depends:** BW-030 | **Owner:** Runtime / Security  
**Current work and acceptance:** See the [revised implementation plan](BW-031_IMPLEMENTATION_PLAN.md)
and [canonical task register](BASHWINK_TASKS_90.csv). The preferred path runs without Docker.

### BW-032 — Sandbox threat and platform qualification
**Priority:** P1 | **Size:** L | **Depends:** BW-031 | **Owner:** Security  
**Current work and acceptance:** See the [platform controls](BW-032_PLATFORM_QUALIFICATION.md)
and [canonical task register](BASHWINK_TASKS_90.csv).

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
