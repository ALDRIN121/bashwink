# Bashwink local engine migration implementation plan

> **For the coding agent:** Execute task by task using the repository workflow and the executing-plans skill if available. Start with Task 0. Record actual evidence before moving through a gate. This plan does not authorize pushing, merging, publishing, changing sharing, or distributing artifacts.

**Goal:** Build and run Bashwink's current coding workflows from the required, pinned upstream source committed inside Bashwink, with no OpenCode npm packages or separately installed runtime.

**Architecture:** Keep the branded launcher, private engine process, and Bashwink policy and evidence plugin. Import the needed upstream files under `vendor/engine/`, preserve their existing interfaces, and build a Bashwink-owned engine and terminal helper for each supported target.

**Tech stack:** TypeScript, Bun 1.4.4, Node.js 22 and npm, Python 3.12, pinned Cargo/Rust and Zig, OpenTUI, and GitHub Actions.

**Design:** `docs/superpowers/specs/2026-11-25-local-engine-design.md`. This plan repeats the build boundaries and gate conditions so it can travel as a standalone handoff.

**Repository:** `ALDRIN121/bashwink`. Reference baseline `dd29a2940248952b4b94bd90bd3f6350de94c76a`. Work from the current authorized checkout. Treat a descendant with unrelated changes as user work to preserve.

## Constraints that apply to every task

- Preserve Bashwink's commands, terminal UI, supported provider interfaces, workspace trust, approval prompts, hard denies, policy boot handshake, evidence, cancellation, and persisted state and session formats.
- Commit the needed upstream source into this repository. Keep its license and notices, use local workspace resolution, and retain internal names and protocol IDs where that preserves behavior. Use no nested Git repository, submodule, private upstream checkout, or untracked developer files as an input to the finished build.
- Use the terminal CLI closure plus measured build inputs. Leave upstream desktop, standalone web app, unrelated services and deployment assets, and Hermes Agent code outside the import. Retain required transitive modules, plugin loader assets, models, migrations, and tests that prove parity. Use the upstream `--skip-web-ui` path for the web archive. Bashwink currently refuses the upstream `serve` control command.
- The final build, package, and runtime require no OpenCode registry artifacts or executable on PATH. This includes `opencode`, `@opencode/cli` and its platform variants, `@opencode/pty` and its platform variants, and the OpenCode workspace libraries. Local workspace names beginning with `@opencode/` are fine when they resolve inside the checkout. The configured model provider and pinned third-party dependencies such as Bun remain separate inputs.
- Keep the current installer and standard runtime available during the migration. Switch the default only after all current targets pass the cutover gate. Keep the existing optional VM path working and verify its guest artifact separately. Keep the project phase status and alpha verdicts tied to actual evidence.
- Build assets into fresh, ignored output directories. Resolve each build input to a pinned, reviewable source. Preserve upstream install-script restrictions, use no system-wide configuration changes in tests, and keep provider secrets and machine paths out of artifacts and logs. Use a scripted provider for routine verification. Live tests need an authorized provider and budget.

## Source and platform pins

| Item | Pin and evidence |
| --- | --- |
| OpenCode engine | [anomalyco/opencode v2.3.2](https://github.com/anomalyco/opencode), `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, MIT. `docs/bashwink/UPSTREAM_BASELINE.md` records the original checked-out build. |
| Native PTY helper | [process-daemon v0.6.0](https://github.com/anomalyco/opencode/releases/tag/process-daemon-v0.6.0), `03d848f7b8d71d31d3e56f2abd8b337efbc1bc32`, path `packages/process-daemon/`. Keep the exact Cargo lock and notices. Its runtime source matches the CLI pin under that directory; the pinned trees differ in one test file. |
| PTY toolchain | Rust `1.90.0` and Zig `0.16.0` per the upstream daemon workflow; Windows uses the x64 MSVC target and its SDK. Ghostty `ab0b9da9e88fcb4b0533a1854e84628f663930af` per the pinned daemon source. |
| OpenTUI native library | [anomalyco/opentui v0.8.4](https://github.com/anomalyco/opentui), `d4a2af24ba50636da5f222367f91746a1bf89644`. `release/NOFFMPEG_RUNTIME.md` records Zig `0.17.0` for this build and existing arm64 evidence. The no-FFmpeg Windows build still needs proof. |
| Source build tools | Bun `1.4.4`, Node.js `22`, Python `3.12` and platform-native compiler toolchains as above. Verify versions rather than silently updating pins. |

Start native proof on `darwin-arm64` and `win32-x64`. Before default package cutover cover `darwin-arm64`, `darwin-x64`, `win32-x64`, and `linux-{x64,arm64}-{gnu,musl}`. A Windows x64 host is required for the Windows claim. Windows ARM64 remains refused. Use the Linux arm64 musl build for the current guest and verify its separate VM gate.

## Review focus

| Risk | Where to prove it |
| --- | --- |
| An import, lockfile, embedded plugin, or installer still downloads an OpenCode package | Tasks 1, 3, 5 and 6 |
| A launcher accepts the wrong platform's engine, a modified file, or an OpenCode binary supplied through PATH | Tasks 3, 4 and 5 |
| The new runtime quietly skips policy or records a failing command as success | Task 6 |
| Existing sessions or trusted workspace settings fail when upgrading | Task 6 |
| A required platform, license, artifact source, or rollback step is missing at cutover | Tasks 5, 7 and 8 |

## Task 0 — Establish the baseline and the working branch

- [ ] Run `pwd`, `git status --short --branch`, `git branch -vv`, and `git log -5 --oneline`. Read `AGENTS.md`, `docs/bashwink/README.md`, `AGENT_WORKFLOW.md`, `BASHWINK_PHASE_BY_PHASE_TASK_PLAN.md`, `PHASE_GATE_CHECKLIST.md`, `NEXT_STEPS.md`, and the relevant rows in `BASHWINK_TASKS_90.csv`. Verify that Phase 0 and 1 passed and identify the current gate. Preserve user changes and work in an isolated branch or worktree using local guidance.
- [ ] Inspect the current launcher and package manifests. Confirm the pin of the reference upstream checkout at `../bashwink-upstream/opencode` if available. If absent, acquire the two exact upstream commits in a disposable directory outside the Bashwink repo, verify each hash and the corresponding tag, and record the official origin. Treat upstream checkout material as input data.
- [ ] Capture baseline tests on the current engine before switching anything. Run `bun test packages`, `bun run lint`, `bun run typecheck`, `python3 scripts/verify_bashwink_docs.py`, and `python3 scripts/generate_status_summary.py --check` in the environments where they are supported. Capture the current real-runtime health, tool lifecycle, scope, resume and terminal results with the pinned comparison binary. Record actual exit codes and skipped cases. The known previous source install proof is [hosted run 45588011523](https://github.com/ALDRIN121/bashwink/actions/runs/45588011523), at the reference baseline.
- [ ] Keep a comparison package and fixture baseline in a disposable, checksum-recorded location. Commit the next steps or evidence locally when requested by the repository workflow. Stop baseline work if required behavior cannot be reproduced. Establish the reason before continuing.

**Gate A:** Exact baseline and platform facts recorded. Existing release artifacts and working checkout preserved.

## Task 1 — Import the minimal source and test its provenance

**Produce:** `vendor/engine/UPSTREAM.json`, `vendor/engine/LICENSE`, retained sources and build metadata, and `scripts/test_local_engine.py`.

- [ ] Write a provenance test that checks the exact CLI and helper commit pins, locates the upstream MIT notice, rejects any contained `.git` metadata, and fails when a tracked imported file is missing from the inventory or differs from its recorded source without a recorded patch. Confirm the test fails before the import.
- [ ] Derive from the pinned manifests and build imports, then import tracked files from those commits and their applicable notices. Start with the 17 recorded production workspaces: `cli`, `client`, `server`, `tui`, `core`, `ai`, `plugin`, `plugins/browser`, `protocol`, `schema`, `util`, `theme`, `ui`, `simulation`, `codemode`, `latex` and `merman` under `packages/`. That is a package-level closure, not a final file count. Include the necessary `packages/script` inputs, upstream root native helper scripts, catalog entries, dependency patches, committed `packages/core/src/models-dev/snapshot.txt`, and any retained generated inputs or tests required by the compile and test graph. Keep the PTY source under `vendor/engine/packages/process-daemon/`.
- [ ] Make the vendor workspace independently installable from its tracked manifests and lockfile. Preserve pinned third-party dependencies and upstream file contents unless an integration patch is required. Remove only source or dependencies proved unused by the build and test graph. Inventory build inputs and patch deltas by upstream path and commit. Avoid copying generated binaries, package caches, build reports with home paths, and unrelated apps.
- [ ] Run the provenance test and locked install. Inspect origins for dependencies whose names start with `@opencode/` or `@opencode-ai/` and document the expected temporary comparison items. In final local mode, only vendored resolutions may remain.

**Gate B:** Every retained upstream input has provenance and a notice, and an imported file can be traced to either its pinned source or a deliberate patch.

## Task 2 — Build the native PTY helper from local source

**Produce:** A target-specific PTY binary plus its source pin and SHA-256. Adapt `vendor/engine/packages/cli/script/opencode-pty.ts` and `vendor/engine/packages/core/src/persistent-pty/pty-binding.ts` as needed.

- [ ] Test the CLI build asset resolver and core PTY entry with a local helper artifact and a missing registry shim. Confirm the original eager `createRequire` resolution of `@opencode/pty/package.json` fails this case. Add missing, wrong-target, and wrong-hash failure cases.
- [ ] Build the pinned daemon from the imported `Cargo.toml` and lockfile. Use `cargo build --locked --release --target <actual-rust-target>` following the pinned release workflow and Ghostty sources. Use the host-native build path first. Validate its version/protocol against the CLI, and record the target and required licenses.
- [ ] Route the existing embedded binary or local binding seam to the Bashwink-built helper. Keep its protocol and access controls. Remove eager registry shim discovery and runtime fallback to a foreign `opencode-pty`. Keep any required shim types or exports as local code.
- [ ] Verify helper startup, terminal I/O and teardown using upstream helper tests or an equivalent local end-to-end check. Verify Windows native exit behavior as a separate case. A compile without an executable test is partial evidence.

**Gate C:** CLI compilation and PTY execution can use the validated local helper with registry PTY packages absent.

## Task 3 — Compile the engine using the pinned upstream build

**Produce:** `scripts/build_local_engine.py` and outputs under `build/engine/<target>/`. The target manifest `engine-manifest.json` identifies the schema version, source pins, target, engine and PTY relative names and SHA-256 values, toolchain versions, and notice inventory. Output is derived locally, never imported from an unverified system binary.

- [ ] Add manifest tests for unsupported targets, missing files, a digest mismatch, and a build that attempts to use a nonlocal PTY. Validate path containment after symlink resolution and refuse a published-runtime download fallback. Run and observe the failing cases before wiring the build.
- [ ] Use `packages/cli/script/build.ts` with its original Bun transforms, embedded models and plugin runtime modules. The stock build supports `--single --skip-install --skip-web-ui`. Supply the local PTY and validated host-native build inputs, and derive `OPENCODE_TARGET` where the stock target name differs from the Bashwink manifest key. The old `--skip-install` is valid only after required local inputs are prepared. Preserve target version reporting and the embedded plugin hook contract. Keep all output paths separate from source and from user-owned build directories.
- [ ] Rebuild the required OpenTUI artifacts through the evidenced no-FFmpeg recipe for applicable targets. Verify all actual embedded native variants for the requested target, including glibc artifacts embedded alongside musl artifacts. Compare native libraries against the published notice inventory. Use the full native licensing gate rather than treating a string search as legal clearance.
- [ ] Run the built engine's version check, prove the private server and plugin boot, and validate manifest checksums. Start on Apple Silicon and Windows x64. Expand to the rest of the target matrix as part of Task 7. Log any target the available runners cannot verify.

**Gate D:** A clean checkout builds and launches the local engine with no registry copy of OpenCode available. Each result is tied to a target and source digest.

## Task 4 — Connect Bashwink to the built engine without behavior changes

**Modify:** `packages/bw-cli/src/runtime.ts`, `main.ts`, `doctor.ts` as needed, Bashwink workspace manifests and lockfile, and `release/npm/bin/bashwink.js`. Keep existing runtime/policy boundaries and evidence APIs.

- [ ] Extend `packages/bw-cli/test/npm-launcher.test.ts` and runtime resolution tests. Exercise a correct manifest, missing engine, wrong target, wrong hash, path escape, a lookalike executable on PATH, and a user-supplied runtime environment override in packaged mode. Fail closed before stdout claims or model/tool activity if the engine is invalid.
- [ ] Keep the private process boundary and set its runtime path from the validated package manifest. Bind the package launch to the local artifact. Preserve the intended development/test override only outside packaged execution. Prevent the installed engine from launching an upstream updater or replacing itself with an upstream download. Existing explicitly configured model providers keep their intended behavior.
- [ ] Resolve Bashwink's OpenCode plugin, schema and related build dependencies from the local import. Regenerate and inspect the effective lockfile. Keep the hook failure, trust and evidence gating behavior in the runtime rather than in prompts. Reuse existing configuration and session formats and paths.
- [ ] Run launcher and runtime unit tests, typecheck, and early smoke with the built artifact. Compare diagnostics and version output with the baseline. No retention or upgrade promises until Task 6 verifies real state and sessions.

## Task 5 — Package the local engine and preserve the installer

**Modify:** `scripts/build_npm_package.py`, `release/npm/package.json`, `release/npm/bin/bashwink.js`, and installed-package checks. Stage the vendored build in shadow CI before removing the comparison mode.

- [ ] Test that a tarball from the new builder contains the validated `libexec/` engine and manifest, retains notices, and installs and starts in a clean npm prefix without any OpenCode package available from the registry. Test missing/wrong-target/stale engine artifacts, a blocked npm lifecycle configuration, and Windows temporary path handling. Keep the existing Bun installer consent tests.
- [ ] Give the packager an explicit engine-input directory for CI and contributor builds. Verify source and platform identity and checksum before copying. Install the engine under the package root and package all required metadata. Remove external OpenCode dependency declarations from the new package, including indirect resolution through the installed evidence plugin.
- [ ] On a contributor checkout, build the engine using `scripts/build_local_engine.py` and then invoke the packager. Keep the normal tester flow using the current prerequisites (Node.js/npm, Git, Python and optional Bun prompt) by preferring a validated Bashwink-built artifact from the same private repo if artifact delivery is approved. Settle the concrete store, access method, artifact expiry, checksum pin and recovery path before enabling that installer mode. Never embed credentials or send a tester to upstream OpenCode. If no approved artifact can be obtained from a fresh clone, retain the current installer until the owner chooses an explicit source-build route or artifact delivery route.
- [ ] Run `python3 scripts/npm_install_check.py <tarball>`, startup with npm scripts disabled, Windows `release/tester-kit/windows-qualify.ps1`, and checksum verification on the exact package for each platform. A failed dependency transfer must leave the previously installed CLI usable where npm supports rollback, or leave a clear recovery instruction.

## Task 6 — Prove parity and removal of OpenCode registry traffic

- [ ] Add a mechanical package-origin audit in `scripts/test_local_engine.py`. Inspect manifests, lockfile resolutions, artifacts, dependency trees and observed fetches. The audit should fail if `opencode`, `@opencode/*`, `@opencode-ai/*`, their platform packages, or upstream executable downloads appear in the new path. Distinguish locally resolved namespace imports from registry packages. Prove the gate with a planted external resolution in an isolated fixture.
- [ ] Run a clean install and packaged launch with OpenCode downloads disallowed and no external OpenCode executable on PATH. Prove the launcher rejects an absent or modified local engine even with an executable lookalike on PATH. Start a controlled provider session with one allow, one deny and one failing tool command. Verify file effects, exit codes, and evidence records independently.
- [ ] Run `./fixtures/runtime-health/run.sh`, `./fixtures/tool-lifecycle/run.sh`, `./fixtures/scope-fence/run.sh`, `./fixtures/idempotent-resume/run.sh`, and `./fixtures/interactive-entry/run.sh` where their host supports them. Point their existing test boundary at the Bashwink-built engine. Run `python3 fixtures/release/npm_qual.py <tarball>`, `npm_smoke.py` where applicable, and the Windows terminal checklist. Translate unsupported fixture layers into native checks, never a green result for a skipped required control.
- [ ] Compare the same provider/task, trust prompts, failure paths, policy-deny behavior, evidence export, and cancellation against the baseline under equivalent conditions. Open a copy of pre-change profile/session state and verify resume, then prove rollback with a copy of that state. Keep the original read-only. Run live provider checks only with approval and budget. Record each result with target, source commit, artifact hash and actual status.

**Gate E:** Clean builds and installs pass without OpenCode registry access, and old and new runtimes show equivalent behavior on the supported Bashwink flows. Any untested required case blocks cutover.

## Task 7 — Qualify the complete target matrix and the optional guest

**Modify:** `.github/workflows/verify.yml`, `scripts/build_release.py`, `release/runtime-pins.json`, `release/guest/run-user.sh`, and applicable release helpers.

- [ ] Run shadow CI for the local engine on the complete standard target matrix. Supply only matched build artifacts between build and install jobs, prove release-mode runtime health actually runs against the new artifact, and reject skipped required legs. Run separate source and install checks on Windows x64 and macOS before advertising that path. Record emulated runs separately from native desktop checks.
- [ ] Rebuild the current Linux guest engine from the same source, keep the existing disconnected guest, provider relay and approval design, and validate the pinned engine used inside the VM. Run its release/default, lifecycle, provider relay, cancellation and containment controls using the existing release harness. Keep the guest artifact unchanged until its dedicated evidence passes.
- [ ] Produce third-party inventory and notices per artifact. Recheck the FFmpeg-free build and licensing requirements for Bun/JavaScriptCore, OpenTUI and Ghostty. Run `python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json --fail-on-open` where applicable and record open items. Tracking or packaging source is not release clearance.

## Task 8 — Perform a reviewed cutover or stop at the gate

- [ ] Confirm Gates A–E, full target coverage, compatible local state, artifact delivery, and the separate guest decision. Replace registry installation in development and `.github/workflows/verify.yml` runtime jobs, remove fallback code from the new package, and update installer help, `README.md` and Windows/macOS guides only after the respective runs pass.
- [ ] Record the superseding decision in `docs/bashwink/DECISIONS.md` and link it from ADR-001, the vendor provenance manifest, and the install docs. Record commands, exit codes and artifacts in `TEST_EVIDENCE.md`. Reconcile `IMPLEMENTATION_STATUS.md`, `NEXT_STEPS.md` and the canonical CSV according to `AGENTS.md`. Avoid marking unrelated gate criteria or alpha readiness as passed.
- [ ] Run final package tests, lint, typecheck, docs audit, status generator check, license gate and clean platform installs. Review the diff for retained upstream attribution, local-only engine resolution, and no credentials, generated binaries or new automatic network routes tracked in Git. Retain the prior commit/package and rollback instructions using a disposable profile copy.
- [ ] When a required check fails or cannot run, keep the current package path, record the exact blocker and the next eligible task, and stop at the gate. For a verified migration, hand over the branch, diff, manifests, tests, and remaining publication approvals. Obtain separate authorization before pushing, merging, publishing, or distributing a build.

## Copy-ready handoff prompt

> Open the existing Bashwink repository. Read `AGENTS.md` and the phase/status files it lists, then read `docs/superpowers/specs/2026-11-25-local-engine-design.md` and `docs/superpowers/plans/2026-11-25-local-engine-implementation.md`. If the plan is supplied as a standalone handoff, open it alongside the repository and use its repo-relative paths. Execute the plan starting with Task 0. Keep only the required pinned OpenCode source and build inputs inside Bashwink, retain upstream attribution and current Bashwink behavior, and remove all OpenCode registry dependencies at the verified cutover. Preserve existing changes and use an isolated local branch or worktree. Build and test with actual evidence at each gate. Do not switch the installer while any required target, policy check, session check, artifact delivery or licensing gate is open. Record the next eligible task and blockers. Push, merge or publish only on explicit authorization.
