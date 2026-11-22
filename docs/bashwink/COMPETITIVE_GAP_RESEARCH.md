# Bashwink 2.0 — Competitive Gap Investigation

**Research cutoff:** 2026-11-22  |  **Status:** evidence-led product research, not a claim of exclusive invention  
**Scope:** Hermes Agent, OpenCode, Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Gemini CLI, Aider, Cline, OpenHands; original engineering studies; security guidance; qualitative developer complaints.

## Executive determination

**Build Bashwink as an evidence-first engineering agent, not as a bundle of commodity AI coding features.** Keep the shallow OpenCode fork assumption contingent on S0 architectural feasibility and license audits. Import *patterns*, not raw Hermes or OpenHands implementations. The product promise is: **specify intent → map impact → implement in controlled scope → independently validate → hand over a reviewable proof package → learn only from verified outcomes**.

The important distinction is between *feature unavailable anywhere* and *an end-to-end workflow not clearly established as dependable across surveyed tools*. This report does **not** claim universal absence. Product documentation is not an exhaustive source-code audit, and vendor behavior changes frequently. Confidence tags: **D**=official documented capability; **R**=research-backed unmet need; **I**=our product inference/design hypothesis; **U**=not established by reviewed docs, **not** proven absent.

## 1. What leading tools already deliver — no false novelty

| Product | Officially documented strengths | Implication for Bashwink | Sources |
|---|---|---|---|
| **OpenCode** | Multimodel CLI/desktop/mobile/SDK, MCP, multi-session, programmable tooling/permissions, background subagents; recent 2.3.0 iteration | Reuse baseline orchestration and UX; don't advertise mere subagents as novelty | [OpenCode homepage](https://opencode.ai/), [V2 permissions](https://opencode.ai/docs/permissions/), [v2.3.0](https://opencode.ai/changelog/v2.3.0) |
| **Hermes Agent** | Cross-session FTS memory, memory curation and reusable skills, execution backends incl. Docker/SSH/cloud, scheduled work, delegation | Borrow governance and execution concepts; implement through interface adapters | [Hermes README](https://github.com/NousResearch/hermes-agent) |
| **Claude Code** | Project instructions, subagents, hooks, agent teams and memory controls | Agent teams and skills already mainstream | [Anthropic guidance](https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more), [docs](https://code.claude.com/docs/en/claude-code-on-the-web) |
| **Codex** | CLI/local/cloud, worktrees, review, SDK, skills, scheduled automation and review queue | Cloud jobs, review, worktree execution are not gaps by themselves | [OpenAI app introduction](https://openai.com/index/introducing-the-codex-app/), [DevDay 2026](https://openai.com/index/devday-2026-recap/) |
| **Cursor** | Agent, cloud/background agents, Bugbot review, memory, coordinator Projects and automations | Independent review + fleet orchestration already being attempted commercially | [Cursor Agent](https://cursor.com/help/ai-features/agent), [Projects](https://cursor.com/changelog?s=09), [Bugbot](https://cursor.com/en-US/changelog/1-0) |
| **GitHub Copilot** | Repository/personal memory, custom agents, instructions, security/code review, cloud agent | Basic memory and instructions aren't differentiators | [Copilot memory](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory), [customization](https://docs.github.com/en/copilot/reference/customization-cheat-sheet) |
| **Gemini CLI** | Extensions, skills, subagents, sandboxing, checkpoints, *auto-memory proposals with approval* | Even approved learning is documented elsewhere: refine its accuracy & test it | [auto-memory](https://geminicli.com/docs/cli/auto-memory/), [checkpointing](https://geminicli.com/docs/cli/checkpointing/), [extensions](https://geminicli.com/docs/extensions/) |
| **Aider** | Repository map, lint/test, Git history/undo, architect/editor split | Symbol indexing and basic verification are old ideas; advanced impact/risk is the proposed addition | [repo map](https://aider.chat/docs/repomap.html), [lint/test](https://aider.chat/docs/usage/lint-test.html) |
| **Cline** | Plan/Act, checkpoints, tasks, MCP and approvals | Revert and approvals alone do not differentiate Bashwink | [task management](https://docs.cline.bot/core-workflows/task-management) |
| **OpenHands** | Isolated agent runtimes, multi-agent canvases, **two-layer verification stack** (trajectory critic + PR review/QA) | Do not say "no agents independently verify." Compare strength/coverage/cost objectively | [verification stack](https://www.openhands.dev/blog/20260506-the-verification-stack), [SDK](https://www.openhands.dev/blog/introducing-the-openhands-software-agent-sdk) |

**Qualification:** This is a sample of public docs checked 2026-11-22. We have **not** performed a complete instrumented feature test of every current release or all third-party plugins. **“Unverified” is not “missing.”** A competitor can ship a capability even if its documentation does not mention it.

## 2. Evidence that the hard problems persist

| Problem | Evidence and why it matters | Evidence class |
|---|---|---|
| Intent/constraint drift | Observational analysis of 20,574 agent sessions identifies seven forms of developer-agent misalignment, incl. constraints, overreach and reporting | R: [analysis](https://arxiv.org/abs/2605.29442) |
| False-green self-tests | Agent can amend the test to match its implementation; Vercel explicitly recommends independent check and baseline comparison | R: [Vercel evaluation](https://vercel.com/i/evaluating-ai-coding-agents) |
| Code degrades under incremental changes | SlopCodeBench and SWE-Milestone study multi-step code erosion and continuous evolution | R: [SlopCodeBench](https://arxiv.org/abs/2603.24755), [SWE-Milestone](https://proceedings.mlr.press/v306/deng26d.html) |
| Long-horizon tasks remain difficult | SWE-Bench Pro focuses on realistic complex tasks; benchmarks themselves require auditing for flawed tasks and contamination | R: [paper](https://proceedings.mlr.press/v306/deng26f.html), [OpenAI benchmark audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/) |
| Security trust-boundary failures | OWASP highlights poisoned rules/skills/MCP inputs, overprivileged tools, prompt injection and provenance; Microsoft documented real CI attack paths | R: [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html), [Microsoft](https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/) |
| Retrieval isn't solved by huge context | Agent Retrieval Bench evaluates code→test, trace→code, edit→ripple, wrong-repo rejection | R: [benchmark](https://arxiv.org/abs/2607.24882) |
| Real engineering productivity differs from code-generation speed | A small 2025 METR RCT measured slower completion among experienced OSS developers using early-2025 tools; don't generalize unchanged to current agents | R: [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) |
| Replay is hard | Models, external tools and environments are nondeterministic; Chronicle proposes cut-point replay with recorded model/tool boundaries | R: [Chronicle](https://aclanthology.org/2026.realm-1.71/) |
| Qualitative developer dissatisfaction | Selected Reddit discussions describe fake success, missed context, uncertain quota usage and unwanted changes; anecdotal signals, **not** prevalence estimates | D/anecdote: [fake success](https://www.reddit.com/r/ClaudeAI/comments/1sdmohb/after_months_with_claude_code_the_biggest_time/), [cost](https://www.reddit.com/r/ClaudeAI/comments/1whvqcl/quota_draining_claude_code_rebills_a_finished/), [control](https://www.reddit.com/r/ClaudeCode/comments/1xrys5q/tldr_besides_limits_whats_the_worst_part_of/) |

### Benchmark warning

Do not market Bashwink using a cherry-picked SWE-bench Verified percentage. OpenAI published concerns over Verified in February and July 2026, while audits also questioned SWE-bench Pro's task quality. Bashwink will publish a versioned **evaluation portfolio** with clean task environments, repeated runs, hidden/evaluator-owned tests, cost, safety, and code maintenance metrics. Report model, harness, settings, commit hash, limitations and confidence intervals.

## 3. Gap taxonomy and design recommendations

Terms: **Strong** = user-visible differentiator worth building; **Enabler** = vital plumbing; **Research** = novel/experimental and difficult; **Commodity** = implement via upstream.

| ID | Candidate | Observed gap / unverified coverage | Proposed Bashwink solution | Novelty claim | Tier |
|---|---|---|---|---|---|
| G01 | **IntentLock** | Agents may satisfy an improvised interpretation | Lock objective, invariants, exclusions and per-criterion proof before edit; record clarifications and changes | Differentiation is strict cross-stage enforcement, not planning itself | Strong P0 |
| G02 | **TestGuard** | Agents can delete/weaken tests to appear successful | Baseline test inventory, required checks, protected-test-change approval and pre/post comparison | Not claiming tests are otherwise never protected | Strong P0 |
| G03 | **ProofPack** | Output often a narrative rather than auditable evidence | Signed optional, content-hashed evidence manifest tying each criterion to executed observation | Integrates existing testing with reproducible handoff | Strong P0 |
| G04 | **Independent QA lane** | Author/test correlated failure | Separate checker identity, read-only design, independently generated hidden tests, fresh process/worktree | Exists in OpenHands etc.; aim for accessible local workflow | Strong P1 |
| G05 | **Context Provenance** | Agent may use wrong branch/stale instructions | Every critical retrieved snippet carries repo, commit, path, content hash, freshness and source trust | Proposed integration | Strong P1 |
| G06 | **ImpactMap** | Repo map sees symbols but may not estimate change ripple | Fast grep+LSP+dependency map for affected tests, public API and call sites; human-readable risk list | Advanced targeted change-impact UX | Strong P1 |
| G07 | **ScopeFence** | Unrequested file edits and over-broad fixes | Proposed file-scope policy + review for boundary crossing; hard policy at tool layer | Guardrails exist; integrated intent linkage proposed | Strong P0 |
| G08 | **TrustZones** | Untrusted issue/README/skills may steer privileged tools | Label sources, enforce tool/secret/network scopes, quarantine foreign instructions | Security control, not perfect injection detection | Enabler P0 |
| G09 | **BudgetPilot** | Unbounded token/context/subagent cost | Per-task dollar/token/step/wall-clock caps with preflight and stop, overhead accounting | Some providers expose limits; seek unified guard | Strong P1 |
| G10 | **Recovery Ledger** | Ambiguous interrupted/partial actions | Durable steps, idempotency keys, recovery options; classify exact-known vs uncertain side effects | Event sourcing principle not unprecedented | Enabler P1 |
| G11 | **Failure Memory** | Prior failure repeated across sessions | Only verified bug/root-cause & regression signature become durable memories | Quality-governed memory is key, not memory alone | Strong P1 |
| G12 | **Skill Trials** | Learned procedures may propagate mistakes | Test candidate skill against golden, regression and adversarial scenarios before promotion | Gemini/Hermes already propose skills; evaluation-before-promotion wedge | Strong P1 |
| G13 | **Quality Drift Watch** | One task passes while repo steadily degrades | Trend modularity, dependencies, duplicate utilities, test gaps and churn over 5–10 follow-up tasks | Research-heavy, incremental-vs-long horizon | Research P2 |
| G14 | **ReviewPack** | Human time to inspect PR is neglected | Compact affected-behavior summary, tests baseline delta, evidence links, risks and unanswered questions | Product-level combination; not a novel code review model | Strong P1 |
| G15 | **Replay Lab** | LLM nondeterminism frustrates incident reproduction | Record sanitized model/tool boundaries; deterministic tool/call **simulation**, never claim real LLM deterministic replay | Inspired by Chronicle research | Research P2 |
| G16 | **Cost per accepted patch** | Raw tokens obscures total rework | Local measurement of active/review/rework time, accepted changes, reverted work and API cost | Empirical quality-of-life | Strong P1 |
| G17 | **Freshness-aware project brain** | Memories lose validity when code changes | Back memories with source commit/path/AST symbol and expire on material drift | Extends approved memory with proof linkage | Strong P1 |
| G18 | **Risk-adaptive workflow** | Tiny typo and auth migration shouldn't have same overhead | Low/medium/high risk policy; independent security/test review for risky surfaces; never waive baseline hard guards | Integrated workflow | Strong P1 |
| G19 | **Compatibility contracts** | Refactors break APIs beyond targeted tests | Detect exported API, schema, CLI and events changes against baseline; require consumer checks | Useful but framework-specific | Research P2 |
| G20 | **Causal debugging lane** | Retry loops often repeat without hypothesis | Hypothesis → falsifiable diagnostic → observation → controlled patch; stop repeated commands | Product discipline | Strong P1 |
| G21 | **Coverage of negative requirements** | What must *not* change is rarely proved | No-edit zones, performance/resource ceilings, security and compatibility invariants | IntentLock extension | Strong P1 |
| G22 | **Model-choice eval lab** | Model routing based on benchmarks not private repos | Run comparable local tasks across allowed models with cost/time/review metrics; informed default | Cost/engineering research | Research P2 |
| G23 | **Private by design** | Observability may leak source/secrets | Local-only default; scoped export; redact logs; outbound approvals with audit | Standard security baseline | Enabler P0 |
| G24 | **Handoff contracts** | Agents lose task state between sessions | Machine-readable baton: goal, commit, deltas, tests, constraints, risks, next step | Improves existing session resume | Strong P1 |

### Gaps we are **not** claiming as new

Agent teams; multi-model access; plugins and MCP; Docker sandboxes; Git worktrees; session checkpointing; plan/act; skills, memory and skill proposals; repo symbol maps; scheduling; code review and general automated test execution. All are present in at least one surveyed product. For them, use upstream SDKs and adapters and compete on **reliability of the full task lifecycle**.

## 4. Proposed differentiating workflows

### Workflow A — verified bug fix

1. Parse an issue into `TaskContract` with acceptance criteria **and negative requirements**.
2. Record Git HEAD, dirty state, immutable input files/test manifest and environment fingerprints; do **not** overwrite user work.
3. Retrieve code/test context with provenance and candidate impact map.
4. Ask for only a material ambiguity that blocks safe success; otherwise proceed with explicit assumptions.
5. Build smallest scoped patch, using bounded tool permissions.
6. Run prescribed tests against candidate; compare test integrity to baseline; block suspicious weakening.
7. For medium/high-risk work, run independent checks with separate checker instructions and environment; do not merely reuse author-written tests.
8. Emit `ProofPack`: exact code digest, criterion-to-check links, test outcomes, unknowns and security warnings.
9. Propose memory/skill candidates **only if evidence supports them**; user approves.

### Workflow B — unfamiliar codebase and refactor

1. Index symbols/imports and config at tracked commit; report what was actually scanned.
2. Build change-impact forecast: paths, exported interfaces, likely tests, consumers, config migration.
3. Define invariants (API backward compatibility, data migration and scope exclusions).
4. Execute on isolated worktree; demand explicit approval for schema/data destructive operations.
5. Verify old/new consumers and surface unresolved risk rather than claiming compatibility.

### Workflow C — multi-session engineering

1. Generate a reviewed baton after task stop: goal, current code refs, decisions, pending verification and risk register.
2. On next session compare base hashes, branch and upstream changes before applying baton.
3. Drop stale facts and expired assumptions; replan only affected tasks, not the full repo.
4. Run a small regression sample on the same feature over successive iterations and chart quality drift.

## 5. Priority ranking method

Scores 1–5; weights **user pain 30%, differentiation 25%, feasibility 20%, risk reduction 15%, ease of verification 10%**. Ratings are **team planning hypotheses**, not empirical measurements. Formula: 0.30P + 0.25D + 0.20F + 0.15R + 0.10V.

| Feature | Pain | Diff | Feas | Risk | Verify | Score / 5 | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| TestGuard | 5 | 4 | 4 | 5 | 5 | 4.55 | P0 |
| ProofPack | 5 | 4 | 4 | 4 | 5 | 4.40 | P0 |
| ScopeFence | 5 | 4 | 4 | 5 | 4 | 4.45 | P0 |
| IntentLock | 5 | 4 | 4 | 4 | 4 | 4.30 | P0 |
| TrustZones | 5 | 3 | 3 | 5 | 4 | 4.00 | P0 safety |
| Independent QA | 5 | 4 | 3 | 5 | 4 | 4.25 | P1 |
| ImpactMap | 4 | 5 | 3 | 3 | 4 | 3.90 | P1 |
| BudgetPilot | 4 | 3 | 5 | 3 | 5 | 3.90 | P1 |
| Failure Memory | 4 | 4 | 4 | 3 | 4 | 3.85 | P1 |
| Skill Trials | 4 | 5 | 3 | 4 | 3 | 3.95 | P1 |
| Context Provenance | 5 | 4 | 3 | 4 | 4 | 4.10 | P1 |
| Quality Drift Watch | 4 | 5 | 2 | 3 | 3 | 3.60 | P2 experiment |
| Replay Lab | 3 | 5 | 2 | 4 | 3 | 3.45 | P2 experiment |

**Do not sum priority scores into false precision**: product tests must update them.

## 6. Competitive and security threats

- **Feature convergence**: proprietary and OSS teams can add isolated features quickly. Defend through cohesive user workflow, extensibility and upstream-fork discipline.
- **Reviewer theater**: adding an LLM critic does not make it independent if it shares implementation assumptions, tool access or self-written tests. Separate author and verifier state, permissions, and test provenance.
- **Fake proof**: a manifest is not intrinsically trustworthy; it must match actual commands, repo hashes, artifacts and independent observations. Redaction cannot be used to disguise failed tests.
- **False security assurances**: prompt filters and approval dialogs are not reliable containment. Trust local Docker/OS isolation and least-privilege credentials, not model obedience.
- **“Deterministic” marketing**: cannot guarantee identical live LLM outputs or remote dependencies. Only claim reproducible **recorded simulation** and environment pinning.
- **Overbuilding**: do not make graph databases, browser automation, custom local LLM inference, desktop UI or full cloud execution mandatory for v0.1.
- **License and upstream drift**: verify exact current upstream source notices, copy only permissibly licensed code, document derivative status and keep changes in plugin or isolated packages where possible.

## 7. Suggested early validation research (before implementation)

1. **10 developer interviews**: 5 experienced multi-repo engineers and 5 OSS contributors. Ask for a failing task trace, not desired buttons.
2. **20-task baseline study**: five bug fixes, five refactors, five behavior changes, five untrusted-context tasks; all must have precommitted success oracles.
3. **2 × 2 test**: OpenCode baseline vs Bashwink controls, repeated with one economical and one stronger model; measure accepted patches, *human review minutes* and cost.
4. **Kill tests**: Does disabling IntentLock/TestGuard/ProofPack make outcomes worse? If not, simplify.
5. **Track revision**: A feature is not proven until user trial demonstrates lower rework or increased accepted changes; avoid marketing success from terminal screenshots.

## 8. Source ledger — reviewed 2026-11-22

Primary product docs: [OpenCode](https://opencode.ai/) · [OpenCode v2.3.0](https://opencode.ai/changelog/v2.3.0) · [Hermes](https://github.com/NousResearch/hermes-agent) · [Claude Code](https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more) · [Codex](https://openai.com/index/introducing-the-codex-app/) · [Cursor](https://cursor.com/help/ai-features/agent) · [Copilot Memory](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory) · [Gemini Auto Memory](https://geminicli.com/docs/cli/auto-memory/) · [Aider](https://aider.chat/docs/repomap.html) · [Cline](https://docs.cline.bot/core-workflows/task-management) · [OpenHands Verification](https://www.openhands.dev/blog/20260506-the-verification-stack).

Research and independent evaluation: [Misalignment paper](https://arxiv.org/abs/2605.29442) · [SlopCodeBench](https://arxiv.org/abs/2603.24755) · [SWE-Milestone](https://proceedings.mlr.press/v306/deng26d.html) · [SWE-Bench Pro](https://proceedings.mlr.press/v306/deng26f.html) · [OpenAI benchmarks audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/) · [Vercel evaluation](https://vercel.com/i/evaluating-ai-coding-agents) · [Agent Retrieval Bench](https://arxiv.org/abs/2607.24882) · [Chronicle](https://aclanthology.org/2026.realm-1.71/) · [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).

Security: [OWASP secure coding with AI](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html) · [OWASP agent security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) · [Microsoft agentic CI incident](https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/).

**Research caveat:** Citations support the stated capabilities and problem classes, not the proposition that our planned design has already been validated or that no competitor has implemented it. This is a design proposal; all new Bashwink features remain **unbuilt**.
