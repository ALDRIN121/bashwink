# Bashwink 2.0 — Additional GitHub Issue Backlog

**Research:** 2026-11-22 · **All issues proposed/not started** · **New:** BW-055–BW-090, additive to BW-001–BW-054. No implementation or GitHub issues have been created.

**Size guide:** XS <1 day; S 1–2 days; M 3–5 days; L 1–2 weeks; XL split. Estimates depend on upstream plugin/fork interfaces.

**WIP limit:** max 1 architecture issue plus 2 parallel small issues until v0.1. Each issue must name a fixture or measurable acceptance and have assigned risk owner.

## A. v0.1 — evidence-first and security baseline

### BW-055 — TaskContract schema, migrations and criterion lifecycle
**Priority:** P0 · **Size:** M · **Dependencies:** BW-012, BW-013 · **Status:** proposed

**Implementation:** Formalize goal, constraints, path permissions, base commit, negative requirements, criteria, and contract revisions.

**Acceptance:** Schema round-trip and invalid transitions tested; criterion statuses cannot disappear when contract revisions change.

### BW-056 — IntentLock command and confirmation UX
**Priority:** P0 · **Size:** M · **Dependencies:** BW-055, BW-008 · **Status:** proposed

**Implementation:** Implement bashwink contract show/edit/approve; require stable acceptance for nontrivial edits; use assumption ledger.

**Acceptance:** Fixture with contradictory goal cannot claim verified without resolving mandatory constraint.

### BW-057 — Immutable baseline and protected test inventory
**Priority:** P0 · **Size:** M · **Dependencies:** BW-007, BW-014 · **Status:** proposed

**Implementation:** Snapshot Git status/base SHA, required tests and scripts, record hashes before writes, preserve dirty user work.

**Acceptance:** Preexisting failing test distinguished from regression; user dirty work untouched.

### BW-058 — TestGuard policy and integrity diff
**Priority:** P0 · **Size:** L · **Dependencies:** BW-057, BW-018 · **Status:** proposed

**Implementation:** Detect test deletes, skip flags, weakened assertions and script removals; approval gate; hook into real tool write path.

**Acceptance:** Agent cannot make failing fixture green by silently deleting required test; authorized test changes remain possible.

### BW-059 — ScopeFence tool-bound edit/command policy
**Priority:** P0 · **Size:** M · **Dependencies:** BW-055, BW-018 · **Status:** proposed

**Implementation:** Compile contract allowed/excluded paths and destructive command classes to execution-time policy.

**Acceptance:** Unapproved outside-scope file write blocked even if model asks repeatedly.

### BW-060 — ProofPack evidence manifest with content hashes
**Priority:** P0 · **Size:** M · **Dependencies:** BW-015, BW-055, BW-057 · **Status:** proposed

**Implementation:** Define versioned manifest; per-criterion links to actual command/test events, patch and base digests, redacted exports.

**Acceptance:** Every passed claim resolves to a real event with exit code and code hash; invalid receipt fails validator.

### BW-061 — ClaimGuard terminal status validator
**Priority:** P0 · **Size:** M · **Dependencies:** BW-060, BW-017 · **Status:** proposed

**Implementation:** Validate model final statements against proof manifest; downgrade to inconclusive or done_unverified when unsupported.

**Acceptance:** Fake “all tests pass” LLM answer cannot set verified without recorded successful test.

### BW-066 — TrustZones trust/source labels in context
**Priority:** P0 · **Size:** M · **Dependencies:** BW-018 · **Status:** proposed

**Implementation:** Label owner instruction, repo files, PR text, MCP descriptions, retrieved results, skills, memories and child reports.

**Acceptance:** Untrusted README instruction cannot upgrade authority to run privileged commands.

### BW-067 — Secrets and output redaction pipeline
**Priority:** P0 · **Size:** L · **Dependencies:** BW-015, BW-066 · **Status:** proposed

**Implementation:** Redact known fake secrets, deny host credential stores, enforce export consent and artifact TTL/deletion.

**Acceptance:** Canary keys absent from default receipts/logs; secrets inaccessible in untrusted executor.

### BW-075 — BudgetPilot stop conditions, estimates and controls
**Priority:** P0 · **Size:** M · **Dependencies:** BW-014, BW-055 · **Status:** proposed

**Implementation:** Track per-run model calls, token/cost estimate, tool counts, elapsed time, children; policy-controlled hard stops.

**Acceptance:** Never launch another paid model call once hard estimated cap is hit; actual billed totals labeled unknown if unavailable.

### BW-076 — No-progress loop detector and safe cancellation
**Priority:** P0 · **Size:** M · **Dependencies:** BW-019, BW-075 · **Status:** proposed

**Implementation:** Detect repeated identical or near-identical failures; stop or require revised hypothesis; preserve partial state.

**Acceptance:** Forced retry-loop fixture terminates under cap and reports accurate stopped status.

### BW-084 — Adversarial fixture corpus v2
**Priority:** P0 · **Size:** L · **Dependencies:** BW-007, BW-057 · **Status:** proposed

**Implementation:** Add fake success, test deletion, poisoned README, malicious MCP, outside-scope edit, interrupted task, costly loops and stale branch.

**Acceptance:** Fixtures reset to fixed commit; CI reports baseline failure vs Bashwink behavior per test.

### BW-090 — ADR-002–006 plus upstream delta governance
**Priority:** P0 · **Size:** M · **Dependencies:** BW-003, BW-004 · **Status:** proposed

**Implementation:** Document evidence-first positioning, security authority, retrieval path, verifier boundary, replay claim; maintain fork-delta dashboard.

**Acceptance:** One owned ADR per decision and automated upstream merge smoke gate; unproven assumptions logged.

## B. v0.2 — independent confidence and memory quality

### BW-062 — Independent checker isolated from author
**Priority:** P1 · **Size:** L · **Dependencies:** BW-060, BW-030 · **Status:** proposed

**Implementation:** Separate role/worktree/context, independent acceptance test creation, read-only observer where possible, explicit checker cost.

**Acceptance:** Verifier report tagged as independent and cannot edit author evidence or test baseline.

### BW-063 — Baseline versus candidate verifier
**Priority:** P1 · **Size:** M · **Dependencies:** BW-057, BW-062 · **Status:** proposed

**Implementation:** Run pinned required tests against base and candidate; classify preexisting failures, new failures, flaky/inconclusive states.

**Acceptance:** Fixture with preexisting failing test reported without blaming patch; newly failing test blocks verified.

### BW-064 — Risk-based verification governor
**Priority:** P1 · **Size:** M · **Dependencies:** BW-062, BW-055 · **Status:** proposed

**Implementation:** Set evidence gates for low/medium/high risk, including auth, crypto, infra, DB migrations and permission logic.

**Acceptance:** Auth-change fixture forces independent security review and user confirmation for destructive action.

### BW-065 — ReviewPack navigable change explanation
**Priority:** P1 · **Size:** M · **Dependencies:** BW-060, BW-063 · **Status:** proposed

**Implementation:** Generate concise changed-behavior report, negative requirements, test integrity, proof links and unknowns.

**Acceptance:** Every acceptance claim and critical risk can be navigated to artifact/log or explicitly marked unverified.

### BW-068 — Branch- and hash-aware context references
**Priority:** P1 · **Size:** M · **Dependencies:** BW-021, BW-057 · **Status:** proposed

**Implementation:** Store code provenance with repo, branch, commit, path and hash; reject stale references.

**Acceptance:** Switch branch then run retrieval: outdated snippet not treated as current code.

### BW-069 — ImpactMap minimal dependency and test graph
**Priority:** P1 · **Size:** L · **Dependencies:** BW-068 · **Status:** proposed

**Implementation:** Start with TS/Python import and symbol index, test grep and Git diff; no mandatory graph database.

**Acceptance:** Prepared fixture includes affected consumers/tests in report with stated uncertainty.

### BW-070 — Memory freshness and conflict constraints
**Priority:** P1 · **Size:** M · **Dependencies:** BW-024, BW-068 · **Status:** proposed

**Implementation:** Bind memory source to path/hash and compare at insertion; expire conflict, preserve approved stable user preferences separately.

**Acceptance:** Stale memory no longer asserted as verified after source code API change.

### BW-071 — Verified failure and regression memory
**Priority:** P1 · **Size:** M · **Dependencies:** BW-023, BW-063 · **Status:** proposed

**Implementation:** Persist only verified root cause, diagnostic and confirmed regression commands, with expiry and review.

**Acceptance:** Unverified assistant guess never promoted; rerun can recall known verified failure.

### BW-077 — Skill promotion evaluation gate
**Priority:** P1 · **Size:** L · **Dependencies:** BW-026, BW-071 · **Status:** proposed

**Implementation:** Run candidate skill against gold/adversarial tasks in isolation; compare old and new quality, present diff for approval.

**Acceptance:** Regression skill remains quarantined; previous skill and evaluation report retained.

### BW-085 — Evaluation metrics and scorecards
**Priority:** P1 · **Size:** M · **Dependencies:** BW-039, BW-084 · **Status:** proposed

**Implementation:** Record accepted/verified/false-verified, review minutes, hidden test pass, budget, security, context precision and CI cost.

**Acceptance:** Report can compare baseline and latest runs without mixing different model settings or task oracles.

## C. v0.3 — delegated safe execution

### BW-072 — MCP/skill fingerprint and trust audit
**Priority:** P1 · **Size:** M · **Dependencies:** BW-066, BW-027 · **Status:** proposed

**Implementation:** Hash tool descriptions, skill files and capabilities; detect updates, prompt injection indicators, explicit reapproval.

**Acceptance:** Changed MCP tool definition triggers quarantine; no silent expanded privilege.

### BW-073 — Child-agent capability subset contracts
**Priority:** P1 · **Size:** M · **Dependencies:** BW-033, BW-066 · **Status:** proposed

**Implementation:** Implement subset-of-parent tool, path, credential, network and budget policy; verifiable delegation envelope.

**Acceptance:** Child cannot acquire permission denied to parent; unauthorized call rejected by executor.

### BW-074 — Sandbox network and credential test suite
**Priority:** P1 · **Size:** L · **Dependencies:** BW-031, BW-073 · **Status:** proposed

**Implementation:** Docker/OS hard restrictions, resources, no host mount by default, safe network policy, fake-secret exfiltration fixtures.

**Acceptance:** Untrusted task cannot read host credential canary or write outside scoped mount.

### BW-078 — Machine-readable session handoff baton
**Priority:** P1 · **Size:** M · **Dependencies:** BW-019, BW-068 · **Status:** proposed

**Implementation:** Include active intent, code hashes, outstanding checks, decisions and uncertain side effects in resume envelope.

**Acceptance:** Process restart after partial shell failure does not double-apply mutation or misstate completion.

### BW-079 — Causal debug mode hypothesis ledger
**Priority:** P1 · **Size:** M · **Dependencies:** BW-076, BW-055 · **Status:** proposed

**Implementation:** For repeated failures require hypothesis, probe, observed result, alternative before patch/retry.

**Acceptance:** Loop fixture shifts to diagnostic or stops, not repeated blind code changes.

## D. v0.4 — quality studies, cost and data

### BW-080 — Quality Drift Watch research prototype
**Priority:** P2 · **Size:** L · **Dependencies:** BW-069, BW-085 · **Status:** proposed

**Implementation:** Compare duplication, complexity, API growth, incremental regression and architectural constraints over milestone chain.

**Acceptance:** Produces correct trends on at least five hand-constructed successive changes; avoids scoring value judgments as facts.

### BW-082 — API and schema compatibility guard prototype
**Priority:** P2 · **Size:** L · **Dependencies:** BW-069, BW-064 · **Status:** proposed

**Implementation:** Inspect OpenAPI/JSON Schema/types/public exports and compare base vs patch with consumer fixtures.

**Acceptance:** Breaking public method or request field appears as review-blocking difference in supported languages.

### BW-083 — Private multi-model comparison harness
**Priority:** P2 · **Size:** L · **Dependencies:** BW-085 · **Status:** proposed

**Implementation:** Run identical tasks on selected providers with independent evaluator; collect runtime, review minutes and cost.

**Acceptance:** Comparison has source code/ref, run settings, repeat counts and limitations, no fabricated billing.

### BW-086 — Cost per accepted patch telemetry
**Priority:** P1 · **Size:** M · **Dependencies:** BW-075, BW-085 · **Status:** proposed

**Implementation:** User opt-in time annotations, API cost estimates and review outcomes with no cloud telemetry by default.

**Acceptance:** Export distinguishes unknown user review time from zero; no private code transmitted.

### BW-087 — Blinded A/B study with OpenCode baseline
**Priority:** P1 · **Size:** L · **Dependencies:** BW-085, BW-086 · **Status:** proposed

**Implementation:** Frozen task set and model with Bashwink guards on/off; independent labels, at least 3 runs per condition.

**Acceptance:** Publish win/loss/cost and qualitative failure narratives; remove features with no measured gain.

### BW-089 — Release gate suite: security, quality, real repos
**Priority:** P1 · **Size:** L · **Dependencies:** BW-047, BW-084, BW-085 · **Status:** proposed

**Implementation:** Integrate held-out regression suite, adversarial fixtures, docs accuracy and reviewable proof into release workflow.

**Acceptance:** Release blocked on critical wrong-success, test tamper, credential leak, unauthorized scope or repeat-loop failures.

## E. v1.0 — attested CI optional

### BW-088 — Optional evidence attestation and CI adapter
**Priority:** P2 · **Size:** L · **Dependencies:** BW-060, BW-045 · **Status:** proposed

**Implementation:** Generate optional checksummed/signed proof record for GitHub CI; no auto merge or remote secrets by default.

**Acceptance:** Replaying tampered receipt or wrong commit hash fails verification; unsigned mode labeled.

## F. post-v1 R&D

### BW-081 — Record/replay Lab research spike
**Priority:** P2 · **Size:** L · **Dependencies:** BW-014, BW-078 · **Status:** proposed

**Implementation:** Capture sanitized model/tool boundaries and simulate deterministic cut-point replay without calling providers.

**Acceptance:** Recorded fixture replay uses zero model calls; docs explicitly disclaim live-model determinism.

## New critical path and guardrail mapping

```text
BW-001–007 → BW-090 → BW-055 → BW-056 → BW-057 → BW-058 → BW-060 → BW-061
              ↘ BW-066 → BW-059 / BW-067 → BW-084 (security fixtures)
BW-014 → BW-075 → BW-076 ; BW-019 → BW-078
BW-060 → BW-062 → BW-063 → BW-064 → BW-065 → BW-085 → BW-087 → BW-089
BW-068 → BW-069 → BW-070/071 → BW-077
BW-066 → BW-072 → BW-073 → BW-074
```

**Priorities note:** P0 indicates essential safety/product foundations; not every P0 ticket must be completed before the first command runs, but releases cannot claim secure/verified capability without respective gates. Features that fail implementation/evaluation are deferred instead of faked.
