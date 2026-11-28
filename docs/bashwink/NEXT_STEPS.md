# Bashwink next steps

**Current mission:** standalone Node 22+ coding alpha (`v0.2.0-alpha.2`, [ADR-015](ADR-015-STANDALONE-CODING-ALPHA.md)). The older fork baseline (`0.1.0-alpha.1`, `e4d6751`) is preserved as the rollback pin.

## Standalone alpha (`v0.2.0-alpha.2`) — Phase 2 implemented & evaluated on `darwin-arm64`; cross-platform & live-provider gate items open

Verified locally on macOS Apple Silicon (`darwin-arm64`, `Node v22.23.2`):
- **16/16 Phase 2 tasks** implemented and verified on the standalone Node `>=22.13.0` runtime (`ADR-018` / `ADR-019`): `BW-017`, `BW-018`, `BW-020`, `BW-055`–`BW-061`, `BW-066`, `BW-067`, `BW-075`, `BW-076`, `BW-084`, `BW-091`.
- `npm run test:standalone` (39/39 unit, Phase 2 guard, permission-mode, and real PTY widget tests)
- `bun test packages/bw-cli/test/contract.test.ts packages/bw-cli/test/contract-cli.test.ts packages/bw-cli/test/usage-guard.test.ts packages/bw-evidence` (133/133 shared-module regression tests)
- `npm run test:standalone:install` (build, audit, space prefix, upgrade, corrupt tarball, uninstall)
- `npm run test:standalone:e2e` (12/12 real PTY adversarial + lifecycle scenarios)
- `npm run test:standalone:independence` (clean clone with `vendor/`, `node_modules/`, `build/`, OpenCode, Hermes, Pi, and Bun physically absent)

Remaining actions before external distribution or starting Phase 3:
1. Run `npm run test:standalone`, `npm run test:standalone:install`, `npm run test:standalone:independence` (and `test:standalone:e2e` on Linux/macOS Intel + Windows native ConPTY) on `linux-x64`, `linux-arm64`, `darwin-x64`, and `win32-x64`.
2. Run a bounded authorized live-provider interactive session against the Phase 2 standalone build and record real endpoint evidence.
3. Explicitly authorize if/when to start Phase 3 (Execution isolation & review/verify stack) or publish packages (`do not publish or push` without explicit approval).

The standalone TUI refresh bounds the composer and updates the transcript and footer. Draft
retention across overlays, diagnostic cancellation, and a model-only switcher remain eligible UX
follow-ups. [Refresh evidence](TEST_EVIDENCE.md#2026-11-28--standalone-tui-refresh).

---

## v0.1.0-alpha.1 release candidate RC1 — stopped at the gate (historical, 2026-11-25)

A self-contained macOS Apple Silicon archive exists locally (candidate
`13f003de321977d13bfac3839b8b721a01a95cef`). Verdicts: personal use **CONDITIONAL**, internal alpha
**CONDITIONAL**, external alpha **FAIL**, public release **FAIL**. See the
[gate report](releases/v0.1.0-alpha.1/RELEASE_GATE_REPORT.md). Nothing was published or pushed.

Scope decision ([ADR-013](DECISIONS.md)): this candidate advertises macOS Apple Silicon only, on the
builds in `release/qualified-hosts.json`. BW-031 and BW-032 are **not** complete and keep every
original requirement; both stay `In progress`.

Next eligible actions, in order, each with the evidence that closes it (full table in the gate
report, section L):

1. **Owner:** provide an authorized CommandCode key as a mode-600 file (e.g.
   `~/.config/bashwink-qual/commandcode.key`), then run the live stages
   (`fixtures/release/release_first_run.py <archive-dir> --out r.json --live --key-file <file>`),
   a cancellation observation and a connection-drop observation.
2. **Owner:** make a clean Docker-free Apple Silicon host available (macOS 27.0.1 build 26A434)
   and run the four release harnesses there. Until then every clean-host row stays `BLOCKED`.
3. **Owner:** authorize pushing the branch so the `verify` workflow can run at the candidate SHA.
4. **Owner:** decide the LGPL FFmpeg question for the shipped OpenCode binaries (ADR-009).
5. Find the cause of the intermittent legacy guest-TUI fixture failure (about 1 in 6 to 10 runs).
6. Exercise the 30-minute deadline, a real unsupported macOS build and the remaining controls in
   the gate report. Linux (Ubuntu) rows of BW-032 remain open and outside this candidate.

Any code change after the candidate commit needs the affected verification repeated and a new
archive and checksum.

## Previous status

The local macOS VM fixture has live CommandCode coding, model switching, reviewed
application, and session recovery evidence. Early apply recovery quarantines an
unidentified directory and records the abandoned transaction. Committed receipts
refresh the saved baseline on the next project open. These are bounded fixture results,
not full release qualification.

Before external alpha, provide a self-contained relay-enabled installation and test it
on a clean Apple Silicon host without Docker. Qualify all required BW-032 controls,
including cancellation and process observations, and validate the exact candidate and
its CI evidence. Resolve the current guest execution deadline and unverified power-loss
cases. Preserve quarantined directories for inspection. Broader workspace support and
Linux qualification remain open. [Current evidence](TEST_EVIDENCE.md).

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


## Following the live CommandCode run

Qualify remaining live cancellation, interrupted upstream and platform controls. Package and qualify a
relay-enabled installation on a clean target host. Keep BW-031, BW-032 and external
alpha open until their full acceptance criteria pass.

## 2026-11-25: after candidate `npm-rc1`

Eligible now: permission negative tests against the installed package; bounded retries and a request/cost cap with
display (BW-075 minimum); the 25-question audit; `npm audit` and transitive licences. Blocked on the owner: the key
file, Windows 11 x64 and Linux hosts, permission to push for hosted CI, the licensing decision. BW-031 and BW-032 stay
In progress. Full list: `FINAL_ALPHA_RELEASE_REPORT.md` section G.

## 2026-11-25: after candidate `npm-rc2`

Blocked on the owner, in this order: (1) fix GitHub Actions billing and re-dispatch `verify.yml` on `release-candidate/v0.1.0-alpha.1-standard`; (2) create the key file and run `npm_live.py`;
(3) a Windows 11 x64 machine for `release/tester-kit/`; (4) the licensing decision (`STANDARD_PACKAGE_LICENSING.md` section 5); (5) a tester other than the author. Eligible without the owner:
surface a limit stop inside the terminal UI (F-19); a no-progress detector (BW-076); a recovery test (`bashwink resume`) against the installed package; selecting the `-baseline` runtime on CPUs without AVX2;
investigating the one `runtime health (ubuntu)` flake (F-24). BW-031 and BW-032 stay In progress. Full list: `FINAL_ALPHA_QUALIFICATION_REPORT.md` section 12.

## 2026-11-25: after the live run on candidate `npm-rc2`

Done: live qualification on macOS arm64 (19/19). Remaining blocked on the owner: (1) GitHub Actions billing, then re-dispatch `verify.yml`; (2) a Windows 11 x64 machine for `release/tester-kit/` (a live run on Windows needs a key delivered to that machine by the owner, never through this repository);
(3) the licensing decision; (4) a tester other than the author. Eligible without the owner: document F-26 in `KNOWN_LIMITATIONS.md` and the tester guide (**changes package contents, so it needs a new candidate and a new checksum**; bundle it with any other package change rather than rebuilding for it alone);
drive the interactive screen with a live model (the owner can simply use `bashwink` in a throwaway project); a live limit-enforcement run; the items listed under `npm-rc2` above. BW-031 and BW-032 stay In progress.

## 2026-11-25: source build and install

Clean-checkout local-engine source build, first-use TUI isolation (`OPENCODE_DISABLE_FREE_MODELS=1`), PTY launch, `npm_qual.py` (72/72), failed/repeat/upgrade/uninstall lifecycle, and `npm_config_ignore_scripts=true` now pass on Apple Silicon (`darwin-arm64`). Next steps:
1. With explicit push authorization, run `.github/workflows/verify.yml` (`npm-package` matrix on `ubuntu-latest`, `macos-15`, `windows-latest` with Rust `1.90.0` + Zig `0.16.0`/`0.17.0`).
2. Verify native desktop/host builds for Windows 11 x64 (`python scripts/build_npm_package.py --install` in PowerShell), macOS Intel (`darwin-x64`), and Linux x64/ARM64 (`glibc` and `musl`) — currently marked **UNVERIFIED**.
3. Complete live-model smoke check with owner API key (`fixtures/release/npm_live.py`) and licensing sign-off before wider distribution.
4. Keep `BW-031`, `BW-032`, `BW-075`, `BW-076` open in their respective phase gates (`AGENTS.md`).
