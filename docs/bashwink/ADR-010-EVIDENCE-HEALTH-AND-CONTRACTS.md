# ADR-010 — Evidence health is proven, not assumed; the contract is a gate

**Status:** Accepted. Startup admission and the former optional mode were superseded by [ADR-012](ADR-012-PRIVATE-RUNTIME-READINESS.md).
**Date:** 2026-11-23
**Owner:** Aldrin Joseph
**Depends on:** ADR-002, ADR-004, ADR-007
**Evidence:** `fixtures/runtime-health/run.sh` (17/17), `fixtures/contract/run.sh` (14/14);
probe output reproduced below; `TEST_EVIDENCE.md` § "Phase 2 evidence"

## Context

Phase 1 closed with a known hazard, stated in `NEXT_STEPS.md`:

> The evidence plugin must be staged or nothing is recorded — and failing to stage it is
> silent. `main.ts` now calls `stagePlugins` before every runtime invocation, and the
> end-to-end fixture is the only thing that catches a regression here. Every unit test passed
> while the real runtime recorded nothing.

That is not a hypothetical. Re-running the failure against the pinned OpenCode v2.3.2 binary
produced three distinct silent outcomes:

| Staged plugin | Runtime exit | stderr | Evidence log | Only trace |
| --- | ---: | --- | --- | --- |
| entry throws at import | **0** | empty | empty | `WARN failed to load plugin` in `opencode.log` |
| directory with no resolvable entry | **0** | empty | empty | **none at all** |
| module with the wrong export shape | **0** | empty | empty | `WARN failed to load plugin` |

The runtime's plugin loader is deliberately non-fatal: a broken plugin must not kill an agent
session. That is a reasonable upstream choice. It becomes a product defect for Bashwink,
whose central claim is that tool activity is evidenced, because "the agent ran and recorded
nothing" is indistinguishable from "the agent ran and called no tools".

The second gap was coverage. The only fixture that exercised the real binary **skips in CI**
when the runtime is absent — so the pipeline could be green while nothing was ever loaded.

## Decision

**1. A run proves its own evidence health.**

- The plugin writes a `boot` entry to the hash-chained log *after* both tool hooks are
  registered. The entry id carries the wrapper-assigned `BASHWINK_RUN_ID`, so it cannot be
  confused with a previous process's boot record.
- Before spawning, the wrapper writes a durable expectation record under `<data>/runs/`
  naming the plugin, its resolved entry and the staging path.
- After the child exits, the wrapper verifies the chain and looks for this run's boot entry.
  If it is absent: it prints the run id, plugin entry, evidence path, runtime log path and the
  consequence ("this run is NOT verified"), and **exits 3** rather than passing the child's 0
  through.

**2. Staging resolves the entry exactly as the runtime will.** `resolvePluginEntry()`
implements the pinned `Host.resolve` rules: exports map when `name` + `exports` are present,
otherwise conventional root `server.*`/`index.*`, with containment enforced. A directory the
runtime would drop now fails *before* the process starts, with the rule that failed named.

**3. Optional mode is explicit.** `BASHWINK_EVIDENCE=off` clears staged plugins, announces
the run is unverified, and records `evidence: "disabled"`. Absence is never inferred from
silence; it is chosen or reported.

**4. CI installs the runtime in one dedicated job.** `runtime-health` runs on both platforms,
installs the pinned 225 MB package, and runs the four-case fixture. The expensive install is
confined to a job whose only purpose is the guarantee it buys.

**5. The TaskContract is a gate, not a document.** From BW-055:

- A contract is a versioned document with an objective, base commit, allow/forbid paths,
  negative requirements, constraints and acceptance criteria tied to declared task checks.
- Revisions are immutable snapshots. Criteria live in their own table and are **marked
  `dropped`, never deleted**, when a revision omits them. A dropped id cannot be re-added.
- A content revision resets approval to `draft`.
- An observation for a task + check automatically links to every matching criterion and moves
  its status. `passed` cannot be set manually without a passing observation.
- Once a contract exists for a plan, `plan task <id> in_progress` is refused unless the
  contract is approved, valid, and covers that task. A plan with no contract keeps Phase 1
  behaviour.

## Consequences

**What improves**

- A silent plugin failure is now a failed run with a diagnosis, not a successful run with an
  empty log. The failure is detectable by a script (`exit 3`), by `bashwink evidence status`,
  and by `bashwink doctor` (last-run check).
- The guarantee is enforced in CI on Linux and macOS, where it previously had no coverage.
- "Criterion X passed" resolves to an observation id; a dropped requirement keeps its status,
  reason and evidence.

**What this does not claim**

- The boot entry proves `setup()` completed; it does not prove a tool call happened. A session
  with no tool calls is legitimate and still recorded.
- Exit 3 is only meaningful when the wrapper is the entry point. Running the OpenCode binary
  directly bypasses all of this by design (ADR-003).
- A plugin that loads successfully and then fails to write an entry mid-session degrades the
  log from that point; the recorder reports degraded health and refuses to extend a tampered
  chain, but the boot entry alone cannot detect a later partial failure.
- The contract is not yet enforced at the file/shell tool boundary. That is BW-059
  (ScopeFence); BW-055 validates and gates *execution start*, not each write.
- The interactive edit UX and assumption ledger are BW-056. BW-055 ships the data plane,
  `show`, `approve`, `revise` and `status` because approval and revision are load-bearing for
  the acceptance criteria.
