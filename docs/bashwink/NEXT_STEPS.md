# Bashwink — Next Steps

**Where we are:** **Phase 0 and Phase 1 are complete and gate-passed.** Phase 1 was
**revalidated** after the silent-plugin-load investigation (ADR-010). **Phase 2 has started:**
BW-055 (TaskContract / IntentLock data plane) is Done; 1 of 15 Phase 2 tasks. **Phase 2's gate
has not been evaluated**, and Phase 3 has not been started.

- 20/90 tasks Done, 70 Not started, nothing Blocked.
- **335 tests** pass; lint, formatting and typecheck are clean under the pinned Bun 1.4.4.
- **Real-model execution is now proven end to end** (BW-091, not a register task): a paid
  provider configured without storing a key, model selection and switching across two wire
  protocols, real tool calls and file edits, tests run, and per-call model attribution in the
  evidence chain. One paid provider verified; a second independently credentialed provider is
  **BLOCKED** on credit.
- Runtime evidence: `fixtures/runtime-health` 17/17 and `fixtures/tool-lifecycle` 13/13
  against the real OpenCode v2.3.2 binary; `fixtures/contract` 14/14; the Phase 1 demo 8/8;
  the SIGKILL fixture 10/10.

## Next priority: the enforced boundary, not more features

The LLM integration works well enough to code against a real repository, which makes the
missing safety boundary the top risk: **`TaskContract.allowedPaths` is recorded but not
enforced (BW-059)**. A wrapper that measures what an agent did, accurately, while the agent can
write anywhere, is a good measurement tool and a poor safety story.

Recommended order:

1. **BW-059 ScopeFence** — enforce the contract's paths at the tool boundary. This is the
   alpha blocker, and it is also the cheapest of the P2 tasks to prove, because the contract
   data plane (BW-055) already exists and the tool hooks are already in place.
2. **BW-057/BW-058** — protected test inventory and TestGuard, so a passing suite cannot be
   achieved by editing the tests.
3. **BW-075 BudgetPilot** — cost and turn ceilings before anyone runs this unattended.
4. **BW-020** — packaged alpha, once the above justify distributing it.

Do not add fallback chains, model aliases, auxiliary models, or a second inference engine in
this window. Each multiplies the model-attribution surface, and nothing about the alpha needs
them.

## What changed in this increment

### 1. Evidence health is now proven, not assumed (Phase 1 revalidation)

Phase 1's risk list said the evidence plugin must be staged or nothing is recorded. The
reproduced failure was broader: **a plugin can stage successfully, fail to load, and leave a
green exit 0 over an empty log.** Three variants were reproduced against the pinned binary
(import throw, unresolvable entry, wrong export shape); the unresolvable-entry case logged
**nothing at all**. The wrapper equated the child's 0 with success, and the only fixture that
could catch the regression skipped in CI for want of the runtime.

Fixed by ADR-010:

- staging resolves the entry exactly as `Host.resolve` does and refuses what the runtime would
  silently drop;
- the plugin records a `boot` entry after its hooks are registered, keyed by run id;
- the wrapper writes an expectation record before the run, reconciles it after, and exits 3
  with a diagnosis when evidence is missing;
- `BASHWINK_EVIDENCE=off` is an explicit, recorded unverified mode;
- `bashwink evidence status` and `doctor` surface the failure after the fact;
- a new `runtime-health` CI job installs the pinned runtime on both platforms and runs the
  four-case fixture — the guarantee is now enforced in CI, not only on a laptop.

### 2. BW-055 — TaskContract / IntentLock data plane

- Schema v2: `contract`, `contract_revision`, `criterion`, `criterion_evidence`, with the
  documented rollback extended to both versions.
- Immutable, numbered revisions; a revision that omits a criterion marks it `dropped` with a
  reason and keeps its evidence; a dropped id cannot be re-added.
- Criteria are tied to a plan task + declared check. `plan observe` links the observation id
  and exit code to every matching criterion and moves its status. `passed` cannot be set
  without a passing observation.
- A content revision resets approval to `draft`.
- Once a contract exists, `plan task <id> in_progress` is refused unless it is approved, valid
  and covers that task.
- CLI: `contract new | show | approve | revise | status`.

## Phase 1 closed with CI evidence

| Workflow | Run | Commit | Result |
| --- | --- | --- | --- |
| `verify` | [45118931489](https://github.com/ALDRIN121/bashwink/actions/runs/45118931489) | `ee4652f` | **failure** — `cli` job, in the *workflow* not the code |
| `verify` | [45119233542](https://github.com/ALDRIN121/bashwink/actions/runs/45119233542) | `f753920` | **success — 11/11 jobs, both platforms** |
| `verify` | [45129207277](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277) | `ad9d44e` | **success — 11/11 jobs, both platforms, 0 failure annotations** |

Both failures were in the checks, not the product, and both are worth remembering:

- the first run's smoke step asserted `test -d "$BASHWINK_HOME"` after `--version`, which
  deliberately never touches the filesystem, and discarded `doctor`'s exit code with `|| true`
  — a check that ignored the thing it was testing;
- two later signals were green-but-red: a fixture job carried a failure annotation while every
  step exited 0, and every job ran on the deprecated Node 20 action shim.

The Linux leg settled three flagged risks: `bun:sqlite` behaviour, symlinked plugin staging,
and git subprocess differences (`git 2.56.1` vs Apple Git 2.54.0).

## Phase 1 — what was built

| Task | What was built |
| --- | --- |
| BW-008 | `bashwink` wrapper: own `--version`/`--help`, arg passthrough, `BASHWINK_HOME`, XDG isolation |
| BW-009 | `doctor`: checks with nonzero exit on a missing precondition, credential fingerprints only |
| BW-010 | Workspace trust: untrusted denies write/shell/network by construction; `--by` required |
| BW-011 | `assertEditable` edit gate + three real git fixtures for diff/undo/cancel |
| BW-012 | SQLite plan/task store: atomic migrations, schema-version refusal, exercised rollback |
| BW-013 | Plan contract + hand-written validator (cycles, unknown deps, approval attribution) |
| BW-014 | Tool lifecycle against the **real** runtime: joined `before`/`after`, `exit=0`, task-linked — revalidated under ADR-010 |
| BW-015 | Export keeping `pass`/`fail`/`not_run` distinct, plus md/json and a raw-result digest |
| BW-016 | `taskID` on every event from a durable marker; explicit `unassignedReason` otherwise |
| BW-019 | Real SIGKILL fixture: `writes=1`, resume reopens to `in_progress`, never `verified` |

## Next eligible Phase 2 tasks (dependency-checked against the register)

1. **BW-017 — proof-of-work terminal summary** (BW-015, BW-016 done). Must render `not_run`
   distinctly and make every claim resolve to a recorded event.
2. **BW-018 — protect permissions and command execution paths** (BW-010, BW-014 done).
   Compound commands, symlinks, denied paths; the adversarial half of the policy.
3. **BW-056 — IntentLock command and confirmation UX** (BW-008, BW-055 done). Interactive
   `contract edit`, assumption ledger, and the contradictory-goal fixture. BW-055 deliberately
   stopped at the data plane plus the commands approval/revision require.
4. **BW-057 — immutable baseline and protected test inventory** (BW-007, BW-014 done).
   Prerequisite for TestGuard (BW-058) and ProofPack (BW-060).

After those: BW-059 needs BW-018; BW-060 needs BW-057; BW-075 is unblocked now (BW-014 +
BW-055); BW-084 needs BW-057.

## Foundation hardening, in the order it should happen

These are prerequisites for the Phase 2 proof chain, not new tasks:

1. **Make SQLite authoritative over `current-plan.json`.** Two writers still exist; BW-060's
   manifest needs one source of truth for plan + criteria + observations.
2. **Drive `plan observe` from a real check runner.** Today the caller supplies the outcome.
   BW-017 and BW-060 need the CLI to execute the declared command and record the exit code
   itself, so "a check passed" is never a claim made by the party being checked.
3. **Publish a per-session evidence head hash** (ADR-007) so tail truncation becomes
   detectable; it belongs with BW-060's manifest.
4. **Concurrency-safe evidence recording** before Phase 4's parallel worktrees (ADR-004).
   `bun:sqlite` is a single-writer assumption today.

## Risks carried forward (none gate-blocking)

1. **Evidence health is a startup check.** A plugin that loads and then fails mid-session
   degrades the log from that point; the recorder reports it, but the boot entry cannot.
2. **The contract gates task start, not tool calls.** Until BW-059, a running agent can still
   write outside `allowedPaths`.
3. **Staged plugins are symlinks into this repository.** Fine for a working copy; a real
   distribution must copy or resolve them, and that is a PM-1 packaging question (ADR-009).
4. **No-FFmpeg native library is not byte-reproducible** (Zig embeds build paths). A PM-1
   release must assert a symbol profile, not a digest.
5. **No legal review.** ADR-009 removes known LGPL exposure by construction; it is not advice.
6. **`DEPENDENCY_LICENSES.json` is a snapshot** — `upstream_sync.py` does not regenerate it, so
   it must be refreshed whenever a dependency is added.
7. **`bun audit`** has never been run.
8. **The doctor's `docker` check only tests presence on `PATH`** — it does not verify the
   daemon answers.
9. **`upstream-compat` is weekly + manual**, deliberately: a 2.7 GB install and ~5 min suite
   per PR is too expensive.

## Housekeeping

- Remote: `https://github.com/ALDRIN121/bashwink`, branch `main`.
- The pinned OpenCode clone lives outside this repository, so ~2.7 GB of dependencies never
  enter Git.
- The 3 upstream bash-3.2 failures stay unpatched by design (BW-002). CI must have bash >= 4.
- The real OpenCode runtime is **not** a repository dependency. The `runtime-health` CI job
  installs it only for the case that needs it; locally, set `BASHWINK_OPENCODE_BIN`.
