# Final engineering audit: standard npm package, candidate `npm-rc2`

Candidate: `v0.1.0-alpha.1-npm-rc2`, commit `cf76323`, SHA-256 `486a1da4f571494263af99ddf4806c1367ad5273b031e1034de2b0df2a32a5b2`
(two independent builds byte-identical). Date 2026-11-25. Findings F-1 to F-7 are in `FINAL_ALPHA_RELEASE_REPORT.md`; this file
continues at F-8. "Hosted" means a GitHub-hosted cloud runner, not a desktop. "Scripted" means the stand-in provider
`fixtures/release/script_provider.py`, which is not a model.

**Hosted CI has not run on the candidate commit.** After runs on `e810aba`, `e96fd31`, `25db28f` and `6cb1e87`, GitHub refused to start
every job of the run on `b6d06d7` ("recent account payments have failed or your spending limit needs to be increased"). Questions
below cite the last executed hosted run (`45537295390`, `6cb1e87`) where they rely on it.

## The 25 questions

| # | Question | Answer | Evidence and limits |
| --- | --- | --- | --- |
| 1 | Can a Windows x64 developer install the tarball? | **YES on a hosted runner; NOT_RUN on Windows 11** | `npm install -g` PASS in 22 s on Windows Server 2025 x64 (`6cb1e87`), PowerShell and cmd, path with spaces and non-ASCII. No physical Windows 11 machine used. |
| 2 | Does plain `bashwink` launch the interactive CLI? | **PARTIAL** | PTY smoke 17/17 on macOS arm64 (candidate). Not run on Linux or Windows (the CI step for POSIX was added after the last executed run). Windows rendering is a manual checklist item. |
| 3 | Does it use the current directory? | **YES** | Every harness scenario edits the project it is run in; a junction/symlink to the project edits the real directory (macOS, Ubuntu, Windows runs). |
| 4 | Are required runtimes resolved automatically? | **YES** | Install check and harness on three hosted OSes and the Mac: `bun` and `@opencode/cli-<platform>` resolved with no source checkout and no PATH discovery. Windows `bin/*.exe` layout confirmed. Windows x64 CPUs without AVX2 are not handled (upstream `-baseline` packages are not selected). |
| 5 | Does first-time provider setup work? | **YES** | Configuration: scripted provider on all platforms. Live: `auth add --key-file`, `model use` and `auth check` succeeded against the real endpoint on macOS arm64 (19/19, `release/standard/0.1.0-alpha.1-npm-rc2/live-macos-arm64/`). Not run live on Windows or Linux. |
| 6 | Can a real model complete a coding task? | **YES, one small task, one Mac** | Live, through the installed package: the model ran the failing test, edited `sum.js`, re-ran the test; the test passes when run independently and the diff touches only `sum.js`. Both wire protocols were used (`claude-sonnet-5` Anthropic, `gpt-6.1-sol` OpenAI). This says nothing about realistic projects. |
| 7 | Can the user switch models? | **YES, scripted and live (macOS arm64)** | Continuing a session with `--model` of a second declared model: served by that model, earlier conversation carried, evidence attributes both (macOS, Ubuntu, Windows hosted). |
| 8 | Does session recovery work? | **PARTIAL** | Continuation with `--session` works. Recovery after a killed process (`bashwink resume`) was not run against the installed package. |
| 9 | Are risky operations appropriately controlled? | **YES for the advertised controls** | Untrusted workspace: no write/read/shell; restricted contract removes the shell tool; code execution, web fetch/search and sub-agents refused; writes/reads outside the project refused. Shell is a **best-effort** path guard, not a sandbox (stated everywhere). |
| 10 | Are explicit denials preserved? | **YES** | A user deny rule survives `--auto`; the control command ran, so `--auto` really was approving (macOS, Ubuntu, Windows hosted). |
| 11 | Do policy initialization failures stop execution? | **YES** | A policy plugin that throws on load: exit 3 and **zero** model requests, even after an earlier run left valid evidence (all three hosted OSes). |
| 12 | Are credentials handled safely? | **YES after F-8 and F-11 fixes, with limits** | Env key: not readable by an approved shell command, absent from every recorded file (3 hosted OSes). Key file: file tools cannot read it; obvious shell path arguments refused (best-effort; Windows variant fixed after the last hosted run). Keys in the environment of other tools are unprotected. |
| 13 | Does cancellation work? | **YES** | Group interrupt and launcher-only signal: ends in <1 s, closes the in-flight provider request, finalizes the run record, no process left (macOS local, Ubuntu hosted, Windows hosted via console break). Real Ctrl+C in a Windows console and closing a terminal window are NOT_RUN. |
| 14 | Are owned resources cleaned up? | **YES** | Process snapshots before/after cancellation and after normal exit: nothing new left (3 hosted OSes + Mac). Disk and temporary files not audited beyond the harness's own directories. |
| 15 | Can the uninstaller delete unrelated files? | **NO** | `npm uninstall -g` removes the package; the harness verifies the project and the profile data survive (3 hosted OSes). The VM artifact's uninstaller was fixed separately in RC2 and is not part of this package. |
| 16 | Is native execution described accurately? | **YES after correction** | Found and fixed: "asks before network use" (network tools are refused), "the model cannot read a key file" (file tools cannot; shell is best-effort), notices that omitted bundled third-party code. Banner, help, README, guide, limits and notices re-read against tests. |
| 17 | Does sandbox selection fail closed? | **YES** | `--sandbox`: exit 3, "will not start", zero model requests, failure recorded (all platforms, install check; harness on Mac/Ubuntu/hosted macOS). |
| 18 | Are supported platforms genuinely qualified? | **NO** | Hosted-runner results only for macOS 15 arm64, Ubuntu x64, Windows Server 2025 x64; the Mac for the candidate. No Windows 11 desktop, Linux desktop, Intel Mac or ARM64 Windows. "Qualified" would overstate this. |
| 19 | Are package dependencies reproducible? | **PARTIAL** | Tarball is byte-reproducible; runtimes are exact-pinned (`bun@1.4.4`, `@opencode/cli@2.3.2`) but fetched from the registry at install time and no lockfile is shipped; registry integrity checks are the only guard. |
| 20 | Are licensing requirements addressed? | **PARTIAL** | Bundled MIT code (`effect`, `@opencode/schema`, `@opencode/plugin`) now has its licence texts, enforced by the builder (F-12). The stock runtimes embed LGPL code and ship no licence files. **No legal sign-off.** See `STANDARD_PACKAGE_LICENSING.md`. |
| 21 | Are known vulnerabilities assessed? | **PARTIAL** | `npm audit`: 0 findings over 27 packages (`DEPENDENCY_AUDIT.json`). Native code inside the two binaries is not covered: an unverified risk. |
| 22 | Do release checks pass? | **YES locally; NOT verified on the candidate in hosted CI** | Local: 571 tests, lint, typecheck, format, docs audit. Hosted `6cb1e87`: all gating jobs passed except `cli (ubuntu)` and the Windows jobs, whose failures were fixed afterwards. Hosted CI on the candidate: BLOCKED (billing). |
| 23 | Is the artifact usable without the source repository? | **YES** | Installed into a throwaway prefix with a throwaway npm cache and HOME; the harness drives only the installed command. (The harness itself is run from the repository.) |
| 24 | Is future engine extensibility preserved? | **YES** | ADR-014: four seams (execution backend, runtime binary, runtime protocol, evidence format) unchanged; nothing built. |
| 25 | Is a Rust migration still practical later? | **PARTLY, as ADR-014 states** | A wrapper port is realistic (HTTP/SSE/process management against a documented API; 9,300 lines); the plugin stays TypeScript while OpenCode is the runtime. No port was attempted. |

## Finding records (F-8 onward)

Severity: Critical (blocks the platform), High, Medium, Low, Info. "Verified" states where the fix was exercised.

**F-8 · High · credentials.** Component `bw-evidence` plugin, `bw-cli/main.ts`. Observed: with `--env`, an approved shell command
`printenv KEY` printed the provider key, which then appeared in the tool result sent to the provider **and in plaintext in the evidence
log and session store**. Expected: provider keys never reach a recorded file or a model-run command. Repro: declare a provider with `--env`,
run `printenv` via the shell tool with `--auto`; `grep` the profile. Evidence: the canary was in 2 files under the profile and in the provider-visible tool result before; in none after. Impact: key
disclosure to anyone given an evidence export. Action: done. The wrapper names the declared variables; the plugin clears them from shell
environments and masks their values in evidence. Verified: macOS local, Ubuntu/macOS/Windows hosted (`KEY=[]`, 0 files).

**F-9 · Critical (Windows) · admission proxy.** `bw-cli/src/session-admission.ts:27`. Observed: `directory.startsWith("/")` made every
Windows path "outside the workspace", so every session action returned 403 and Bashwink could not run on Windows. Found by a new unit test on
the hosted runner. Repro: `bun test packages/bw-cli/test/usage-guard.test.ts` on Windows. Action: `path.isAbsolute`. Verified: the hosted
Windows coding task passed afterwards (`6cb1e87`).

**F-10 · Medium · doctor.** `bw-cli/src/doctor.ts`. Observed: `which("git")` found no `git` on Windows (only `git.exe`), so a fresh Windows
install showed a failing `doctor`. Action: `findOnPath` honours `PATHEXT`. Verified: hosted Windows `doctor` and tester kit (`6cb1e87`).

**F-11 · Medium · shell guard (best-effort control).** `bw-evidence/src/scope.ts` `shellPathTokens`. Observed: only tokens containing `/` were
path-like; on Windows a scripted command printing `C:\...\provider.key` ran and the key reached the model. Expected: parity with POSIX for
the obvious cases. Action: backslash tokens are path-shaped; unit-tested; claims narrowed (the check remains best-effort). Verified: unit tests
only; **not re-run on Windows**.

**F-12 · Medium · licensing.** `scripts/build_npm_package.py`, notices. Observed: the compiled CLI contains `effect@4.1.0`, `@opencode/schema`
and `@opencode/plugin`, but the shipped notice said the tarball held only Bashwink's files. Action: the builder derives the bundled list from the
bundle, includes the licence texts, records them in the manifest and fails the build if a package has no notice. Verified: build output.

**F-13 · Low · key-file check on Windows.** `providers.ts`. Observed: printed "mode 600" where modes mean nothing. Action: says the protection is
not checked on Windows. Verified: unit test only.

**F-14 · Medium · path validation.** `contract.ts`, `plan.ts`. Observed: `C:/x` accepted as repo-relative, which resolves outside the workspace
on Windows. Action: drive-letter paths are absolute. Verified: unit tests.

**F-15 · Low · accuracy.** `help.ts`, `release/npm/README.md`. Observed: "asks before … network use"; network tools are refused. Action: reworded.

**F-16 · Medium · Windows cancellation.** `release/npm/bin/bashwink.js`. Observed (reasoned from Node's documented behaviour, then verified): `child.kill`
terminates abruptly on Windows and would skip cleanup. Action: the launcher waits instead; the CLI treats `SIGBREAK` as an interrupt. Verified: hosted
Windows cancellation (0.1 s, record `cancelled`, no leaked process).

**F-17 · Low · store.** `store.ts`. Observed: a refused schema left the SQLite handle open (blocks deletion on Windows). Action: closed on failure. Verified: unit suite on the Windows runner.

**F-18 · Info · limit overshoot.** Observed: a request limit of 6 let 7 requests reach the provider; one request was in flight when the stop came. Expected: stated, not hidden.
Action: documented as "not a hard ceiling"; the test asserts the exact bound (limit to limit+1). Residual: a single request can be large.

**F-19 · Low · terminal UI.** Observed: the reason for a limit stop is shown when the session ends, not inside the screen. Action: documented. Recommended: surface it through the TUI plugin.

**F-20 · Medium · test integrity.** Observed: standard mode has no protected-test mechanism; an agent can edit a test until it passes (demonstrated by the harness).
Action: after each run the changed test files (written through the file tools) are named, with what cannot be seen (changes made by shell commands), and recorded as
`changedTests`. Residual: shell-made changes are undetected. Not a protection.

**F-21 · Info · compliance.** Observed: neither `@opencode/cli*` nor `bun`/`@oven/bun-*` ships a licence or notice file. Action: stated in the notices; texts must come from upstream.

**F-22 · Medium · unverified risk, narrowed 2026-11-25.** The Anthropic messages protocol had never been exercised against the installed package (the scripted provider speaks only OpenAI chat). **Now exercised live** on macOS arm64: `claude-sonnet-5` completed a real coding task and a session continuation through the installed package, then the session switched to the OpenAI-protocol `gpt-6.1-sol` (19/19). Still unverified: the Anthropic path on Windows and Linux, streaming rendering in the interactive screen, and tool-call edge cases beyond one small task.

**F-23 · High (release process) · hosted CI unavailable.** GitHub refuses to start jobs (billing/spending limit). Impact: the candidate commit is not hosted-verified, and fixes made after
run `45537295390` (F-11, F-13, F-14 partly, the harness encoding fixes) are unverified on Windows. Action (owner): fix billing, re-dispatch `verify.yml` on the branch.

**F-24 · Low · flake.** `runtime health (ubuntu-latest)` failed once ("owned server closed stdout before advertising its endpoint") and passed on the next run with no related change. Cause unknown; not reproduced.

**F-26 · Low · limitation, found by the live run.** Observed (live, macOS arm64): the usage summary reported `668 input, 370 output` tokens and `cached: 43,391 read, 3,792 written`. The token limit (`BASHWINK_MAX_TOKENS`) counts input, output and reasoning tokens but **not cached tokens**, by design (cached reads are normally billed well below normal input). Consequence: a token limit under-states how much the provider processed, here by about 45x. The runtime's summary line states this; `KNOWN_LIMITATIONS.md` and the tester guide do not. Action: not changed, because documentation inside the package changes the candidate; proposed for the next candidate (`NEXT_STEPS.md`). Residual: a user who sets only a token limit and relies on it as a spending bound is misled by the guides, though not by the summary line.

**F-25 · Info · design limit (restated).** The shell tool checks only the obvious path arguments of a command; an approved command can read or write anything the user can. This is why the mode is called native and
permission-controlled, never sandboxed.

## Proven defects versus unverified risks

Proven (reproduced, fixed): F-8, F-9, F-10, F-11, F-12, F-13, F-14, F-15, F-16, F-17.
Proven limitations (measured, disclosed): F-18, F-19, F-20, F-21, F-25, F-26 (guides do not mention it yet).
Unverified risks: F-22 (Anthropic protocol on Windows and Linux; macOS is now live-verified), native-code CVEs in the pinned runtimes, Windows desktop rendering, Windows ARM64 and AVX2-less CPUs, the fixes after `6cb1e87` on Windows, the flake F-24.
