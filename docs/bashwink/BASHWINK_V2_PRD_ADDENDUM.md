# Bashwink 2.0 — Product Requirements Addendum

**Date:** 2026-11-22 · **Status:** proposed, not implemented · **Supersedes:** prior definition of differentiators and release gates in `BASHWINK_PRODUCT_REQUIREMENTS.md`; preserves original FR-001–FR-049 and BW-001–BW-054 unless revised here.

## A. Product thesis and hard choices

**One-liner:** *Bashwink builds code you can inspect, verify, and trust.*  
**Core loop:** IntentLock → Context Provenance/ImpactMap → bounded implementer → TestGuard → independent verification → ProofPack → approved learning.  
**Foundation:** shallow OpenCode fork or plugin-first adaptation, decision gated by BW-003 and BW-004. Hermes is conceptual reference for learning and runtimes, not a second engine to merge.  
**No gold-plating:** no IDE clone, no proprietary model, no multi-provider gateway from scratch, no full graph DB, no automatic production deployment in initial releases.

**Non-negotiable:** A model's text does not confer task success. The state `verified` requires programmatically checked evidence against precommitted criteria. Statuses include `done_unverified`, `verified`, `blocked`, `failed` and `inconclusive`; never conflate them. A passed test is evidence, not proof of total correctness.

## B. Revised personas and journeys

**Professional developer:** Wants to modify mature repo without breaking unrelated behavior. Start from real Git branch, existing tests, architecture conventions and required security policy.

**OSS maintainer:** Wants reviewable candidate PRs with accurate change summaries and regression integrity; no claims of completed review based solely on generated comments.

**Cost-conscious individual:** Wants BYOK, spending ceiling, no cloud dependency and tangible cost per accepted change.

**Maintainer operating multiple agents:** Needs worktree isolation, per-agent budgets, provenance and handoff contracts, with all child agents inheriting or narrowing parent permissions.

## C. New functional requirements (FR-050–FR-083)

| ID | Priority | Requirement | Measurable acceptance |
|---|---|---|---|
| FR-050 | P0 | **TaskContract** stores goal, user constraints, explicit exclusions, assumptions, risks, criteria and required checks | Schema validates; `bashwink contract show` renders all criteria with stable IDs |
| FR-051 | P0 | **IntentLock** requires acceptance criteria before nontrivial material edits | No `verified` state with unclassified mandatory criterion |
| FR-052 | P0 | **ScopeFence** enforces allowed work paths and banned operations | Negative fixture shows non-approved outside-scope edit rejected at tool boundary |
| FR-053 | P0 | **TestGuard baseline** records test scripts, filenames and immutable base ref before changes | Baseline and changed test files shown as explicit diff |
| FR-054 | P0 | **Test-integrity approval** blocks deleted, skipped or weakened existing required tests until reviewed | Adversarial fixture cannot greenwash by editing failing test |
| FR-055 | P0 | **ProofPack v1** links code digest, criteria, test evidence, status and unverified claims | JSON passes schema + receipt links to existing real tool events |
| FR-056 | P0 | **ClaimGuard** prevents assistant narrative from marking unexecuted checks as passed | Synthetic fake-positive answer remains `inconclusive` |
| FR-057 | P0 | **TrustZones** classify user instructions, repository context, external issue/PR, MCP, memory and skills | External repo text never silently receives permission to perform privileged action |
| FR-058 | P0 | **Private default**: sanitize secrets in events, logs, receipts and crash reports | Fake secret never appears in default persisted/ejected artifacts |
| FR-059 | P0 | **Risk profiles** `observe`, `edit`, `verify`, `high-risk` with explicit default scopes | Tool tests show denied network, secret and destructive access by default |
| FR-060 | P1 | **Independent verify lane** runs evaluator separate from author with fresh state and precommitted oracle | Test owned by separate verifier; report distinguishes checker from implementation output |
| FR-061 | P1 | **Baseline-vs-candidate execution** compares required checks before/after change | Regression label records pre-existing failing test vs newly introduced failure |
| FR-062 | P1 | **ImpactMap v1** from Git diff, import/call graph, manifest and test reference search | For prepared fixtures, affected tests and exported functions are identified; coverage reported |
| FR-063 | P1 | **Context provenance** attaches repo/branch/commit/path/source hash to critical snippets | Stale retrieved context is rejected or clearly marked stale after branch switch |
| FR-064 | P1 | **Freshness-aware memory** invalidates/flags source-dependent memory after content change | Same memory no longer inserted as verified on conflicting source revision |
| FR-065 | P1 | **Failure Memory** saves evidence-based root cause and regression command | Unsubstantiated assistant opinions never auto-promoted |
| FR-066 | P1 | **Skill Trials** gate promotion of learned skill on fixture suite and explicit approval | Candidate with regressions remains rejected; old skill preserved |
| FR-067 | P1 | **BudgetPilot** caps estimated USD, tokens, turns, tools, elapsed time, children per task | Bounded job terminates safely before new paid requests past hard limit |
| FR-068 | P1 | **Loop watchdog** detects repeated no-progress commands and retries | Failure fixture stops and reports block reason before configured retry ceiling |
| FR-069 | P1 | **Handoff baton** is branch- and tool-state-aware after interruption | Resume checks commit and dirty state; never blindly replay uncertain mutation |
| FR-070 | P1 | **ReviewPack** gives minimal meaningful diff, tests changed, risks, unverified criteria | Human can navigate every claim to evidence ID |
| FR-071 | P1 | **Risk-adaptive QA policy** escalates auth/crypto/database/infra changes to stricter checks | Security-sensitive fixture can't bypass required independent gate |
| FR-072 | P1 | **MCP and skill provenance audit** records fingerprints and warns on tool definition changes | Modified tool description triggers reapproval or quarantine |
| FR-073 | P1 | **Scoped child-agent access** inherits subset of parent's permissions and budget | Child cannot acquire parent-excluded tool or secret |
| FR-074 | P1 | **Causal debugging mode** requires hypothesis, experiment and observation before retry | Sample loop yields testable cause rather than repeating same patch |
| FR-075 | P1 | **Negative requirements** captured and checked, including files/APIs not to change | Contract shows invariant-specific check and outcome |
| FR-076 | P1 | **Cost per accepted patch metrics** track spend, tool steps, review corrections, accepted/rejected outcome | Export reports unknown review time honestly and doesn't silently count it zero |
| FR-077 | P1 | **Evaluation suite** versioned and deterministic where possible, held-out checks and blinded baseline | Each run stores model, prompt, repo ref, flags, cost and seed where supported |
| FR-078 | P1 | **Task-change approval** when scope/assumptions materially expand | Revised contract is versioned; old criteria remain reviewable |
| FR-079 | P2 | **Quality Drift Watch** measures complexity, duplication and architecture erosion longitudinally | Metrics show trend over 5+ synthetic milestone changes with caveats |
| FR-080 | P2 | **Replay Lab** simulates saved model/tool boundary responses for debugging | Fixture replay produces identical *recorded simulation* events without live model calls |
| FR-081 | P2 | **API contract diff** checks versioned external behavior, schemas, CLI flags and exported modules | Breaking change fixture surfaces consumer impact and policy gate |
| FR-082 | P2 | **Multi-model private-repo comparison** evaluates same tasks, bounded cost and independent grader | Results report score + cost + confidence and sample limitations |
| FR-083 | P2 | **Optional signed attestations** associate evidence manifest and commit digest | Invalid signature or mismatched code hash is rejected; unsigned remains clearly labeled |

## D. Architecture changes

```text
                           Bashwink CLI / TUI / SDK
                                    |
             TaskContract + IntentLock + Revision Ledger
                                    |
        Context Gateway --- ImpactMap --- Provenance + freshness
                                    |
             Policy Engine: scope | trust | budget | risk
                                    |
             OpenCode-derived editing/orchestration core
                                    |
                Worktree + Executor (local/Docker)
                                    |
             TestGuard / Existing checks / New checks
                         |                     |
               Author evidence       Independent QA lane
                         |                     |
                         +---- Verification Governor ----+
                                          |
                               ProofPack + ReviewPack
                                          |
                          Approved Memory / Skill Trials
```

**Boundaries:** `TaskContract` is the source of truth for acceptance; `PolicyEngine` guards **actual tool invocation**; `EvidenceStore` records execution results rather than prose; `Verifier` cannot update the task's success claims by simply asserting them. If upstream doesn't expose necessary tool events/permissions, S0 must choose a narrow core patch with explicit compatibility tests.

### Core domain objects

```json
{
  "TaskContract": {
    "id": "task-123", "revision": 1, "baseCommit": "<sha>",
    "goal": "Fix failure without changing public API",
    "allowedPaths": ["src/**", "tests/**"],
    "excludedPaths": ["infra/prod/**"],
    "invariants": [{"id":"INV-1","kind":"api_unchanged"}],
    "criteria": [{"id":"AC-1","oracle":"pytest tests/test_case.py","required":true}],
    "assumptions": [], "approval": "user|policy"
  },
  "EvidenceEvent": {
    "id":"ev-001", "taskId":"task-123", "criterionId":"AC-1",
    "kind":"test", "actor":"verifier", "command":"pytest tests/test_case.py",
    "exitCode":0, "elapsedMs":1200, "repoCommit":"<sha>",
    "environmentHash":"<sha>", "redacted":true
  },
  "ProofPack": {
    "schemaVersion":1,"taskId":"task-123", "patchHash":"<sha>",
    "evidenceRefs":["ev-001"], "claims":[{"criterion":"AC-1","status":"passed","evidence":"ev-001"}],
    "overall":"verified|inconclusive|failed|blocked"
  }
}
```

All identifiers, commands, schemas and CLI syntax above are **proposals**, not claims of existing Bashwink APIs.

### Safety requirements beyond a warning dialog

1. Parent and child agents operate under kernel-enforced sandbox or Docker/VM controls for untrusted work. Tool approval prompts are *not* an isolation boundary.
2. Never place unscoped production cloud credentials inside executors. Secrets are short-lived, mock during tests, and not inherited by default.
3. Repository `AGENTS.md`, `CLAUDE.md`, README, issues, PR descriptions, skills and MCP metadata are lower-trust input relative to owner-configured policy.
4. Separate knowledge from authority: the agent may read a malicious README to fix the software but its embedded instructions cannot authorize shell, network or secret access.
5. Policy changes are logged, user- or org-approved, and cannot be forged via tool output or subagent response.
6. Export only redacted evidence by default; user explicitly opts into sensitive artifact export.

## E. Updated release stages — incorporate without blocking the first product

| Stage | Previous scope | Required v2 additions | Exit gate |
|---|---|---|---|
| **S0 Architecture** | BW-001–007 | Freeze v2 TaskContract/tool boundary feasibility; benchmark baseline | OpenCode fork/platform proof, reproducible reference run |
| **v0.1 Alpha — proof-first CLI** | BW-008–020 | BW-055–061, BW-066–067, BW-075–076, BW-084, BW-090 (narrow implement) | Scoped fix and clean evidence; fake-success and test-deletion fixture blocked |
| **v0.2 Beta — confidence** | BW-021–029 | BW-062–065, BW-068–071, BW-077, BW-085 | Independent QA, branch provenance, approved learning, budget stops |
| **v0.3 Safety & delegation** | BW-030–038 | BW-072–074, BW-078–079 | Docker worker + scoped child and MCP policies; two-agent integration safe |
| **v0.4 Quality / measurement** | Selected BW-039–048 | BW-080, BW-082–083, BW-086–087, BW-089 | Real repository trials, regression metrics, blinded comparisons |
| **v1.0 Stable** | Remaining BW-039–048 | BW-088 plus release-critical failures | Stable package, reproducible proof, privacy and security hard gate |
| **Post-v1 R&D** | BW-049–054 | BW-081, optional BW-083 deepening and advanced graph/replay | Only if instrumentation shows material user benefit |

**Release philosophy:** Do not require every advanced feature to ship together; P2 may never ship. Every new v2 stage gate is provisional until S0 has mapped exact upstream APIs.

## F. Hard pass / failure states

| State | Allowed condition | Prohibited misrepresentation |
|---|---|---|
| `verified` | Every required criterion has evidence from suitable checker, test integrity passes, safety rules complied | Model says 'done' without event |
| `done_unverified` | Patch exists but tests missing / QA not available | Display as successful verified change |
| `inconclusive` | Conflicting or incomplete evidence | Quietly assume success |
| `blocked` | Permission / resource / budget / essential requirement prevents continuation | Repeat until hard limit exceeded |
| `failed` | Required tests or invariants demonstrably fail | Rewrite/skip tests without explicit approval |

## G. Risk register v2

- **Too much per-task overhead:** Make low-risk test selection cheap and make QA depth proportional to risk, while maintaining essential guards.
- **Verifier correlated with author:** Different instructions alone are insufficient; baseline regression tests and independently owned oracles are stronger evidence.
- **Wrong impact map:** Display exact files indexed, confidence and unknown dependencies; never assert completeness for dynamic languages.
- **Memory poisoning:** Source provenance and manual/controlled promotion; no automatic elevation to policy.
- **Tool injection:** Lower-trust content never changes tool permission or network egress authority.
- **Evidence leakage:** Redaction, manifest hash and explicit export scopes.
- **Fork maintenance:** Prefer composable extensions; keep fork delta documented and rerun upgrade tests against new OpenCode releases.

## H. Product success measures

**Primary metric:** Human-accepted, independently verified patches **per engineer-hour**, including review and rework, on a defined task set.  
**Guardrail metrics:** false-verified rate, unapproved edit attempts that succeed, secret leaks, deletion/weakening of required tests, regressions on hidden checks, exceeded hard budgets.  
**Experience:** median review time, p95 task overhead, cost per accepted patch, number of user interventions, meaningful model-switching clarity.  
**Technical:** CI fixture pass rate, context hit/ripple recall@k, accurate stale-source detection, crash recovery fidelity, artifact digest checks.  
**Not success metrics:** LOC generated, number of subagents, token volume, raw SWE-bench rank, number of memories stored.

## I. Decision record

**ADR-002 proposal:** Adopt "evidence-first engineering completion" as positioning and shipping contract.  
**ADR-003 proposal:** Use task-bound tool policy and redacted evidence event store rather than trusting model statements.  
**ADR-004 proposal:** Start with lexical/LSP/AST indexing; only prototype embeddings or graph DB if benchmarks demonstrate gain.  
**ADR-005 proposal:** Verification is pluggable and risk-weighted; high-risk oracles must be structurally separate from author-generated tests.  
**ADR-006 proposal:** Keep model replay separate from real-world test reproducibility; never promise perfect determinism.

**References:** See `COMPETITIVE_GAP_RESEARCH.md`, linked official docs and research ledger; source claims apply to a snapshot as of 2026-11-22.
