# Bashwink — Phase Release Gates

**Phase 0: 4 of 4 conditions met. Gate PASSED.**
Phases 1–7: unchecked, not started.

Last evaluated 2026-11-23 after real GitHub Actions runs on both supported platforms.

## Phase 0 — Foundation / fork feasibility (Foundation gate)

- [x] **Foundation can build on a clean supported machine.**
      Met on **two** hosted runner images now, not just this laptop. The upstream baseline
      runs green on `ubuntu-latest` (7,251 pass / 345 skip / **0 fail**) and `macos-15`
      (7,561 pass / 34 skip / **0 fail**) in
      [run 45066246923](https://github.com/ALDRIN121/bashwink/actions/runs/45066246923).
      Bashwink's own suites run on both in
      [run 45065505536](https://github.com/ALDRIN121/bashwink/actions/runs/45065505536).
- [x] **Baseline tests and at least one controlled tool call have recorded outcomes.**
      CI-executed, not only local: `47 pass / 0 fail` on ubuntu-latest and macos-15.
      **8,004 pass / 48 skip / 0 fail** with bash ≥ 4 (the 3 initial failures were the
      interpreter: the identical suite reports `7556 pass / 0 fail` under bash 5.3.20).
      Controlled tool calls captured three ways: success (`exit=0`), failure (`exit=7`,
      recorded as failure not success), and denial (command never ran).
- [x] **All required extension seams are demonstrated or core-fork limitations accepted.**
      Demonstrated live: `tool.hook("execute.before"/"execute.after")`, deny-by-throw,
      `ctx.location.directory`. Accepted limitations in ADR-002 (hook ordering is
      load-bearing) and ADR-003 (no branding seam → wrapper CLI). Source-verified but not
      exercised: `event.subscribe`, `permission.hook("evaluate")`.
- [x] **No unresolved distribution-blocking license or branding concerns.**
      **MET** — resolved by ADR-009, not by reinterpretation. Two models are defined: PM-0
      (publish the plugin only; no native code redistributed, zero FFmpeg exposure) and PM-1
      (bundle a binary built from pinned OpenTUI `v0.8.4` **without FFmpeg**, verified to
      build, load, pass the ABI check and render the TUI, with 796 FFmpeg symbols reduced to
      0 genuine ones). `scripts/generate_notices.py` emits a real notices bundle per model and
      fails if a license file is missing. Licensing release gate:
      `check_license_scope.py --fail-on-open` → exit 0, no release blockers.
      Residual: the no-FFmpeg library is not byte-reproducible (Zig embeds build paths), and
      counsel review is still advisable — neither blocks the gate. See
      `LICENSING_DETERMINATION.md`.

**CI evidence:** `verify.yml` — **9/9 jobs** green on ubuntu-latest and macos-15 at commit
`c536466` ([run 45111515216](https://github.com/ALDRIN121/bashwink/actions/runs/45111515216)):
lint, docs integrity, evidence ×2 platforms, fixtures ×2 platforms, license scope, secret scan,
scope statement. The ninth job is the **root lint gate**, which BW-006's acceptance named and
which did not exist until it was added — a "Done" task with a genuinely unmet criterion.
`upstream-compat.yml` — both platform legs green including the 8,004-test upstream baseline.
All runs are on commits `9b95d37` and `0b09620`; links in `TEST_EVIDENCE.md`.

**Demo:** `create_fixtures.sh` → `reset.sh --check` → build → run against the mock provider
→ read `evidence.jsonl` → verify the chain → `upstream_sync.py` → read the verdict.
**Every step has been executed individually; the demo has not been scripted end-to-end.**

## Phase 1 — CLI & durable execution substrate (Internal CLI prototype)

- [ ] Run the one-file bug-fix fixture from a clean install.
- [ ] Tool events have task/run identifiers, exit statuses and redacted outputs.
- [ ] Killing the process does not claim an unfinished test passed or double-apply a patch.
- [ ] Planning mode cannot silently perform edits and the Git diff/undo flow is reproducible.

**Blocker before starting:** the wrapper CLI does not exist; evidence entries carry call and
session IDs but no task/run taxonomy.

**Demo:** `bashwink doctor` → plan → code patch → terminate mid-check → resume → inspect events.

## Phase 2 — Evidence-first safeguards (v0.1 alpha gate)

- [ ] 12/12 initial fixed fixtures reach expected *states* under pinned test conditions (proposed target).
- [ ] Zero false-verified receipts, unauthorized protected-test weakening, or canary leaks in the fixture suite.
- [ ] Required unrun tests are `not_run`/`unverified`, never marked passed.
- [ ] Untrusted repository text cannot obtain elevated tool permissions.
- [ ] Alpha package installation works on advertised target environment.

**Only 5 fixtures exist, not 12.** Test-integrity enforcement (refusing to weaken a test) is
not implemented — the `failed-test` fixture only demonstrates the risk, it does not prevent it.

**Demo:** Ask agent to fix a bug → malicious test deletion attempt → denied → real tests executed → proof report with hashes; force cost cap to verify stop.

## Phase 3 — Project brain & independent QA (v0.2 gate)

- [ ] A stale memory is rejected/flagged after a branch/source change.
- [ ] Verifier cannot silently modify author evidence or protected baseline.
- [ ] Preexisting test failures are distinguished from newly introduced regressions.
- [ ] Unverified memory/skills never become trusted automatically.
- [ ] ImpactMap results disclose uncovered dependencies and uncertainty.

Not started. The hash-chained log gives a baseline for "verifier cannot modify evidence".

**Demo:** Session A fixes issue and proposes memory → approve → change branch/API → Session B flags stale note → independent QA compares tests.

## Phase 4 — Isolated execution & multi-agent coordination (v0.3 gate)

- [ ] Two independent tasks complete in isolated worktrees with distinct evidence.
- [ ] Conflicting patches cannot silently overwrite user work.
- [ ] Child cannot acquire parent-denied privileges.
- [ ] Network/host secret canary exfiltration fixtures are blocked in stated sandbox threat model.
- [ ] The integrated checkout is freshly tested after explicit merge approval.

**Known gap that will block this phase:** the evidence recorder has no concurrency control;
two processes appending to one log would interleave (ADR-004).

**Demo:** Parallel docs+code task → two isolated changes → conflict or clean merge preview → approve → integration tests → consolidated ProofPack.

## Phase 5 — Benchmarks, measurement & product validation (v0.4 gate)

- [ ] Publish results with denominators, model/commit, run settings and failures.
- [ ] False-verified results and test-integrity events are reported separately from task success.
- [ ] A/B report includes human review minutes when observed and clearly labels missing data.
- [ ] Defer speculative features if no measurable gain versus implementation/maintenance cost.

**Demo:** Run selected frozen fixture suite on OpenCode and Bashwink; compare accepted patch rate, false claims, review time, cost.

## Phase 6 — Security hardening & stable open-source release (v1.0 release gate)

- [ ] No unresolved critical/high security bugs in defined fixture scope.
- [ ] Reproducible installation, upgrades, migration and rollback path on supported systems.
- [ ] Every advertised core capability has a passing test or transparent limitation.
- [ ] Release tag maps to the published source and downloadable artifact hashes.

**Queued here by ADR-004:** entry signing (deferred key management).

**Demo:** Clean install → onboarding → scoped fix → proof+QA → export → upgrade/migrate → verify source and artifact hashes.

## Phase 7 — Post-v1 experiments & integrations (Optional; independently gated)

- [ ] Prove a distinct user benefit and defined security boundary before public enablement.
- [ ] Avoid duplicating upstream UX or adding always-on services without demand.
- [ ] Each experimental capability has opt-out/deletion and failure-path tests.

**Demo:** Optional plugin or flagged feature prototype with supported rollback and test report.
