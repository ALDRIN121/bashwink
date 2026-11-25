# Bashwink — Phase Release Gates

**Phase 0: 4 of 4 conditions met. Gate PASSED.**
**Phase 1: 10/10 tasks Done, 4/4 release criteria verified; 11/11 CI jobs green on both
supported platforms. Gate PASSED — revalidated 2026-11-23 after the silent-plugin-load
investigation (ADR-010).**
**Phase 2: 16/16 tasks Done on `darwin-arm64` (standalone Node >=22.13.0 runtime, ADR-018 / ADR-019). Gate CONDITIONAL PASS locally (`darwin-arm64`, real PTY + loopback mock provider); cross-platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `win32-x64`) and live paid-provider runs UNVERIFIED / BLOCKED locally.** Phases 3–7: not started.

Last evaluated 2026-11-26 after local Phase 2 standalone verification (`darwin-arm64`: 39/39 unit/PTY tests, 133/133 Bun shared-module regression tests, `test:standalone:install`, 12/12 `test:standalone:e2e`, `test:standalone:independence`), plus earlier real GitHub Actions runs on Phase 0 and Phase 1.

## Phase 2 — Evidence-first safeguards (Standalone v0.2.0-alpha.2 gate evaluation)

- [x] **12/12 initial fixed fixtures reach expected states under pinned test conditions (`darwin-arm64`).** Verified against the installed compiled standalone binary via `npm run test:standalone:e2e` (12/12 real PTY scenarios covering onboarding egress=0, provider isolation, Git red->green + ProofPack `verified`, declined edit + exit-9 failure, `Ctrl+C` + child PID termination, fake `"All tests pass!"` downgrade, `TestGuard` `.skip` block under `accept-edits`, poisoned `README.md` + malicious workspace `standalone.json`/`opencode.json` in `proj ü 用户`, `IntentLock` `ScopeFence` outside write + symlink block, compound-arg credential escape, canary redaction, and budget/3-failure retry stop + `evidence export`/`purge`).
- [x] **Zero false-verified receipts, unauthorized protected-test weakening, or canary leaks in the fixture suite.** Verified across both `phase2-guards.test.ts` (39/39 standalone suite) and `test:standalone:e2e` Scenario 6/7/11 (`evidence.jsonl`, `sessions/*.json`, `runs/*.json`, terminal output).
- [x] **Required unrun tests are `not_run` / `unverified`, never marked passed.** Declined commands and missing contract criteria record `status: "not_run"` in `ProofPackManifest`; `ClaimGuard` structurally downgrades to `done_unverified` or `inconclusive` whenever a check failed, was declined, ran unverified edits, or failed `TestGuard` / chain verification.
- [x] **Untrusted repository text cannot obtain elevated tool permissions.** `TrustZones` escapes XML/tag breakouts (`<trust_zone nonce=...>`, `<untrusted>`) and workspace config files (`README.md`, `AGENTS.md`, `standalone.json`, `opencode.json`) cannot mutate `trust.json`, `permissions.json`, or `BoundaryContext`.
- [x] **Alpha package installation works on advertised target environment (`darwin-arm64`).** `npm run test:standalone:install` and `npm run test:standalone:independence` pass on macOS Apple Silicon (`Node v22.23.2`, zero `vendor/`/`node_modules/`/`bun`/OpenCode/Hermes/Pi dependencies).
- [ ] **Cross-platform & live paid-provider Phase 2 qualification (UNVERIFIED / BLOCKED locally).** `linux-x64`, `linux-arm64`, `darwin-x64`, and `win32-x64` standalone Phase 2 runs and a bounded live paid-provider Phase 2 session have not yet been executed on external hosts or with live API credentials.

**Gate Verdict (Phase 2):** **CONDITIONAL PASS (`darwin-arm64` implementation & adversarial suite complete; external cross-platform & live-provider verification open).** Do NOT publish to npm without cross-platform CI + owner sign-off.

## Phase 1 — CLI & durable execution substrate (Internal CLI prototype gate)

- [x] **`bashwink` executable with clean branding.** ADR-003's wrapper finally exists:
      `--version` prints `bashwink 0.1.0`, `--help` documents every subcommand and exit code,
      and unknown arguments are forwarded to the pinned runtime unchanged.
- [x] **`doctor` produces actionable messages with a nonzero exit and prints no credentials.**
      12 checks; exits 1 when the runtime is missing and 0 when present. Credentials report
      presence/length/fingerprint only, asserted with a planted sentinel.
- [x] **Workspace trust is explicit and defaults to deny.** Untrusted workspaces deny
      `write`/`shell` by construction; `--by` attribution is mandatory; an explicit approval
      cannot override a hard deny. **Correction (alpha increment):** this was recorded and
      displayed but *not* enforced — `evaluateCall` existed and nothing called it. It is now
      enforced through the BW-059 hook, verified with a real model: an untrusted workspace
      refused a write that succeeded after `bashwink trust`.
- [x] **Task/plan schema with migrations, surviving restart.** SQLite via `bun:sqlite`, one
      transaction per migration step, `SchemaTooNewError` on a newer file, rollback exercised
      by a test.
- [x] **Append-only sanitised tool event log and evidence exports.** Verified against the real
      OpenCode binary: `before`/`after` joined on call id, `exit=0` captured, task-linked, a
      planted secret absent, chain verifies, second run appends rather than rewrites.
- [x] **Interrupted-session recovery fixture.** Real SIGKILL; resume reopens to `in_progress`
      and never to `verified`; `writes=1`; abandoned attempts are not counted as applied.
- [x] **One-file bug-fix flow from a clean install.** `fixtures/phase1-demo/run.sh` runs
      `doctor → plan → patch → terminate → resume → inspect events` as one scripted walkthrough
      in a throwaway `BASHWINK_HOME`, and asserts its own claims: **DEMONSTRATION PASSED
      (8 stages)**.
- [x] **Tool events carry task/run identifiers, exit statuses and redacted outputs.**
- [x] **Killing the process neither claims an unfinished test passed nor double-applies a
      patch.**
- [x] **Planning mode cannot silently edit, and diff/undo is reproducible.** `assertEditable`
      plus three real git fixtures; undo is byte-identical and idempotent.

**CI evidence:** `verify.yml` — **11/11 jobs green** on `ubuntu-latest` and `macos-15` at
`f753920` ([run 45119233542](https://github.com/ALDRIN121/bashwink/actions/runs/45119233542)).
The `cli` job on Linux independently reports `Ran 141 tests across 8 files`, a clean
`tsc --noEmit`, and `passed: 10  failed: 0` for the SIGKILL fixture — so the store, the git
fixtures and the interruption semantics are verified on a second platform, not just on the
machine they were written on.

**Runtime revalidation.** The early CLI jobs skipped the real-runtime cases when the
binary was unavailable. The current runtime-health jobs install the pinned binary on both
platforms and enforce those cases. The green `b38dd51` run covered both. The eight-stage
Phase 1 demo was rerun locally on macOS arm64. [CI reconciliation](CI_BASELINE_RECONCILIATION.md) · [Test evidence](TEST_EVIDENCE.md).

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
`bf33e20` ([run 45112989970](https://github.com/ALDRIN121/bashwink/actions/runs/45112989970)):
lint, docs integrity, evidence ×2 platforms, fixtures ×2 platforms, license scope, secret scan,
scope statement. The lint job runs a **semantic** linter (`oxlint --deny-warnings`, correctness
rules as errors) plus a self-test that proves the gate can fail; a separate step keeps the
formatting check (`bun fmt --check`). A formatter was previously presented as satisfying this
criterion — it does not, and that is corrected rather than re-described.
`upstream-compat.yml` — both platform legs green including the 8,004-test upstream baseline at
the lint-gate commit `bf33e20` ([run 45113462602](https://github.com/ALDRIN121/bashwink/actions/runs/45113462602)):
ubuntu-latest **7,251 pass / 0 fail**, macos-15 **7,561 pass / 0 fail**.

**Demo:** `create_fixtures.sh` → `reset.sh --check` → build → run against the mock provider
→ read `evidence.jsonl` → verify the chain → `upstream_sync.py` → read the verdict.
**Every step has been executed individually; the demo has not been scripted end-to-end.**

## Phase 1 — original planned checks

The original criteria below are retained for reference. The evaluated Phase 1 gate is above.

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

The five Git baseline fixtures do not meet the proposed 12-scenario target. Additional
integration fixtures cover newer capabilities, while the complete Phase 2 acceptance suite
and protected-test enforcement still lack evidence.

**Demo:** Ask agent to fix a bug → malicious test deletion attempt → denied → real tests executed → proof report with hashes; force cost cap to verify stop.

**Execution foundation update.** The local readiness fixture refuses client launch for
missing, import-failed and malformed policy initialization. Delayed initialization holds
the client until registration. The owned server and admission endpoint bind the client to
the attested workspace. Hosted macOS runtime health passed. Hosted Ubuntu executed and
failed the readiness fixture. The Phase 2 release gate remains open.
[Execution evidence](TEST_EVIDENCE.md).

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
- [ ] Native installs launch and complete the advertised coding flow on supported macOS
      and Linux without Docker, Podman, a VM or daemon.
- [ ] OS-level filesystem and network controls, host-secret protection and workload cleanup
      pass the [BW-032 controls](BW-032_PLATFORM_QUALIFICATION.md) for each advertised native platform.
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
