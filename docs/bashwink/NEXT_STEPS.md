# Bashwink next steps

The baseline audit is complete at `4731eaf`. Phase 0 and Phase 1 retain their evidence-backed gates. Phase 2 is open with **3/16 Done** (BW-055, BW-059, BW-091). The canonical register has **22/91 Done**. Supervised internal alpha is **CONDITIONAL** on the documented baseline and trusted workspaces. External alpha is **FAIL** while an OS boundary and the outstanding Phase 2 gate evidence are absent. [State review](CURRENT_STATE_REVIEW.md) · [Internal alpha readiness](INTERNAL_ALPHA_READINESS.md).

## Next five engineering tasks

1. **BW-018 — Protect permissions and command execution paths.** Eligible in Phase 2. Include ScopeFence's missing-policy/disabled-plugin behavior, unknown execution surfaces and trust defaults in the review. BW-059 is recorded Done for its delivered hook even though BW-018 remains an unmet dependency.
2. **BW-030 — Execution backend interface.** After BW-018 and the applicable Phase 3 gate entry or an explicit sequencing decision. Prove policy-before-execution, cancellation and disposal with a mock backend. BW-014 is Done.
3. **BW-031 — Docker sandbox adapter.** After BW-030 and authorized Phase 4 sequencing. Implement in the order proposed by the reviewed plan. The design is ready for maintainer review. Sandbox execution is still Not started.
4. **BW-032 — Sandbox threat and adversarial tests.** After BW-031. Require real engine runs on Linux and macOS, including the default no-egress profile, startup refusal and descendant cleanup. BW-074 separately depends on BW-073 for delegated network/credential checks.
5. **BW-057 — Immutable baseline and protected test inventory.** Independently eligible in Phase 2 and can proceed before the later-phase slots. Pair its result with BW-018 to unblock BW-058. Verify a preexisting failure and preserve dirty user work.

BW-018 is the immediate eligible task on the sandbox path. BW-057 is the immediate eligible test-integrity task. The register also makes BW-017, BW-056 and BW-075 eligible for a future Phase 2 increment. BW-058 needs BW-018 and BW-057, BW-060 needs BW-057, and BW-020 needs BW-017 and BW-018. No implementation status changed in this audit.

Keep `macos-15` active and retain the green `b38dd51` baseline for this supervised window. Reconfirm changed runtime code on both platforms and use only executed hosted jobs as evidence. Continue host evidence hardening and real-command observations when working on BW-060/ClaimGuard. Carry the license inventory refresh, advisory scan, and distribution-specific checks into packaging. [CI reconciliation](CI_BASELINE_RECONCILIATION.md) · [Sandbox implementation plan](BW-031_IMPLEMENTATION_PLAN.md).

This handoff ends at audit, reconciliation and plan review. BW-031 implementation requires separate authorization.

## Phase 1 history

The following implementation and CI notes document the prior handoff.

### Phase 1 revalidation and the first Phase 2 increment

#### 1. Evidence health is now proven, not assumed (Phase 1 revalidation)

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

#### 2. BW-055 — TaskContract / IntentLock data plane

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

### Phase 1 closed with CI evidence

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

### Phase 1 implementation

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
