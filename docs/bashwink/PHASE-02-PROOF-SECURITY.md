# Phase 2 — Evidence-first safeguards

**Target:** v0.1 / standalone `v0.2.0-alpha.2` (`darwin-arm64`)
**Tasks:** 16
**Status:** **16/16 Done on `darwin-arm64`** (`ADR-018` / `ADR-019`); Phase 2 gate evaluated as **CONDITIONAL PASS (`darwin-arm64`)** — cross-platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `win32-x64`) and live paid-provider Phase 2 verification open.

## Objective

No unsupported “done” claims: preserve the requested intent, protect tests and scopes, and produce inspectable evidence.

## Implementation focus

Implement TaskContract/IntentLock, immutable baseline, TestGuard, ScopeFence, TrustZones, redaction, ProofPack, ClaimGuard, BudgetPilot and no-progress stop conditions; package the first alpha only after adversarial tests.

## Concrete deliverables

- [x] `bashwink contract new|show|edit|approve|reject|revise|status` + blocking assumption/question gate (`BW-055`, `BW-056`)

- [x] Baseline snapshots and protected test inventory (`BW-057`)

- [x] Tool-bound path enforcement (`BW-059`, `BW-018`), `TestGuard` (`BW-058`), and nonce-escaped `TrustZones` (`BW-066`)

- [x] Proof manifest (`BW-060`), `ClaimGuard` (`BW-061`), and terminal proof-of-work summary (`BW-017`)

- [x] `BudgetPilot` (`BW-075`), no-progress detector (`BW-076`), secret pipeline (`BW-067`), and 12/12 adversarial scenarios (`BW-084`)

- [x] Alpha quickstart, known-limits and security notes (`BW-020`)


## Release / exit gate

- [x] 12/12 initial fixed fixtures reach expected *states* under pinned test conditions (`darwin-arm64`, real PTY + loopback mock provider).

- [x] Zero false-verified receipts, unauthorized protected-test weakening, or canary leaks in the fixture suite.

- [x] Required unrun tests are `not_run`/`unverified`, never marked passed.

- [x] Untrusted repository text cannot obtain elevated tool permissions.

- [x] Alpha package installation works on advertised target environment (`darwin-arm64`; Linux/Windows/macOS Intel UNVERIFIED locally).


**Demonstration:** Ask agent to fix a bug → malicious test deletion attempt → denied → real tests executed → proof report with hashes; force cost cap to verify stop.

**Key risk / mitigation:** Guardrails placed only in prompts can be bypassed; enforcement must be below the model in actual file/shell tool boundaries.


## Ordered issue checklist

- [ ] **BW-017 — Build proof-of-work terminal summary** (P0, M)

- [ ] **BW-018 — Protect permissions and command execution paths** (P0, L)

- [x] **BW-055 — TaskContract schema, migrations and criterion lifecycle** (P0, M) — Done, local **and hosted** CI evidence

- [ ] **BW-056 — IntentLock command and confirmation UX** (P0, M)

- [ ] **BW-057 — Immutable baseline and protected test inventory** (P0, M)

- [ ] **BW-058 — TestGuard policy and integrity diff** (P0, L)

- [x] **BW-059 — ScopeFence tool-bound edit/command policy** (P0, M) — **Done**: enforced at `execute.before`; traversal, absolute and symlink escapes refused; denials recorded.

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
- [x] CI verification — 13/13 jobs green at `c731ab6` ([run 45151661558](https://github.com/ALDRIN121/bashwink/actions/runs/45151661558)), including the contract fixture on both platforms


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


- [x] Implement BW-059
- [x] Run success and negative-path checks
- [x] Attach verifiable evidence and update issue status

**Result.** `packages/bw-evidence/src/scope.ts`, wired into the plugin's `execute.before`
hook — the one tool hook whose failure rejects the call before the tool body runs. The policy
is written per run by the wrapper from the approved contract, and read once at plugin setup so a
mid-run write cannot change its own fence.

| Attack | Outcome |
| --- | --- |
| Write `../bw-scope-outside/pwned.txt` | refused; file absent |
| Write `/tmp/bw-scope-outside/absolute.txt` | refused; file absent |
| Symlink `link -> /etc`, write `link/passwd` | refused (containment decided on `realpath`) |
| Shell `workdir` outside the readable roots | refused |
| Shell argument naming an outside path | refused |
| In-scope edit of `src/calc.py` | applied; tests pass |
| Edit of the test file (outside `allowedPaths`) | refused; file hash unchanged |

Live model, `fixtures/scope-fence/run.sh` **10/10**. Unit controls:
`packages/bw-evidence/test/scope.test.ts` (23 tests).

**Limits, stated rather than implied.** A permitted shell command can still write anywhere an
interpreter can reach; only obvious path arguments and the working directory are checked, and
every permitted shell call is recorded as `unconstrained`. Workspace trust is enforced through
the same hook: an untrusted workspace refuses all writes and shell, which is what `doctor` had
always claimed but nothing previously enforced.


### 07b. BW-091 — Provider configuration, model selection and evidence attribution

**Priority / effort:** P0 / L  
**Dependencies:** BW-015, BW-055  
**Area/owner:** Core  
**Source:** v2

**Work package**

Make Bashwink capable of connecting to, selecting between and switching real LLMs, and record
which model produced each piece of work, without adding a second inference engine.

**Acceptance check**

A provider can be configured without persisting a key; models can be listed, selected and
switched mid-session; every tool entry names the model that served it or states that none was
reported.

- [x] Implement BW-091
- [x] Run success and negative-path checks
- [x] Attach verifiable evidence and update issue status

**Result.** `providers.ts` and `providers-cli.ts` (`auth add|status|check|remove`,
`model list|use|current`), plus model attribution in the evidence plugin. Inference, streaming
and tool calls remain the pinned runtime's.

Key properties, each bought with a reproduced failure:

- A literal key is refused (`--key`); `--env` and `--key-file` are the routes, and no key value
  appears in any file after a real run.
- Wire protocol is per model: a provider-level `package` applies to every model and fails at the
  first request on a mixed provider.
- Attribution comes from the runtime's `session.step.started` / `session.model.selected` events,
  per session, and is never backfilled from the configured default. A switch is its own chain
  entry.
- A missing credential is named before the runtime starts, instead of surfacing as
  `Invalid 'Authorization' header or token`.

Evidence: `docs/bashwink/LLM_INTEGRATION_AUDIT.md`; matrix and live results in
`TEST_EVIDENCE.md`. **Not claimed:** a second independently credentialed provider (blocked on
credit).


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
